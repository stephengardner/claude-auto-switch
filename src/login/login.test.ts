import { describe, it, expect } from 'vitest';
import { loginAccount, type LoginDeps, type AuthorizeOutcome } from './login.js';

/**
 * A sign-in is judged by what ends up stored, not by how the browser step went,
 * so these scenarios say what the account held BEFORE and what it holds AFTER.
 */
function deps(scenario: {
  url?: string;
  outcome: AuthorizeOutcome;
  exitCode: number;
  before?: string | null;
  after?: string | null;
  notices?: string[];
  /** Never resolves, to stand in for a sign-in nobody finishes. */
  neverFinishes?: boolean;
  timeoutMs?: number;
  cancelled?: { yes: boolean };
}): LoginDeps {
  let asked = 0;
  return {
    claude: { bin: 'claude' },
    debugPort: 9222,
    startAuthLogin: () => ({
      urlHint: () => Promise.resolve(scenario.url),
      done: () =>
        scenario.neverFinishes ? new Promise<number>(() => {}) : Promise.resolve(scenario.exitCode),
      cancel: () => {
        if (scenario.cancelled) scenario.cancelled.yes = true;
      },
    }),
    browser: {
      authorize: () => Promise.resolve(scenario.outcome),
    },
    fingerprint: () => {
      asked += 1;
      return asked === 1 ? (scenario.before ?? null) : (scenario.after ?? null);
    },
    ...(scenario.notices ? { notify: (m: string) => scenario.notices!.push(m) } : {}),
    ...(scenario.timeoutMs !== undefined ? { timeoutMs: scenario.timeoutMs } : {}),
  };
}

const account = { name: 'a', dir: '/dir/a', email: 'a@b.com' };

describe('loginAccount', () => {
  it('succeeds when the browser authorizes and a new login is stored', async () => {
    const r = await loginAccount(
      account,
      deps({ url: 'https://claude.ai/oauth?x=1', outcome: 'authorized', exitCode: 0, after: 'new' }),
    );
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('authorized');
  });

  it('succeeds (left-open) when the button is not found but a login is still stored', async () => {
    const r = await loginAccount(account, deps({ outcome: 'left-open', exitCode: 0, after: 'new' }));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('left-open');
  });

  it('SUCCEEDS when the browser step fails but the person finishes it by hand', async () => {
    // The reported bug. ccx used to return failure the moment it could not drive
    // the browser, without waiting, so a sign-in completed by hand was reported
    // as "did not finish" while the account was in fact signed in and working.
    const notices: string[] = [];
    const r = await loginAccount(
      account,
      deps({ outcome: 'failed', exitCode: 0, before: 'old', after: 'new', notices }),
    );
    expect(r.ok).toBe(true);
    // And it told the person what to do rather than going quiet.
    expect(notices.join(' ')).toContain('finish the sign-in');
  });

  it('still succeeds if the process exits non-zero but a new login was stored', async () => {
    // What matters is the account being usable, not how the helper exited.
    const r = await loginAccount(
      account,
      deps({ outcome: 'failed', exitCode: 1, before: null, after: 'new' }),
    );
    expect(r.ok).toBe(true);
  });

  it('fails when nothing was stored, and says so plainly', async () => {
    const r = await loginAccount(
      account,
      deps({ outcome: 'failed', exitCode: 1, before: null, after: null }),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('not completed');
  });

  it('fails when the login left the previous credential untouched and exited badly', async () => {
    const r = await loginAccount(
      account,
      deps({ url: 'https://x', outcome: 'authorized', exitCode: 3, before: 'old', after: 'old' }),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('exited 3');
  });

  it('does not describe a success as failed', async () => {
    // The path this whole change is about: the browser step failed, the person
    // finished by hand. "ok: logged in (failed)" reads as a contradiction.
    const r = await loginAccount(
      account,
      deps({ outcome: 'failed', exitCode: 0, before: 'old', after: 'new' }),
    );
    expect(r.ok).toBe(true);
    expect(r.detail).not.toContain('failed');
    expect(r.detail).toContain('manually');
  });

  it('GIVES UP on a sign-in nobody finishes, and stops the process', async () => {
    // Without a bound this waited forever, which matters most from the dashboard:
    // it hands its screen away while the sign-in runs.
    const cancelled = { yes: false };
    const r = await loginAccount(
      account,
      deps({ outcome: 'failed', exitCode: 0, neverFinishes: true, timeoutMs: 40, cancelled }),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('gave up waiting');
    expect(cancelled.yes).toBe(true); // and it did not leave the process running
  });

  it('still counts a sign-in finished just before the wait ran out', async () => {
    const r = await loginAccount(
      account,
      deps({
        outcome: 'failed',
        exitCode: 0,
        neverFinishes: true,
        timeoutMs: 40,
        before: null,
        after: 'new',
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('reports an unchanged but working login as fine, not as a failure', async () => {
    const r = await loginAccount(
      account,
      deps({ outcome: 'authorized', exitCode: 0, before: 'same', after: 'same' }),
    );
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('already signed in');
  });
});
