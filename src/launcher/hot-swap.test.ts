import { describe, it, expect } from 'vitest';
import {
  runHotSwapSession,
  type HotSwapDeps,
  type SessionOutcome,
} from './hot-swap.js';

function pool(names: string[]) {
  return names.map((n) => ({ name: n, dir: `/d/${n}` }));
}

describe('runHotSwapSession', () => {
  it('swaps to the next account on cap and resumes with --continue', async () => {
    const accounts = pool(['a', 'b']);
    const calls: Array<{ account: string; isContinue: boolean }> = [];
    const marked: string[] = [];
    const deps: HotSwapDeps = {
      nextAccount: (ex) => accounts.find((a) => !ex.has(a.name)) ?? null,
      resolveAccount: (name) => accounts.find((a) => a.name === name) ?? null,
      runSession: (account, isContinue) => {
        calls.push({ account: account.name, isContinue });
        const outcome: SessionOutcome =
          account.name === 'a'
            ? { kind: 'capped', exitCode: 1, reason: 'Usage limit reached' }
            : { kind: 'ok', exitCode: 0 };
        return Promise.resolve(outcome);
      },
      markCapped: (a) => marked.push(a),
      notify: () => {},
    };

    expect(await runHotSwapSession(deps)).toBe(0);
    expect(calls).toEqual([
      { account: 'a', isContinue: false },
      { account: 'b', isContinue: true },
    ]);
    expect(marked).toEqual(['a']);
  });

  it('returns 1 and reports when every account is capped', async () => {
    const accounts = pool(['a', 'b']);
    const notes: string[] = [];
    const deps: HotSwapDeps = {
      nextAccount: (ex) => accounts.find((a) => !ex.has(a.name)) ?? null,
      resolveAccount: (name) => accounts.find((a) => a.name === name) ?? null,
      runSession: () => Promise.resolve({ kind: 'capped', exitCode: 1 } as SessionOutcome),
      markCapped: () => {},
      notify: (m) => notes.push(m),
    };
    expect(await runHotSwapSession(deps)).toBe(1);
    expect(notes.join(' ')).toContain('every account has hit its limit');
  });

  it('starts anyway when the limits are about ONE MODEL, rather than refusing', async () => {
    // Refusing here is what made an exhausted Fable window look like being
    // signed out, even though the session works fine on another model.
    const accounts = pool(['a']);
    const runs: Array<{ account: string; ignoreLimits?: boolean }> = [];
    const notes: string[] = [];
    const deps: HotSwapDeps = {
      nextAccount: (ex) => accounts.find((a) => !ex.has(a.name)) ?? null,
      resolveAccount: (name) => accounts.find((a) => a.name === name) ?? null,
      runSession: (account, _isContinue, options) => {
        runs.push({ account: account.name, ...(options?.ignoreLimits ? { ignoreLimits: true } : {}) });
        // The first run hits the model limit; the fallback run must not be
        // watched for limits, or it would be ended by the same one.
        return Promise.resolve(
          options?.ignoreLimits
            ? ({ kind: 'ok', exitCode: 0 } as SessionOutcome)
            : ({ kind: 'capped', exitCode: 1, reason: 'Fable limit' } as SessionOutcome),
        );
      },
      markCapped: () => {},
      notify: (m) => notes.push(m),
      lastResort: () => ({ account: accounts[0]!, message: 'every account is out of Fable' }),
    };

    expect(await runHotSwapSession(deps)).toBe(0); // started, did not refuse
    expect(runs).toEqual([{ account: 'a' }, { account: 'a', ignoreLimits: true }]);
    expect(notes.join(' ')).toContain('out of Fable');
  });

  it('uses the fallback only once, then reports honestly', async () => {
    const accounts = pool(['a']);
    let fallbacks = 0;
    const deps: HotSwapDeps = {
      nextAccount: (ex) => accounts.find((a) => !ex.has(a.name)) ?? null,
      resolveAccount: () => null,
      runSession: () => Promise.resolve({ kind: 'capped', exitCode: 1 } as SessionOutcome),
      markCapped: () => {},
      notify: () => {},
      lastResort: () => {
        fallbacks += 1;
        return { account: accounts[0]!, message: 'model limit' };
      },
    };
    // The fallback run also reports capped; without the once-only guard this
    // would loop forever.
    expect(await runHotSwapSession(deps)).toBe(1);
    expect(fallbacks).toBe(1);
  });

  it('exits normally without swapping when the first account does not cap', async () => {
    const accounts = pool(['a', 'b']);
    let count = 0;
    const deps: HotSwapDeps = {
      nextAccount: (ex) => accounts.find((a) => !ex.has(a.name)) ?? null,
      resolveAccount: (name) => accounts.find((a) => a.name === name) ?? null,
      runSession: () => {
        count += 1;
        return Promise.resolve({ kind: 'ok', exitCode: 0 } as SessionOutcome);
      },
      markCapped: () => {},
      notify: () => {},
    };
    expect(await runHotSwapSession(deps)).toBe(0);
    expect(count).toBe(1);
  });

  it('switches to the operator-requested account in place, resuming with --continue', async () => {
    const accounts = pool(['a', 'b', 'c']);
    const calls: Array<{ account: string; isContinue: boolean }> = [];
    let step = 0;
    const deps: HotSwapDeps = {
      nextAccount: (ex) => accounts.find((a) => !ex.has(a.name)) ?? null,
      resolveAccount: (name) => accounts.find((a) => a.name === name) ?? null,
      runSession: (account, isContinue) => {
        calls.push({ account: account.name, isContinue });
        step += 1;
        // The session on 'a' gets a switch request to 'c'; then 'c' exits normally.
        const outcome: SessionOutcome =
          step === 1 ? { kind: 'switch', exitCode: 0, switchTo: 'c' } : { kind: 'ok', exitCode: 0 };
        return Promise.resolve(outcome);
      },
      markCapped: () => {},
      notify: () => {},
    };

    expect(await runHotSwapSession(deps)).toBe(0);
    expect(calls).toEqual([
      { account: 'a', isContinue: false },
      { account: 'c', isContinue: true },
    ]);
  });

  it('falls back to the current account when the requested one cannot be resolved', async () => {
    const accounts = pool(['a', 'b']);
    const calls: Array<{ account: string; isContinue: boolean }> = [];
    let step = 0;
    const deps: HotSwapDeps = {
      nextAccount: (ex) => accounts.find((a) => !ex.has(a.name)) ?? null,
      resolveAccount: () => null, // the requested account is not usable
      runSession: (account, isContinue) => {
        calls.push({ account: account.name, isContinue });
        step += 1;
        return Promise.resolve(
          step === 1
            ? ({ kind: 'switch', exitCode: 0, switchTo: 'ghost' } as SessionOutcome)
            : ({ kind: 'ok', exitCode: 0 } as SessionOutcome),
        );
      },
      markCapped: () => {},
      notify: () => {},
    };

    expect(await runHotSwapSession(deps)).toBe(0);
    // Ended 'a' for the switch, but 'ghost' didn't resolve, so we resumed 'a' with --continue.
    expect(calls).toEqual([
      { account: 'a', isContinue: false },
      { account: 'a', isContinue: true },
    ]);
  });

  it('ROTATES PAST an account whose login is dead, instead of blocking on it', async () => {
    // The reported failure. The first account's stored login could not be renewed
    // and the server rejects it, so starting there hands Claude a dead token and
    // shows "Login expired" with nothing to act on. Rotating past a broken
    // account is the whole point of the tool.
    const accounts = pool(['dead', 'good']);
    const calls: string[] = [];
    const marked: string[] = [];
    const deps: HotSwapDeps = {
      nextAccount: (ex) => accounts.find((a) => !ex.has(a.name)) ?? null,
      resolveAccount: (name) => accounts.find((a) => a.name === name) ?? null,
      runSession: (account) => {
        calls.push(account.name);
        return Promise.resolve(
          account.name === 'dead'
            ? ({ kind: 'needs-login', exitCode: 1 } as SessionOutcome)
            : ({ kind: 'ok', exitCode: 0 } as SessionOutcome),
        );
      },
      markCapped: (a) => marked.push(a),
      notify: () => {},
    };

    expect(await runHotSwapSession(deps)).toBe(0);
    expect(calls).toEqual(['dead', 'good']);
    // NOT recorded as capped: nothing is exhausted, and a cap would keep the
    // account out of rotation for hours over a problem a sign-in fixes.
    expect(marked).toEqual([]);
  });

  it('starts fresh on the next account, since the dead one never ran', async () => {
    // --continue on the second account would try to resume a conversation that
    // was never started, because the first account never got as far as running.
    const accounts = pool(['dead', 'good']);
    const continued: boolean[] = [];
    const deps: HotSwapDeps = {
      nextAccount: (ex) => accounts.find((a) => !ex.has(a.name)) ?? null,
      resolveAccount: (name) => accounts.find((a) => a.name === name) ?? null,
      runSession: (account, isContinue) => {
        continued.push(isContinue);
        return Promise.resolve(
          account.name === 'dead'
            ? ({ kind: 'needs-login', exitCode: 1 } as SessionOutcome)
            : ({ kind: 'ok', exitCode: 0 } as SessionOutcome),
        );
      },
      markCapped: () => {},
      notify: () => {},
    };

    await runHotSwapSession(deps);
    expect(continued).toEqual([false, false]);
  });

  it('says to sign in, not to wait, when every login is finished', async () => {
    // "try again after a reset" would send someone away to wait for something
    // that never happens on its own.
    const accounts = pool(['one', 'two']);
    const said: string[] = [];
    const deps: HotSwapDeps = {
      nextAccount: (ex) => accounts.find((a) => !ex.has(a.name)) ?? null,
      resolveAccount: (name) => accounts.find((a) => a.name === name) ?? null,
      runSession: () => Promise.resolve({ kind: 'needs-login', exitCode: 1 } as SessionOutcome),
      markCapped: () => {},
      notify: (m) => said.push(m),
    };

    expect(await runHotSwapSession(deps)).toBe(1);
    const all = said.join(' | ');
    expect(all).toContain('need signing in again');
    expect(all).toContain('ccx login');
    expect(all).not.toContain('after a reset');
  });

  it('handles a dead login on the LAST-RESORT account too', async () => {
    // The last resort is picked for having room, which says nothing about
    // whether its login still works. Returning its exit code straight out would
    // hand back the dead session's status and explain nothing.
    const accounts = pool(['a']);
    const said: string[] = [];
    const deps: HotSwapDeps = {
      nextAccount: (ex) => accounts.find((x) => !ex.has(x.name)) ?? null,
      resolveAccount: (name) => accounts.find((x) => x.name === name) ?? null,
      lastResort: () => ({ account: { name: 'fallback', dir: '/d/f' }, message: 'model window only' }),
      runSession: (account) =>
        Promise.resolve(
          account.name === 'a'
            ? ({ kind: 'capped', exitCode: 1, reason: 'usage cap' } as SessionOutcome)
            : ({ kind: 'needs-login', exitCode: 1 } as SessionOutcome),
        ),
      markCapped: () => {},
      notify: (m) => said.push(m),
    };

    expect(await runHotSwapSession(deps)).toBe(1);
    const all = said.join(' | ');
    expect(all).toContain('"fallback" needs signing in again');
  });
});
