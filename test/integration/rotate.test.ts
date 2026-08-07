import { describe, it, expect } from 'vitest';
import { autoRotateHeadless } from '../../src/launcher/rotating-run.js';
import type { RunOptions } from '../../src/util/exec.js';

function acct(name: string, priority: number) {
  return { name, priority, enabled: true, dir: `/dir/${name}` };
}

const base = {
  claude: { bin: 'node' },
  accounts: [acct('A', 0), acct('B', 1)],
  loggedIn: new Set(['A', 'B']),
  now: () => 1000,
  defaultBackoffMinutes: 300,
  out: () => {},
  // These tests are about ROTATION, so the account's usage is taken as agreeing
  // with the text. What happens when it does NOT agree is the subject of its
  // own test below, because that is the case that used to cap healthy accounts.
  confirmCap: () => Promise.resolve({ limited: true }),
};

describe('autoRotateHeadless', () => {
  it('rotates past a capped account to a healthy one', async () => {
    const calls: string[] = [];
    const run = async (_bin: string, _args: string[], opts?: RunOptions) => {
      const dir = opts?.env?.CLAUDE_CONFIG_DIR ?? '';
      calls.push(dir);
      if (dir === '/dir/A') return { stdout: '', stderr: 'Usage limit reached.', exitCode: 1 };
      return { stdout: 'hello from B', stderr: '', exitCode: 0 };
    };

    const result = await autoRotateHeadless(['-p', 'hi'], { ...base, ledger: { caps: [] }, run });
    expect(result.exitCode).toBe(0);
    expect(result.account).toBe('B');
    expect(result.rotations).toBe(1);
    expect(result.ledger.caps.map((c) => c.account)).toContain('A');
    expect(calls).toEqual(['/dir/A', '/dir/B']);
  });

  it('caps every account and reports exhaustion when all are capped', async () => {
    let message = '';
    const run = async () => ({ stdout: '', stderr: 'rate limit', exitCode: 1 });
    const result = await autoRotateHeadless(['-p', 'hi'], {
      ...base,
      out: (m) => {
        message += m;
      },
      ledger: { caps: [] },
      run,
    });
    expect(result.exitCode).toBe(1);
    expect(result.ledger.caps).toHaveLength(2);
    expect(message).toContain('capped');
  });

  it('does not rotate when the first account succeeds', async () => {
    const run = async () => ({ stdout: 'ok', stderr: '', exitCode: 0 });
    const result = await autoRotateHeadless(['-p', 'hi'], { ...base, ledger: { caps: [] }, run });
    expect(result.account).toBe('A');
    expect(result.rotations).toBe(0);
  });

  it('does NOT cap an account when its usage refutes the limit text', async () => {
    // A resumed conversation replays old limit messages, and code on screen can
    // talk about rate limits. Capping from the text alone took healthy accounts
    // out for hours: five of them inside 87 seconds on a real machine.
    const run = async () => ({ stdout: 'talking about rate limits', stderr: 'rate limit', exitCode: 1 });
    const result = await autoRotateHeadless(['-p', 'hi'], {
      ...base,
      ledger: { caps: [] },
      run,
      confirmCap: () => Promise.resolve({ limited: false, detail: 'five-hour window at 3%' }),
    });

    expect(result.ledger.caps).toEqual([]); // nothing was taken out of rotation
    expect(result.rotations).toBe(0);
    expect(result.account).toBe('A'); // it stayed on the account it started with
  });

  it('records a model-scoped limit WITH its model, so the account keeps working', async () => {
    // The difference between "switch to Opus and carry on" and "every account
    // has hit its limit, come back in five hours".
    const run = async () => ({ stdout: "you've reached your Fable 5 limit", stderr: '', exitCode: 1 });
    const result = await autoRotateHeadless(['-p', 'hi'], {
      ...base,
      accounts: [acct('A', 0)],
      loggedIn: new Set(['A']),
      ledger: { caps: [] },
      run,
      confirmCap: () => Promise.resolve({ limited: true, model: 'Fable', resetAt: 5555 }),
    });

    expect(result.ledger.caps).toHaveLength(1);
    expect(result.ledger.caps[0]!.model).toBe('Fable');
    expect(result.ledger.caps[0]!.capUntil).toBe(5555);
  });
});