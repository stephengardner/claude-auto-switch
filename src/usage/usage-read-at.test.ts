import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refreshUsage, readUsageSnapshot, writeUsageSnapshot } from './usage-store.js';

/**
 * `readAt` is when the numbers were last READ, which `at` cannot say: a read
 * that fails keeps the old numbers and moves `at` on, so an entry whose usage
 * endpoint has turned it away for days looks fresh by `at` alone.
 */
function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-usage-read-at-'));
  const c = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const dir = path.join(home, 'profiles', 'a');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'tok-a' } }),
    'utf8',
  );
  return { c, accounts: [{ name: 'a', dir }] };
}

const notNeeded = () => Promise.resolve({ status: 'not-needed' as const });

describe('when usage was last read', () => {
  it('is the time of a reading that worked, the same as its `at`', async () => {
    const { c, accounts } = setup();
    await refreshUsage(accounts, c, {
      now: () => 5_000_000,
      renew: notNeeded,
      probe: () =>
        Promise.resolve({
          verdict: 'allowed',
          fiveHour: 0.3,
          sevenDay: 0.4,
          fiveHourReset: 1,
          sevenDayReset: 2,
        }),
    });
    const entry = readUsageSnapshot(c).accounts['a'];
    expect(entry?.readAt).toBe(5_000_000);
    expect(entry?.at).toBe(5_000_000);
  });

  it('stays where it was when a later read fails, while `at` moves on', async () => {
    const { c, accounts } = setup();
    let clock = 5_000_000;
    const options = { now: () => clock, renew: notNeeded, maxAgeMs: 1, gapMs: 0 };
    await refreshUsage(accounts, c, {
      ...options,
      probe: () =>
        Promise.resolve({
          verdict: 'allowed',
          fiveHour: 0.3,
          sevenDay: 0.4,
          fiveHourReset: 1,
          sevenDayReset: 2,
        }),
    });
    clock = 9_000_000;
    await refreshUsage(accounts, c, {
      ...options,
      probe: () => Promise.resolve({ verdict: 'unknown' }),
    });
    const entry = readUsageSnapshot(c).accounts['a'];
    expect(entry?.at).toBe(9_000_000);
    expect(entry?.readAt).toBe(5_000_000);
    // The numbers it kept are the ones that read time belongs to.
    expect(entry?.fiveHour).toBe(0.3);
  });

  it('is not invented for an entry that was never read', async () => {
    const { c, accounts } = setup();
    await refreshUsage(accounts, c, {
      renew: notNeeded,
      probe: () => Promise.resolve({ verdict: 'unknown' }),
    });
    const entry = readUsageSnapshot(c).accounts['a'];
    expect(typeof entry?.at).toBe('number');
    expect(entry).not.toHaveProperty('readAt');
  });

  it('survives a rewrite of the file, like any field ccx knows', () => {
    const { c } = setup();
    writeUsageSnapshot(
      {
        accounts: {
          a: {
            fiveHour: 0.1,
            sevenDay: 0.2,
            fiveHourReset: null,
            sevenDayReset: null,
            at: 7,
            readAt: 3,
          },
        },
      },
      c,
    );
    expect(readUsageSnapshot(c).accounts['a']?.readAt).toBe(3);
  });
});
