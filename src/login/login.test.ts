import { describe, it, expect } from 'vitest';
import { loginAccount, type LoginDeps, type AuthorizeOutcome } from './login.js';

function deps(scenario: {
  url?: string;
  outcome: AuthorizeOutcome;
  exitCode: number;
}): LoginDeps {
  return {
    claude: { bin: 'claude' },
    debugPort: 9222,
    startAuthLogin: () => ({
      urlHint: () => Promise.resolve(scenario.url),
      done: () => Promise.resolve(scenario.exitCode),
    }),
    browser: {
      authorize: () => Promise.resolve(scenario.outcome),
    },
  };
}

const account = { name: 'a', dir: '/dir/a', email: 'a@b.com' };

describe('loginAccount', () => {
  it('succeeds when the browser authorizes and the process exits 0', async () => {
    const r = await loginAccount(
      account,
      deps({ url: 'https://claude.ai/oauth?x=1', outcome: 'authorized', exitCode: 0 }),
    );
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('authorized');
  });

  it('succeeds (left-open) when the button is not found but login still completes', async () => {
    const r = await loginAccount(account, deps({ outcome: 'left-open', exitCode: 0 }));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('left-open');
  });

  it('fails and guides the user when the browser step fails', async () => {
    const r = await loginAccount(account, deps({ outcome: 'failed', exitCode: 1 }));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('manually');
  });

  it('fails when the login process exits non-zero', async () => {
    const r = await loginAccount(account, deps({ url: 'https://x', outcome: 'authorized', exitCode: 3 }));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('exited 3');
  });
});
