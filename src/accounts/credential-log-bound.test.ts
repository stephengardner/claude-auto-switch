import { describe, it, expect } from 'vitest';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
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

const size = (file: string): number => (existsSync(file) ? statSync(file).size : 0);

describe('the credential log stays bounded', () => {
  it('moves the long file aside whole at the next append, keeping what a reader reads', () => {
    const { c, file } = setup();
    // Well past the bound, as on a machine that ran an unbounded ccx for months.
    const old = longTrail(30_000);
    writeFileSync(file, old, 'utf8');
    expect(size(file)).toBeGreaterThan(ROTATE_BYTES * 2);
    const before = readCredentialEvents(100_000, c);

    logCredentialEvent({ account: 'now', kind: 'renewed', reason: 'idle-renewal', at: 99_999 }, c);

    // The live file starts again with the new line; the old one is the archive, untouched.
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(`${file}.1`, 'utf8')).toBe(old);

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

  it('holds each file to the bound and a line, over two thousand appends', () => {
    const { c, file } = setup();
    const line = 'x'.repeat(900);
    let most = 0;
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
      most = Math.max(most, size(file), size(`${file}.1`));
    }
    // Two thousand lines of about a kilobyte: 1.8 MB unbounded.
    expect(most).toBeLessThanOrEqual(ROTATE_BYTES + 1_100);
    expect(size(file) + size(`${file}.1`)).toBeLessThanOrEqual(2 * (ROTATE_BYTES + 1_100));
    // The newest is always the last one read, and a reader still has a full tail.
    expect(readCredentialEvents(1, c)[0]?.detail).toMatch(/^1999 /);
    expect(readCredentialEvents(10_000, c).length).toBeGreaterThan(MAX_BYTES / 1_100);
  });

  it('loses no line that a process had opened the file to write as it was moved', () => {
    const { c, file } = setup();
    writeFileSync(file, longTrail(20_000), 'utf8');
    // Another process opens the file to append, and is slow to write.
    const fd = openSync(file, 'a');
    rotateIfLong(c);
    writeSync(
      fd,
      `${JSON.stringify({ at: 50_000, account: 'slow', kind: 'renewed', reason: 'idle-renewal' })}\n`,
    );
    closeSync(fd);
    logCredentialEvent(
      { account: 'later', kind: 'renewed', reason: 'idle-renewal', at: 60_000 },
      c,
    );
    expect(readCredentialEvents(100_000, c).map((e) => e.account)).toEqual(
      expect.arrayContaining(['slow', 'later']),
    );
  });

  it('moves the file once: a rotation after it finds the live file short and leaves both alone', () => {
    const { c, file } = setup();
    writeFileSync(file, longTrail(20_000), 'utf8');
    rotateIfLong(c);
    const archived = readFileSync(`${file}.1`, 'utf8');
    logCredentialEvent({ account: 'next', kind: 'renewed', reason: 'idle-renewal' }, c);
    rotateIfLong(c);
    expect(readFileSync(`${file}.1`, 'utf8')).toBe(archived);
    expect(readCredentialEvents(1, c)[0]?.account).toBe('next');
  });
});
