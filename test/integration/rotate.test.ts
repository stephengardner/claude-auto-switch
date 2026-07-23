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
});
