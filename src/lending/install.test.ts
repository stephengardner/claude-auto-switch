import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installLend, removeLend } from './install.js';
import { buildLendBundle, type LendBundle } from './bundle.js';
import { LENT_HINT_FILE, lentLoginIn } from './lent-login.js';
import { addAccount, getAccount, listAccounts } from '../accounts/registry.js';
import { readCredentialEvents } from '../accounts/credential-log.js';
import { getActive, setActive } from '../state/active.js';
import { CREDENTIALS_LOCK_DIR } from '../claude/locks.js';
import { LendError } from '../util/errors.js';
import { HOUR, machine, type Machine } from '../../test/lending-fixtures.js';

const NOW = 1_800_000_000_000;
const posix = process.platform !== 'win32';

function lend(
  expiresAt: number,
  overrides: { account?: string; email?: string; accessToken?: string } = {},
): LendBundle {
  const account = overrides.account ?? 'work';
  return buildLendBundle({
    account,
    email: overrides.email ?? `${account}@example.com`,
    credential: JSON.stringify({
      claudeAiOauth: {
        accessToken: overrides.accessToken ?? `at-${expiresAt}`,
        refreshToken: 'rt-owner',
        expiresAt,
      },
    }),
    oauthAccount: {
      emailAddress: overrides.email ?? `${account}@example.com`,
      accountUuid: 'uuid-1',
    },
    now: NOW,
  });
}

function receiver(): Machine & { config: Record<string, never> } {
  return { ...machine('cas-recv-'), config: {} };
}

function credentialText(m: Machine, name = 'work'): string {
  return readFileSync(path.join(getAccount(name, m.ctx)?.dir ?? '', '.credentials.json'), 'utf8');
}

