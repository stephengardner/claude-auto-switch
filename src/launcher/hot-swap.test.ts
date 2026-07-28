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
    expect(notes.join(' ')).toContain('every account is capped');
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
});
