import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loginIsKnownDead,
  deadLoginReason,
  rememberDeadLogin,
  forgetDeadLogin,
} from './dead-login-store.js';

function home(): { ctx: { env: Record<string, string> }; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-dead-'));
  return { ctx: { env: { CLAUDE_AUTO_SWITCH_HOME: dir } }, dir };
}

describe('remembering a login the endpoint has finished with', () => {
  it('knows nothing before anything is recorded', () => {
    const { ctx } = home();
    expect(loginIsKnownDead('abc', ctx)).toBe(false);
    expect(deadLoginReason('abc', ctx)).toBeUndefined();
  });

  it('remembers a refusal, and why, so a LATER process can act on it', () => {
    const { ctx } = home();
    rememberDeadLogin('dead', 'token endpoint 400: invalid_grant', ctx);
    expect(loginIsKnownDead('dead', ctx)).toBe(true);
    expect(deadLoginReason('dead', ctx)).toContain('invalid_grant');
  });

  it('does NOT apply to a different credential', () => {
    // Keyed on contents, so signing in produces a different key and the old
    // note cannot follow the account.
    const { ctx } = home();
    rememberDeadLogin('old-dead', 'invalid_grant', ctx);
    expect(loginIsKnownDead('fresh-login', ctx)).toBe(false);
  });

  it('forgets one that works again', () => {
    const { ctx } = home();
    rememberDeadLogin('x', 'invalid_grant', ctx);
    forgetDeadLogin('x', ctx);
    expect(loginIsKnownDead('x', ctx)).toBe(false);
  });

  it('treats an unknown fingerprint as NOT dead, and writes nothing for one', () => {
    // Not knowing must never hold an account down: the cost of a wrong "dead"
    // is a working login nobody can use.
    const { ctx, dir } = home();
    expect(loginIsKnownDead(null, ctx)).toBe(false);
    expect(loginIsKnownDead('', ctx)).toBe(false);
    rememberDeadLogin(null, 'invalid_grant', ctx);
    expect(existsSync(path.join(dir, 'dead-logins.json'))).toBe(false);
  });

  it('treats unreadable state as NOT dead rather than guessing', () => {
    const { ctx, dir } = home();
    writeFileSync(path.join(dir, 'dead-logins.json'), 'not json at all', 'utf8');
    expect(loginIsKnownDead('anything', ctx)).toBe(false);
  });

  it('keeps the file bounded, dropping the OLDEST refusals', () => {
    // One entry per sign-in over an install's life would otherwise grow forever.
    const { ctx, dir } = home();
    for (let i = 0; i < 60; i += 1) rememberDeadLogin(`f${i}`, 'invalid_grant', ctx, 1000 + i);
    const store = JSON.parse(readFileSync(path.join(dir, 'dead-logins.json'), 'utf8')) as {
      refused: Record<string, unknown>;
    };
    expect(Object.keys(store.refused)).toHaveLength(50);
    expect(loginIsKnownDead('f59', ctx)).toBe(true);
    expect(loginIsKnownDead('f0', ctx)).toBe(false);
  });

  it('never stores a token, only a fingerprint and a reason', () => {
    const { ctx, dir } = home();
    rememberDeadLogin('fingerprint-only', 'token endpoint 400: invalid_grant', ctx);
    const text = readFileSync(path.join(dir, 'dead-logins.json'), 'utf8');
    expect(text).toContain('fingerprint-only');
    expect(text).not.toMatch(/sk-|refreshToken|accessToken/);
  });
});
