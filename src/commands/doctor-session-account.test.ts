import { describe, it, expect } from 'vitest';
import { auditSessionAccount } from './doctor-session-account.js';

/**
 * Fingerprints are injected rather than built from real credential files: the
 * rule under test is "whose login is in the session directory", and writing
 * real files would test the vault instead.
 */
function check(opts: {
  session?: string | null;
  active?: string | null;
  profiles?: Record<string, string | null>;
  sessionFileExists?: boolean;
}) {
  const profiles = opts.profiles ?? {};
  return auditSessionAccount({
    sessionDir: '/session',
    activeAccount: opts.active === undefined ? 'second' : opts.active,
    accounts: Object.keys(profiles).map((name) => ({ name, dir: `/profiles/${name}` })),
    exists: () => opts.sessionFileExists !== false,
    fingerprintOf: (dir) =>
      dir === '/session' ? (opts.session ?? null) : (profiles[dir.split('/').pop() ?? ''] ?? null),
  });
}

describe('whether the running session is on the account ccx thinks it is', () => {
  it('says nothing is running when there is no session credential', () => {
    const result = check({ sessionFileExists: false });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('no session is running');
  });

  it('is happy when the session holds the active account login', () => {
    const result = check({
      session: 'login-second',
      active: 'second',
      profiles: { second: 'login-second', phx: 'login-phx' },
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('running as "second"');
  });

  it('FAILS when another session has taken this terminal account', () => {
    // The collision. Every `ccx run` shares one session directory, so a second
    // session overwrites the credential and the first terminal keeps running on
    // somebody else's login while ccx still reports the account it chose.
    const result = check({
      session: 'login-phx',
      active: 'second',
      profiles: { second: 'login-second', phx: 'login-phx' },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('using "phx"');
    expect(result.detail).toContain('active account is "second"');
    expect(result.detail).toContain('recorded against the wrong account');
    expect(result.fix?.join()).toContain('end one of the running ccx sessions');
  });

  it('does not cry wolf while a session renews its own token', () => {
    // A running Claude refreshes in place, so the session login is newer than
    // any stored copy until it is saved back. That happens every few hours and
    // is not a fault.
    const result = check({
      session: 'login-brand-new',
      active: 'second',
      profiles: { second: 'login-second', phx: 'login-phx' },
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('newer than any stored copy');
  });

  it('names the duplicate when the active account shares its login', () => {
    // Two profiles can hold one login. That is not a collision, but it is worth
    // saying, because it explains why two accounts move together.
    const result = check({
      session: 'login-shared',
      active: 'phx',
      profiles: { phx: 'login-shared', maxed: 'login-shared' },
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('running as "phx"');
    expect(result.detail).toContain('shares with maxed');
  });

  it('reports honestly when there is no active account at all', () => {
    const result = check({
      session: 'login-phx',
      active: null,
      profiles: { phx: 'login-phx' },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('active account is "none"');
  });

  it('is quiet when the session credential cannot be read', () => {
    const result = check({ session: null, profiles: { second: 'login-second' } });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('no readable login');
  });
});

describe('two sessions sharing one session directory', () => {
  const lease = (account: string, pid: number, dir = 'C:/home/session') => ({
    account,
    pid,
    configDir: dir,
  });

  it('FAILS and names them, because only one login fits in that directory', () => {
    const result = auditSessionAccount({
      sessionDir: '/session',
      activeAccount: 'phx',
      accounts: [{ name: 'phx', dir: '/profiles/phx' }],
      leases: [lease('phx', 111), lease('second', 222)],
      exists: () => true,
      fingerprintOf: () => 'login-phx',
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('2 sessions are sharing one session directory');
    expect(result.detail).toContain('phx (pid 111)');
    expect(result.detail).toContain('second (pid 222)');
  });

  it('is quiet for a single running session', () => {
    const result = auditSessionAccount({
      sessionDir: '/session',
      activeAccount: 'phx',
      accounts: [{ name: 'phx', dir: '/profiles/phx' }],
      leases: [lease('phx', 111)],
      exists: () => true,
      fingerprintOf: () => 'login-phx',
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('running as "phx"');
  });

  it('is quiet when sessions have a directory each', () => {
    // What this check is really asking. Today every session shares one
    // directory, so the day that changes this must stop firing rather than
    // complain about every second terminal.
    const result = auditSessionAccount({
      sessionDir: '/session',
      activeAccount: 'phx',
      accounts: [{ name: 'phx', dir: '/profiles/phx' }],
      leases: [lease('phx', 111, 'C:/home/session-111'), lease('second', 222, 'C:/home/session-222')],
      exists: () => true,
      fingerprintOf: () => 'login-phx',
    });
    expect(result.ok).toBe(true);
  });

  it('treats the same directory spelled differently as the same directory', () => {
    const result = auditSessionAccount({
      sessionDir: '/session',
      activeAccount: 'phx',
      accounts: [{ name: 'phx', dir: '/profiles/phx' }],
      leases: [lease('phx', 111, 'C:/Home/Session'), lease('second', 222, 'c:/home/session')],
      exists: () => true,
      fingerprintOf: () => 'login-phx',
    });
    expect(result.ok).toBe(false);
  });
});
