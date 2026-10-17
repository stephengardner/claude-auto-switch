import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireOwnedLock } from '../claude/locks.js';
import { readEvents } from '../events/log.js';
import {
  applyLedgerChange,
  clearDisproved,
  ledgerFilePath,
  loadLedger,
  markCapped,
  updateLedger,
} from './ledger.js';
import type { Ledger } from './ledger.schema.js';

const HOUR = 3_600_000;

function home(): { home: string; c: { env: NodeJS.ProcessEnv } } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-ledger-update-'));
  return { home: dir, c: { env: { CLAUDE_AUTO_SWITCH_HOME: dir } } };
}

const capFor = (account: string, now = Date.now()) => (ledger: Ledger) =>
  markCapped(ledger, { account, now, resetAt: now + HOUR, reason: 'test' });

const accounts = (ledger: Ledger): string[] => ledger.caps.map((cap) => cap.account).sort();
const unlockedWrites = (dir: string) => readEvents(dir, 100).filter((e) => e.kind === 'ledger-unlocked');

describe('updateLedger', () => {
  it('applies the change to the ledger as it is on disk, and lets go of the lock', () => {
    const { home: dir, c } = home();
    updateLedger(c, capFor('A'));
    const written = updateLedger(c, capFor('B'));
    expect(accounts(written)).toEqual(['A', 'B']);
    expect(accounts(loadLedger(c))).toEqual(['A', 'B']);
    expect(existsSync(`${ledgerFilePath(c)}.lock`)).toBe(false);
    expect(unlockedWrites(dir)).toEqual([]);
  });

  it('writes nothing when the change hands back the ledger it was given', () => {
    const { c } = home();
    expect(updateLedger(c, (ledger) => ledger)).toEqual({ caps: [] });
    expect(existsSync(ledgerFilePath(c))).toBe(false);
  });

  it('lets go of the lock when the change throws, and leaves the ledger as it was', () => {
    const { home: dir, c } = home();
    updateLedger(c, capFor('A'));
    expect(() =>
      updateLedger(c, () => {
        throw new Error('the change failed');
      }),
    ).toThrow('the change failed');
    expect(existsSync(`${ledgerFilePath(c)}.lock`)).toBe(false);
    expect(accounts(loadLedger(c))).toEqual(['A']);
    // The next change gets the lock rather than waiting it out.
    updateLedger(c, capFor('B'), { waitMs: 60_000 });
    expect(accounts(loadLedger(c))).toEqual(['A', 'B']);
    expect(unlockedWrites(dir)).toEqual([]);
  });

  it('still makes the change when the lock is not free in time, and says so in the event log', () => {
    const { home: dir, c } = home();
    const lockFile = `${ledgerFilePath(c)}.lock`;
    // Held as a running holder holds it, one that will not let go in time.
    const holder = acquireOwnedLock(lockFile, { waitMs: 0, staleMs: 5_000 });
    expect(holder.held).toBe(true);
    try {
      const written = updateLedger(c, capFor('A'), { waitMs: 200 });
      expect(accounts(written)).toEqual(['A']);
      expect(accounts(loadLedger(c))).toEqual(['A']);
      expect(unlockedWrites(dir).map((e) => e.msg)).toEqual([
        'ledger written without its lock: the lock was not free within 0.2 s; ' +
          'a change another session made at that moment may be lost',
      ]);
      // And the holder's lock is still the holder's.
      expect(existsSync(lockFile)).toBe(true);
    } finally {
      holder.release();
    }
  });

  it('refuses a change that changes the ledger itself, and leaves the ledger and the lock as they were', () => {
    // Left to run, the inner change would wait out its own lock, write past it,
    // and then be overwritten by the outer one.
    const { home: dir, c } = home();
    updateLedger(c, capFor('A'));
    const started = Date.now();
    expect(() =>
      updateLedger(c, (ledger) => {
        updateLedger(c, capFor('B'));
        return capFor('C')(ledger);
      }),
    ).toThrow('updateLedger was called from inside a change to the ledger');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(accounts(loadLedger(c))).toEqual(['A']);
    expect(existsSync(`${ledgerFilePath(c)}.lock`)).toBe(false);
    // And the next change is not refused.
    updateLedger(c, capFor('D'));
    expect(accounts(loadLedger(c))).toEqual(['A', 'D']);
    expect(unlockedWrites(dir)).toEqual([]);
  });

  it('waits for a running holder held up for seconds, and keeps its change and this one', async () => {
    // A holder that reads the ledger, is held up for 6.5 s as a stalled
    // machine holds one up, then writes back what it read with its own change.
    // A change that wrote past it would be erased by that write.
    const { home: dir, c } = home();
    const file = ledgerFilePath(c);
    const holder = spawn(
      process.execPath,
      [
        '-e',
        [
          `const fs = require('node:fs');`,
          `const [file, holdMs] = process.argv.slice(1);`,
          `fs.writeFileSync(file + '.lock', String(process.pid), { flag: 'wx' });`,
          `const ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { caps: [] };`,
          `fs.writeFileSync(file + '.held', '');`,
          `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));`,
          `ledger.caps.push({ account: 'B', capUntil: Date.now() + 3600000, reason: 'another session', at: Date.now() });`,
          `fs.writeFileSync(file + '.tmp', JSON.stringify(ledger));`,
          `fs.renameSync(file + '.tmp', file);`,
          // Forced: if its lock was taken over, the ledger check below says so.
          `fs.rmSync(file + '.lock', { force: true });`,
        ].join('\n'),
        file,
        '6500',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    holder.stderr.on('data', (d) => (stderr += String(d)));
    const exited = new Promise<number | null>((resolve) => holder.on('exit', resolve));
    await vi.waitUntil(() => existsSync(`${file}.held`) || holder.exitCode !== null, {
      timeout: 20_000,
      interval: 10,
    });
    expect(existsSync(`${file}.held`), stderr).toBe(true);

    updateLedger(c, capFor('A'));
    expect(await exited, stderr).toBe(0);
    // Built on the holder's write, which only a change made after it can be.
    expect(accounts(loadLedger(c))).toEqual(['A', 'B']);
    expect(unlockedWrites(dir)).toEqual([]);
  }, 30_000);

  it('takes over at once a lock left by a process that has exited', () => {
    const { home: dir, c } = home();
    const exited = spawnSync(process.execPath, ['-e', '']);
    expect(exited.status).toBe(0);
    writeFileSync(`${ledgerFilePath(c)}.lock`, String(exited.pid), 'utf8');

    // Waiting it out instead would take the whole 12 s, inside the test's time.
    const started = Date.now();
    updateLedger(c, capFor('A'), { waitMs: 12_000 });
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(accounts(loadLedger(c))).toEqual(['A']);
    expect(unlockedWrites(dir)).toEqual([]);
    expect(existsSync(`${ledgerFilePath(c)}.lock`)).toBe(false);
  });
});

describe('a change a run made, applied to the ledger as it stands', () => {
  const run = 10_000;
  const cap = (reason: string, at: number, model?: string) => ({
    account: 'A',
    capUntil: run + HOUR,
    reason,
    at,
    ...(model ? { model } : {}),
  });
  const reasonsLeft = (ledger: Ledger): string[] => ledger.caps.map((c) => `${c.account}: ${c.reason}`);

  it('records a cap exactly as markCapped does', () => {
    const input = { account: 'A', now: run, resetAt: run + HOUR, reason: 'usage cap', model: 'Fable' };
    expect(applyLedgerChange({ caps: [] }, { kind: 'capped', cap: input })).toEqual(markCapped({ caps: [] }, input));
  });

  it('clears, after a run that finished fine, only what it disproves: account-wide limits and its own model', () => {
    const ledger: Ledger = {
      caps: [
        cap('account-wide, before', run - 1),
        cap('Opus, before', run - 1, 'Opus'),
        cap('Fable, before', run - 1, 'Fable'),
        cap('account-wide, while it ran', run + 1),
        cap('Opus, while it ran', run + 1, 'Opus'),
        { account: 'B', capUntil: run + HOUR, reason: 'another account', at: run - 1 },
      ],
    };
    const ran = applyLedgerChange(ledger, { kind: 'ran', account: 'A', model: 'opus', startedAt: run });
    expect(reasonsLeft(ran)).toEqual([
      'A: Fable, before',
      'A: account-wide, while it ran',
      'A: Opus, while it ran',
      'B: another account',
    ]);
  });

  it('keeps every model limit when the model the run used is not known', () => {
    const ledger: Ledger = { caps: [cap('account-wide, before', run - 1), cap('Fable, before', run - 1, 'Fable')] };
    const ran = applyLedgerChange(ledger, { kind: 'ran', account: 'A', model: null, startedAt: run });
    expect(reasonsLeft(ran)).toEqual(['A: Fable, before']);
  });

  it('keeps a limit recorded in the very millisecond the run started', () => {
    // Both times are Date.now() milliseconds, so another session's limit can
    // tie the start. Kept, the account rests a little longer; cleared, sessions
    // are sent to an account that is out.
    const ledger: Ledger = { caps: [cap('account-wide, at the start', run), cap('Opus, at the start', run, 'Opus')] };
    const ran = applyLedgerChange(ledger, { kind: 'ran', account: 'A', model: 'Opus', startedAt: run });
    expect(ran).toBe(ledger);
  });

  it('hands back the same ledger when there is nothing to clear, so nothing is written', () => {
    const ledger: Ledger = { caps: [{ account: 'B', capUntil: null, reason: 'x', at: 1 }] };
    expect(clearDisproved(ledger, { account: 'A', model: null, startedAt: run })).toBe(ledger);
    expect(clearDisproved(ledger, { account: 'B', model: null, startedAt: 1 })).toBe(ledger);
  });
});
