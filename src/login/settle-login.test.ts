import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { settleNewLogin } from './settle-login.js';
import { addAccount, listAccounts, getAccount } from '../accounts/registry.js';
import { previousCredentialPath } from '../accounts/credential-vault.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

function context(lines: string[] = []): CliContext {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-settle-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    out: (m) => lines.push(m),
    json: false,
    quiet: false,
  };
}

/** Register `name` with a stored login built from `tokens`. */
function signIn(
  c: CliContext,
  name: string,
  tokens: { access?: string; refresh?: string },
  email?: string,
): string {
  const home = c.ctx.env?.CLAUDE_AUTO_SWITCH_HOME as string;
  const dir = path.join(home, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: tokens.access ?? `at-${name}`, refreshToken: tokens.refresh ?? `rt-${name}` },
    }),
    'utf8',
  );
  addAccount({ name, dir, enabled: true, ...(email ? { email } : {}) }, c.ctx);
  return dir;
}

describe('settleNewLogin', () => {
  it('accepts a genuinely new account and records who it is', async () => {
    const lines: string[] = [];
    const c = context(lines);
    signIn(c, 'first', { refresh: 'rt-first' }, 'one@example.com');
    const dir = signIn(c, 'second', { refresh: 'rt-second' });

    const r = await settleNewLogin(c, { name: 'second', dir }, {
      lookupOwner: () => Promise.resolve('two@example.com'),
    });

    expect(r.ok).toBe(true);
    expect(r.owner).toBe('two@example.com');
    // Recorded from the lookup, so later checks compare against something known.
    expect(getAccount('second', c.ctx)?.email).toBe('two@example.com');
  });

  it('REFUSES when another profile already holds that account', async () => {
    const lines: string[] = [];
    const c = context(lines);
    signIn(c, 'work', { refresh: 'rt-work' }, 'same@example.com');
    const dir = signIn(c, 'personal', { refresh: 'rt-personal' });

    const r = await settleNewLogin(c, { name: 'personal', dir }, {
      lookupOwner: () => Promise.resolve('same@example.com'),
    });

    expect(r.ok).toBe(false);
    expect(r.twin).toBe('work');
    expect(lines.join('\n')).toContain('REFUSED');
    // It has to say what to do, not only that it said no.
    expect(lines.join('\n')).toContain('Sign out at claude.ai');
    // And it must NOT have recorded the duplicate as this profile's identity.
    expect(getAccount('personal', c.ctx)?.email).toBeUndefined();
  });

  it('matches the account case-insensitively', async () => {
    const c = context();
    signIn(c, 'work', { refresh: 'rt-work' }, 'Same@Example.com');
    const dir = signIn(c, 'personal', { refresh: 'rt-personal' });
    const r = await settleNewLogin(c, { name: 'personal', dir }, {
      lookupOwner: () => Promise.resolve('same@example.com'),
    });
    expect(r.ok).toBe(false);
  });

  it('REFUSES an identical stored login without any network call', async () => {
    const lines: string[] = [];
    const c = context(lines);
    signIn(c, 'work', { refresh: 'shared-refresh-token' });
    const dir = signIn(c, 'personal', { refresh: 'shared-refresh-token' });

    let looked = false;
    const r = await settleNewLogin(c, { name: 'personal', dir }, {
      lookupOwner: () => {
        looked = true;
        return Promise.resolve(null);
      },
    });

    expect(r.ok).toBe(false);
    expect(r.twin).toBe('work');
    // The dangerous case is caught locally, so it still works offline.
    expect(looked).toBe(false);
  });

  it('restores the profile to its previous login when it refuses', async () => {
    const c = context();
    signIn(c, 'work', { refresh: 'rt-work' }, 'same@example.com');
    const dir = signIn(c, 'personal', { refresh: 'rt-new' });
    // What the profile held before this sign-in replaced it.
    writeFileSync(
      previousCredentialPath(dir),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at-old', refreshToken: 'rt-old' } }),
      'utf8',
    );

    const r = await settleNewLogin(c, { name: 'personal', dir }, {
      lookupOwner: () => Promise.resolve('same@example.com'),
    });

    expect(r.ok).toBe(false);
    const live = JSON.parse(readFileSync(path.join(dir, '.credentials.json'), 'utf8')) as {
      claudeAiOauth: { refreshToken: string };
    };
    expect(live.claudeAiOauth.refreshToken).toBe('rt-old'); // put back, not left broken
  });

  it('REMOVES the refused login when there is no previous one to go back to', async () => {
    const lines: string[] = [];
    const c = context(lines);
    signIn(c, 'work', { refresh: 'rt-work' }, 'same@example.com');
    const dir = signIn(c, 'personal', { refresh: 'rt-dupe' }); // no previous credential

    const r = await settleNewLogin(c, { name: 'personal', dir }, {
      lookupOwner: () => Promise.resolve('same@example.com'),
    });

    expect(r.ok).toBe(false);
    // Leaving it would keep the duplicate ACTIVE, which is the state being
    // refused, and would contradict the "has no login now" line that is printed.
    expect(existsSync(path.join(dir, '.credentials.json'))).toBe(false);
    expect(lines.join('\n')).toContain('has no login now');
  });

  it('keeps the login when the account cannot be confirmed', async () => {
    const lines: string[] = [];
    const c = context(lines);
    const dir = signIn(c, 'solo', { refresh: 'rt-solo' });

    const r = await settleNewLogin(c, { name: 'solo', dir }, {
      lookupOwner: () => Promise.resolve(null),
    });

    // Offline is not proof of a duplicate: rolling back a good sign-in over a
    // network blip would be worse than the thing being prevented.
    expect(r.ok).toBe(true);
    expect(lines.join('\n')).toContain('could not confirm');
    expect(listAccounts(c.ctx)).toHaveLength(1);
  });

  it('never prints a token', async () => {
    const lines: string[] = [];
    const c = context(lines);
    signIn(c, 'work', { refresh: 'super-secret-refresh' });
    const dir = signIn(c, 'personal', { refresh: 'super-secret-refresh' });
    await settleNewLogin(c, { name: 'personal', dir }, {
      lookupOwner: () => Promise.resolve(null),
    });
    expect(lines.join('\n')).not.toContain('super-secret-refresh');
  });
});
