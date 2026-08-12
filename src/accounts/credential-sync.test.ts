import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  decidePull,
  pullProfileIntoSession,
  recoverLoginFromLiveSession,
  type PullEvidence,
} from './credential-sync.js';
import { credentialPath, credentialFingerprint } from './credential-vault.js';
import { takeLease } from '../session/lease.js';

function evidence(overrides: Partial<PullEvidence> = {}): PullEvidence {
  return {
    sessionUsable: true,
    profileUsable: true,
    sameLineage: false,
    sessionEmail: 'a@example.com',
    accountEmail: 'a@example.com',
    sessionExpiresAt: 1_000,
    profileExpiresAt: 2_000,
    ...overrides,
  };
}

describe('whether the profile login replaces the session copy', () => {
  it('pulls when the stored login is a newer lineage than the session copy', () => {
    // The /login bug this file ends: any other holder renewing retires the
    // lineage this session holds, and its next refresh dies mid-work.
    expect(decidePull(evidence()).pull).toBe(true);
  });

  it('pulls into a session whose copy is unusable, whoever it belonged to', () => {
    // A failed refresh leaves a valid-JSON credential with empty tokens; the
    // session is stranded until someone rearms it.
    const d = decidePull(evidence({ sessionUsable: false, sessionEmail: null }));
    expect(d.pull).toBe(true);
  });

  it('never pulls over a session signed in as a DIFFERENT account', () => {
    // A mid-session /login made the session somebody else. Overwriting that
    // login would hijack a running Claude; rotation realigns it, not sync.
    const d = decidePull(evidence({ sessionEmail: 'someone-else@example.com' }));
    expect(d.pull).toBe(false);
  });

  it('never pulls when both copies are the same login already', () => {
    expect(decidePull(evidence({ sameLineage: true })).pull).toBe(false);
  });

  it('never pulls a profile that is not newer: the mirror carries the other way', () => {
    const d = decidePull(evidence({ sessionExpiresAt: 3_000, profileExpiresAt: 2_000 }));
    expect(d.pull).toBe(false);
  });

  it('never pulls from a profile with no usable login', () => {
    expect(decidePull(evidence({ profileUsable: false })).pull).toBe(false);
  });

  it('still pulls when identities are unrecorded, on freshness alone', () => {
    // Not knowing is not evidence of a mismatch; refusing on unknown would
    // leave the session to die on a retired token for no reason.
    const d = decidePull(evidence({ sessionEmail: null, accountEmail: null }));
    expect(d.pull).toBe(true);
  });
});

function dirWithLogin(root: string, name: string, token: string, expiresAt: number, email?: string) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    credentialPath(dir),
    JSON.stringify({
      claudeAiOauth: { accessToken: `at-${token}`, refreshToken: `rt-${token}`, expiresAt },
    }),
  );
  if (email) {
    writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  }
  return dir;
}

describe('carrying a renewal into a running session', () => {
  // A scratch home, so these tests' log entries never land in the real one.
  const scratch = (root: string) => ({ env: { CLAUDE_AUTO_SWITCH_HOME: root } });
  it('replaces the session copy and reports what it did', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cas-sync-'));
    const profile = dirWithLogin(root, 'profile', 'new', 9_000);
    const session = dirWithLogin(root, 'session', 'old', 1_000, 'a@example.com');
    const result = pullProfileIntoSession(
      { name: 'work', dir: profile, email: 'a@example.com' },
      session,
      scratch(root),
    );
    expect(result).toBe('pulled');
    expect(credentialFingerprint(session)).toBe(credentialFingerprint(profile));
  });

  it('does nothing when the lineages already match', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cas-sync-'));
    const profile = dirWithLogin(root, 'profile', 'same', 9_000);
    const session = dirWithLogin(root, 'session', 'same', 9_000);
    expect(pullProfileIntoSession({ name: 'work', dir: profile }, session, scratch(root))).toBe('skipped');
  });

  it('reports busy instead of waiting when a refresh holds the lock', () => {
    // A busy lock means a refresh is mid-write, which is exactly when to come
    // back next tick. This runs on the poll that relays the session's screen,
    // so waiting here would visibly freeze the terminal.
    const root = mkdtempSync(path.join(tmpdir(), 'cas-sync-'));
    const profile = dirWithLogin(root, 'profile', 'new', 9_000);
    const session = dirWithLogin(root, 'session', 'old', 1_000, 'a@example.com');
    mkdirSync(path.join(session, '.oauth_refresh.lock'), { recursive: true });
    expect(
      pullProfileIntoSession({ name: 'work', dir: profile, email: 'a@example.com' }, session, scratch(root)),
    ).toBe('busy');
    // And nothing was written under the busy lock.
    expect(credentialFingerprint(session)).not.toBe(credentialFingerprint(profile));
  });
});

describe('recovering a dead profile login from a live session', () => {
  function home(): { root: string; c: { env: Record<string, string> } } {
    const root = mkdtempSync(path.join(tmpdir(), 'cas-recover-'));
    return { root, c: { env: { CLAUDE_AUTO_SWITCH_HOME: root } } };
  }

  it('adopts the live session copy when its identity matches the account', () => {
    const { root, c } = home();
    const profile = dirWithLogin(root, 'profile', 'dead', 1);
    const live = dirWithLogin(root, 'live-session', 'fresh', 9_000, 'a@example.com');
    takeLease('work', live, c);
    const result = recoverLoginFromLiveSession(
      { name: 'work', dir: profile, email: 'a@example.com' },
      null,
      c,
    );
    expect(result.recovered).toBe(true);
    expect(result.fromPid).toBe(process.pid);
    expect(credentialFingerprint(profile)).toBe(credentialFingerprint(live));
  });

  it('refuses a live session signed in as somebody else, whatever the lease says', () => {
    // Leases have lied before: a contaminated session carried another account's
    // login under the right lease. The session's own recorded identity decides.
    const { root, c } = home();
    const profile = dirWithLogin(root, 'profile', 'dead', 1);
    const live = dirWithLogin(root, 'live-session', 'stolen', 9_000, 'thief@example.com');
    takeLease('work', live, c);
    const before = credentialFingerprint(profile);
    expect(
      recoverLoginFromLiveSession({ name: 'work', dir: profile, email: 'a@example.com' }, null, c)
        .recovered,
    ).toBe(false);
    expect(credentialFingerprint(profile)).toBe(before);
  });

  it('refuses when the account has no registered address to verify against', () => {
    const { root, c } = home();
    const profile = dirWithLogin(root, 'profile', 'dead', 1);
    const live = dirWithLogin(root, 'live-session', 'fresh', 9_000, 'a@example.com');
    takeLease('work', live, c);
    expect(recoverLoginFromLiveSession({ name: 'work', dir: profile }, null, c).recovered).toBe(
      false,
    );
  });

  it('never adopts from the session that is asking', () => {
    // The caller IS a session: adopting its own copy would "recover" the very
    // login that was just judged dead.
    const { root, c } = home();
    const profile = dirWithLogin(root, 'profile', 'dead', 1);
    const own = dirWithLogin(root, 'own-session', 'fresh', 9_000, 'a@example.com');
    takeLease('work', own, c);
    expect(
      recoverLoginFromLiveSession({ name: 'work', dir: profile, email: 'a@example.com' }, own, c)
        .recovered,
    ).toBe(false);
  });
});
