import { describe, it, expect } from 'vitest';
import { ACCOUNT_ENV, HOST_ONLY_ENV, scrubHostEnv, withoutEnv } from './child-env.js';
import { cleanEnv } from './pty-session.js';

/**
 * Claude reads a login variable before the credential in its session folder,
 * so one inherited from wherever ccx was started (an orchestrating Claude, a
 * shell profile) would put a session on an account ccx does not know it is on.
 */
describe('the environment a Claude that ccx starts is given', () => {
  it('drops the login variables from a terminal session, and keeps the rest of the operator environment', () => {
    const env = cleanEnv(
      { CLAUDE_CONFIG_DIR: '/session' },
      {
        PATH: '/bin',
        CLAUDE_CODE_OAUTH_TOKEN: 'someone-elses',
        CLAUDE_CODE_ACCOUNT_UUID: 'theirs',
        CLAUDE_EFFORT: 'high',
        CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      },
    );
    expect(env).toEqual({
      PATH: '/bin',
      CLAUDE_EFFORT: 'high',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      CLAUDE_CONFIG_DIR: '/session',
    });
  });

  it("still passes the token ccx itself chose for the session's account", () => {
    const env = cleanEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'the-accounts-own' }, { CLAUDE_CODE_OAUTH_TOKEN: 'inherited' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('the-accounts-own');
  });

  it('matches names whatever their case, as Windows does', () => {
    expect(withoutEnv({ claude_code_oauth_token: 'x', Path: 'p' }, ACCOUNT_ENV)).toEqual({ Path: 'p' });
  });

  it('gives a new top-level session none of a host Claude, the account it chose included', () => {
    const env = scrubHostEnv({
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_CODE_OAUTH_TOKEN: 'the-orchestrators',
    });
    expect(env).toEqual({ PATH: '/bin' });
    for (const name of ACCOUNT_ENV) expect(HOST_ONLY_ENV).toContain(name);
  });
});