describe('installing a lend on the receiving machine', () => {
  it('registers the account and keeps the lent login owner-only, with no refresh token', () => {
    const r = receiver();
    const result = installLend(lend(NOW + 6 * HOUR), r, { now: NOW });
    expect(result).toEqual({ status: 'installed', account: 'work', expiresAt: NOW + 6 * HOUR });

    const account = getAccount('work', r.ctx);
    expect(account?.email).toBe('work@example.com');
    expect(account?.dir).toBe(path.join(r.home, 'profiles', 'work'));
    const text = credentialText(r);
    expect(text).not.toMatch(/refresh/i);
    expect(lentLoginIn(account?.dir ?? '')).toEqual({ expiresAt: NOW + 6 * HOUR });
    const identity = JSON.parse(
      readFileSync(path.join(account?.dir ?? '', '.claude.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(identity.oauthAccount).toEqual({
      emailAddress: 'work@example.com',
      accountUuid: 'uuid-1',
    });
    if (posix) {
      for (const file of ['.credentials.json', LENT_HINT_FILE, '.claude.json']) {
        expect(statSync(path.join(account?.dir ?? '', file)).mode & 0o777, file).toBe(0o600);
      }
    }
    // What happened is written down, and the token is not.
    const events = readCredentialEvents(10, r.ctx);
    expect(events.map((e) => e.kind)).toEqual(['installed']);
    expect(JSON.stringify(events)).not.toContain('at-');
  });

  it('replaces an older lend with a fresher one, and leaves a lend that is as fresh alone', () => {
    const r = receiver();
    installLend(lend(NOW + HOUR), r, { now: NOW });
    expect(installLend(lend(NOW + 6 * HOUR), r, { now: NOW }).status).toBe('updated');
    expect(credentialText(r)).toContain(`at-${NOW + 6 * HOUR}`);
    // Delivered twice, or out of order: what is installed is kept.
    const before = credentialText(r);
    expect(installLend(lend(NOW + 6 * HOUR), r, { now: NOW }).status).toBe('unchanged');
    expect(installLend(lend(NOW + 2 * HOUR), r, { now: NOW })).toEqual({
      status: 'unchanged',
      account: 'work',
      expiresAt: NOW + 6 * HOUR,
    });
    expect(credentialText(r)).toBe(before);
  });

  it("never replaces a login of this machine's own", () => {
    const r = receiver();
    const dir = path.join(r.home, 'profiles', 'work');
    mkdirSync(dir, { recursive: true });
    const own = JSON.stringify({
      claudeAiOauth: { accessToken: 'at-own', refreshToken: 'rt-own', expiresAt: NOW + HOUR },
    });
    writeFileSync(path.join(dir, '.credentials.json'), own, 'utf8');
    addAccount({ name: 'work', dir, email: 'work@example.com' }, r.ctx);

    expect(() => installLend(lend(NOW + 6 * HOUR), r, { now: NOW })).toThrow(
      /has its own login on this machine/,
    );
    expect(credentialText(r)).toBe(own);
    expect(existsSync(path.join(dir, LENT_HINT_FILE))).toBe(false);
  });

  it('takes a lend into an account registered with no login, such as one ccx login --host added', () => {
    const r = receiver();
    const dir = path.join(r.home, 'profiles', 'work');
    mkdirSync(dir, { recursive: true });
    addAccount({ name: 'work', dir }, r.ctx);
    expect(installLend(lend(NOW + HOUR), r, { now: NOW }).status).toBe('updated');
    // The address it now knows is recorded.
    expect(getAccount('work', r.ctx)?.email).toBe('work@example.com');
  });

  it('refuses a lend for a different address than the account is registered with', () => {
    const r = receiver();
    installLend(lend(NOW + HOUR), r, { now: NOW });
    expect(() =>
      installLend(lend(NOW + 6 * HOUR, { email: 'someone-else@example.com' }), r, { now: NOW }),
    ).toThrow(
      /registered here for work@example.com, but this lend is for someone-else@example.com/,
    );
  });

  it('installs under another name when told to', () => {
    const r = receiver();
    expect(installLend(lend(NOW + HOUR), r, { as: 'build-work', now: NOW }).account).toBe(
      'build-work',
    );
    expect(listAccounts(r.ctx).map((a) => a.name)).toEqual(['build-work']);
  });

  it('leaves no account behind when a lend it registered for could not be written', () => {
    // Something else holds the login lock, and goes on holding it.
    const r = receiver();
    mkdirSync(path.join(r.home, 'profiles', 'work', CREDENTIALS_LOCK_DIR), { recursive: true });
    expect(() => installLend(lend(NOW + HOUR), r, { now: NOW })).toThrow(LendError);
    expect(listAccounts(r.ctx)).toEqual([]);
  });
});

describe('taking a lend back on the receiving machine', () => {
  it('removes the lent login and the account the lend added', () => {
    const r = receiver();
    installLend(lend(NOW + HOUR), r, { now: NOW });
    const dir = getAccount('work', r.ctx)?.dir ?? '';
    setActive('work', r.ctx);

    expect(removeLend('work', r)).toEqual({
      status: 'removed',
      account: 'work',
      deregistered: true,
    });
    expect(existsSync(path.join(dir, '.credentials.json'))).toBe(false);
    expect(existsSync(path.join(dir, LENT_HINT_FILE))).toBe(false);
    expect(getAccount('work', r.ctx)).toBeUndefined();
    expect(getActive(r.ctx)).toBeNull();
    expect(readCredentialEvents(10, r.ctx).map((e) => e.kind)).toEqual(['installed', 'removed']);
  });

  it('keeps an account that was registered before the lend, with no login', () => {
    const r = receiver();
    const dir = path.join(r.home, 'profiles', 'work');
    mkdirSync(dir, { recursive: true });
    addAccount({ name: 'work', dir }, r.ctx);
    installLend(lend(NOW + HOUR), r, { now: NOW });
    expect(removeLend('work', r)).toEqual({
      status: 'removed',
      account: 'work',
      deregistered: false,
    });
    expect(getAccount('work', r.ctx)).toBeDefined();
    expect(existsSync(path.join(dir, '.credentials.json'))).toBe(false);
  });

  it("never removes a login of this machine's own, and has nothing to do where nothing was lent", () => {
    const r = receiver();
    const dir = path.join(r.home, 'profiles', 'work');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at-own', refreshToken: 'rt-own', expiresAt: NOW + HOUR },
      }),
      'utf8',
    );
    addAccount({ name: 'work', dir }, r.ctx);
    expect(() => removeLend('work', r)).toThrow(/has its own login on this machine/);
    expect(existsSync(path.join(dir, '.credentials.json'))).toBe(true);

    expect(removeLend('nobody', r)).toEqual({
      status: 'absent',
      account: 'nobody',
      deregistered: false,
    });
    const empty = path.join(r.home, 'profiles', 'empty');
    mkdirSync(empty, { recursive: true });
    addAccount({ name: 'empty', dir: empty }, r.ctx);
    expect(removeLend('empty', r).status).toBe('absent');
    expect(getAccount('empty', r.ctx)).toBeDefined();
  });
});
