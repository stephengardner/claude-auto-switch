import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAX_BYTES,
  ROTATE_BYTES,
  logCredentialEvent,
  readCredentialEvents,
  rotateIfLong,
} from './credential-log.js';

function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-credbound-'));
  const c = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const file = path.join(home, 'credential-log.jsonl');
  return { c, file };
}

/** A trail as an unbounded ccx left it: `count` records, one account each, oldest first. */
function longTrail(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(
      JSON.stringify({ at: i, account: `acct-${i}`, kind: 'renewed', reason: 'idle-renewal' }),
    );
  }
  return `${lines.join('\n')}\n`;
}

describe('the credential log stays bounded', () => {
  it('sets the long file aside at the next append, keeping what a reader reads', () => {
    const { c, file } = setup();
    // Well past the bound, as on a machine that ran an unbounded ccx for months.
    writeFileSync(file, longTrail(30_000), 'utf8');
    expect(statSync(file).size).toBeGreaterThan(ROTATE_BYTES * 2);
    const before = readCredentialEvents(100_000, c);

    logCredentialEvent({ account: 'now', kind: 'renewed', reason: 'idle-renewal', at: 99_999 }, c);

    // The live file starts again with the new line; the archive is the old tail.
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
    const archive = readFileSync(`${file}.1`, 'utf8');
    expect(archive.length).toBeLessThanOrEqual(MAX_BYTES);
    // It starts at a whole line, so nothing in it is a fragment.
    expect(() => JSON.parse(archive.split('\n', 1)[0] ?? '')).not.toThrow();
    expect(existsSync(`${file}.rotating`)).toBe(false);

    // What a reader reads is unchanged, apart from the new event at the end.
    const after = readCredentialEvents(100_000, c);
    expect(after.at(-1)?.account).toBe('now');
    const kept = after.slice(0, -1).map((e) => e.account);
    expect(kept.length).toBeGreaterThan(1000);
    expect(before.map((e) => e.account).slice(-kept.length)).toEqual(kept);
  });

  it('touches nothing while the file is under the bound', () => {
    const { c, file } = setup();
    logCredentialEvent({ account: 'a', kind: 'renewed', reason: 'idle-renewal' }, c);
    rotateIfLong(c);
    expect(existsSync(`${file}.1`)).toBe(false);
    expect(readCredentialEvents(10, c).map((e) => e.account)).toEqual(['a']);
  });

  it('holds the trail on disk under three times what a reader reads, however long it runs', () => {
    const { c, file } = setup();
    const line = 'x'.repeat(900);
    for (let i = 0; i < 2_000; i += 1) {
      logCredentialEvent(
        {
          account: 'a',
          kind: 'renew-failed',
          reason: 'renewal-unavailable',
          detail: `${i} ${line}`,
        },
        c,
      );
    }
    const total = statSync(file).size + (existsSync(`${file}.1`) ? statSync(`${file}.1`).size : 0);
    // Two thousand lines of about a kilobyte: 1.8 MB unbounded.
    expect(total).toBeLessThan(3 * MAX_BYTES);
    // The newest is always the last one read.
    expect(readCredentialEvents(1, c)[0]?.detail).toMatch(/^1999 /);
  });

  it('loses nothing to a rotation stopped part way, and the next one finishes it', () => {
    const { c, file } = setup();
    // Stopped after the live file was moved aside, before the archive was written.
    writeFileSync(`${file}.rotating`, longTrail(20_000), 'utf8');
    logCredentialEvent(
      { account: 'later', kind: 'renewed', reason: 'idle-renewal', at: 50_000 },
      c,
    );
    // Read meanwhile: the parked records are still there, before the live one.
    const read = readCredentialEvents(100_000, c).map((e) => e.account);
    expect(read.at(-1)).toBe('later');
    expect(read.at(-2)).toBe('acct-19999');

    // The next rotation archives what was parked.
    writeFileSync(file, longTrail(20_000), 'utf8');
    rotateIfLong(c);
    expect(existsSync(`${file}.rotating`)).toBe(false);
    expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(MAX_BYTES);
  });
});
