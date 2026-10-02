import { describe, it, expect } from 'vitest';
import { auditSessionAccount } from './doctor-session-account.js';

const lease = (account: string, pid: number, configDir = `/sessions/${pid}`) => ({ account, pid, configDir });

it('reports a credential access failure instead of claiming no session is running', () => {
  const result = auditSessionAccount({
    accounts: [],
    leases: [lease('work', 111)],
    exists: () => {
      throw new Error('Could not read the profile login from macOS Keychain');
    },
  });
  expect(result.ok).toBe(false);
  expect(result.detail).toContain('Could not read the profile login from macOS Keychain');
  expect(result.detail).not.toContain('no session is running');
});

/**
 * Fingerprints are injected rather than built from real credential files: the
 * rule under test is "whose login is in each session's folder", and writing
 * real files would test the vault instead.
 */
function check(opts: {
  sessions: Array<{ account: string; pid: number; login: string | null }>;
  profiles?: Record<string, string | null>;
  sessionFileExists?: boolean;
}) {
  const profiles = opts.profiles ?? {};
  const logins = new Map(opts.sessions.map((s) => [`/sessions/${s.pid}`, s.login]));
  return auditSessionAccount({
    accounts: Object.keys(profiles).map((name) => ({ name, dir: `/profiles/${name}` })),
    leases: opts.sessions.map((s) => lease(s.account, s.pid)),
    platform: 'linux',
    exists: () => opts.sessionFileExists !== false,
    fingerprintOf: (dir) =>
      logins.has(dir) ? (logins.get(dir) ?? null) : (profiles[dir.split('/').pop() ?? ''] ?? null),
  });
}

describe('whether each running session is on the account ccx gave it', () => {
  it('says nothing is running when no session is', () => {
    const result = check({ sessions: [] });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('no session is running');
  });

  it('is happy when the session holds the login of the account it was given', () => {
    const result = check({
      sessions: [{ account: 'second', pid: 111, login: 'login-second' }],
      profiles: { second: 'login-second', phx: 'login-phx' },
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toBe('1 running session: 1 holds the login of the account it was given');
  });

  it('is happy with sessions on different accounts, which is what a folder each is for', () => {
    // The false alarm this replaces: every session was compared with the
    // account new sessions start on, so a second terminal on another account
    // was reported as a collision, with advice to end one of them.
    const result = check({
      sessions: [
        { account: 'contactss', pid: 111, login: 'login-contactss' },
        { account: 'alvi', pid: 222, login: 'login-alvi' },
      ],
      profiles: { contactss: 'login-contactss', alvi: 'login-alvi', aass: 'login-aass' },
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toBe('2 running sessions: 2 hold the login of the account each was given');
  });

  it("FAILS when a session holds another account's login than the one it was given", () => {
    const result = check({
      sessions: [
        { account: 'second', pid: 111, login: 'login-phx' },
        { account: 'phx', pid: 222, login: 'login-phx' },
      ],
      profiles: { second: 'login-second', phx: 'login-phx' },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('session 111 was given "second" but holds the login of "phx"');
    expect(result.detail).not.toContain('session 222');
    expect(result.detail).toContain('recorded against the wrong account');
    expect(result.fix?.join()).toContain('end that session and start it again');
  });

  it('does not cry wolf while a session renews its own token', () => {
    // A running Claude refreshes in place, so the session login is newer than
    // any stored copy until it is saved back. That happens every few hours and
    // is not a fault.
    const result = check({
      sessions: [{ account: 'second', pid: 111, login: 'login-brand-new' }],
      profiles: { second: 'login-second', phx: 'login-phx' },
    });
    expect(result.ok).toBe(true);
    // Said as what it is, not counted as a session found on its own account.
    expect(result.detail).toBe('1 running session: 1 renewed its login in place (newer than any stored copy)');
  });

  it('is happy when the account it was given shares its login with another profile', () => {
    const result = check({
      sessions: [{ account: 'phx', pid: 111, login: 'login-shared' }],
      profiles: { phx: 'login-shared', maxed: 'login-shared' },
    });
    expect(result.ok).toBe(true);
  });

  it('passes over a session whose login cannot be read yet, or is not there, and says so', () => {
    const unread = check({
      sessions: [
        { account: 'second', pid: 111, login: null },
        { account: 'phx', pid: 222, login: 'login-phx' },
        { account: 'other', pid: 333, login: 'login-renewed' },
      ],
      profiles: { second: 'login-second', phx: 'login-phx' },
    });
    expect(unread.ok).toBe(true);
    expect(unread.detail).toBe(
      '3 running sessions: 1 holds the login of the account it was given, 1 renewed its login in place (newer than any stored copy), 1 has no readable login yet',
    );
    expect(
      check({ sessions: [{ account: 'second', pid: 111, login: 'x' }], sessionFileExists: false }).ok,
    ).toBe(true);
  });
});

describe('two sessions sharing one session directory', () => {
  it('FAILS and names them, because only one login fits in that directory', () => {
    const result = auditSessionAccount({
      accounts: [{ name: 'phx', dir: '/profiles/phx' }],
      leases: [lease('phx', 111, 'C:/home/session'), lease('second', 222, 'C:/home/session')],
      platform: 'linux',
      exists: () => true,
      fingerprintOf: () => 'login-phx',
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('2 sessions are sharing one session directory');
    expect(result.detail).toContain('phx (pid 111)');
    expect(result.detail).toContain('second (pid 222)');
  });

  it('treats two spellings of one Windows path as the same directory', () => {
    // Real lease files hold backslashes ("C:\\Users\\opens\\.claude-auto-switch\\session"),
    // so the separator has to be normalised as well as the case.
    const result = auditSessionAccount({
      accounts: [{ name: 'phx', dir: '/profiles/phx' }],
      leases: [lease('phx', 111, 'C:\\Home\\Session'), lease('second', 222, 'c:/home/session')],
      platform: 'win32',
      exists: () => true,
      fingerprintOf: () => 'login-phx',
    });
    expect(result.ok).toBe(false);
  });

  it('keeps genuinely different Windows directories apart', () => {
    const result = auditSessionAccount({
      accounts: [
        { name: 'phx', dir: '/profiles/phx' },
        { name: 'second', dir: '/profiles/second' },
      ],
      leases: [
        lease('phx', 111, 'C:\\Users\\opens\\session-111'),
        lease('second', 222, 'C:\\Users\\opens\\session-222'),
      ],
      platform: 'win32',
      exists: () => true,
      fingerprintOf: (dir) => (dir.endsWith('111') || dir.endsWith('phx') ? 'login-phx' : 'login-second'),
    });
    expect(result.ok).toBe(true);
  });

  it('keeps case-distinct POSIX paths apart, because they ARE different directories', () => {
    // Folding case everywhere would merge /tmp/Session with /tmp/session on
    // Linux and report a collision between two sessions that are not
    // colliding, then tell the operator to stop one of them.
    const result = auditSessionAccount({
      accounts: [{ name: 'phx', dir: '/profiles/phx' }],
      leases: [lease('phx', 111, '/tmp/Session'), lease('second', 222, '/tmp/session')],
      platform: 'linux',
      exists: () => true,
      fingerprintOf: () => null,
    });
    expect(result.ok).toBe(true);
  });
});
