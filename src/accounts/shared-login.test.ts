import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  propagateRenewal,
  snapshotSharing,
  writeAndCarry,
  renewAndCarry,
} from './shared-login.js';
import { credentialFingerprint, installCredential } from './credential-vault.js';

function profile(home: string, name: string, oauth: Record<string, unknown>) {
  const dir = path.join(home, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
  return { name, dir };
}

function refreshTokenOf(dir: string): string {
  return (
    JSON.parse(readFileSync(path.join(dir, '.credentials.json'), 'utf8')) as {
      claudeAiOauth: { refreshToken: string };
    }
  ).claudeAiOauth.refreshToken;
}

/** Two profiles holding one login, as a duplicate sign-in produces. */
function sharedPair() {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-shared-'));
  const shared = { accessToken: 'sk-old', refreshToken: 'refresh-shared', expiresAt: 1 };
  const renewed = profile(home, 'phx', { ...shared });
  const sibling = profile(home, 'maxed', { ...shared });
  return { home, renewed, sibling, retired: credentialFingerprint(renewed.dir) };
}

/** Stand in for the renewal: replace the login with a rotated one. */
function renew(dir: string, refreshToken = 'refresh-rotated'): void {
  writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'sk-new', refreshToken, expiresAt: 999 } }),
    'utf8',
  );
}

describe('a login shared by two profiles, when one of them renews', () => {
  it('carries the new login across, so the other one keeps working', () => {
    // The death this prevents: renewing rotates the token and retires the old
    // one immediately, so the sibling is finished the moment this happens. It
    // is the same account, so it should hold the same login.
    const { renewed, sibling, retired } = sharedPair();
    renew(renewed.dir);

    const updated = propagateRenewal({
      renewedDir: renewed.dir,
      siblings: [sibling],
      retired,
      renewed: credentialFingerprint(renewed.dir),
    });
    expect(updated).toEqual(['maxed']);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-rotated');
  });

  it('keeps the sibling previous login as a rollback cushion', () => {
    const { renewed, sibling, retired } = sharedPair();
    renew(renewed.dir);
    propagateRenewal({
      renewedDir: renewed.dir,
      siblings: [sibling],
      retired,
      renewed: credentialFingerprint(renewed.dir),
    });
    expect(existsSync(path.join(sibling.dir, '.credentials.prev.json'))).toBe(true);
  });

  it('does NOT touch a profile holding a different login', () => {
    // The precondition that makes this safe to do automatically. Writing over a
    // profile that is not the one that just got retired would be a guess about
    // someone's login, and guessing scrambled these profiles once before.
    const { home, renewed, retired } = sharedPair();
    const other = profile(home, 'second', {
      accessToken: 'sk-other',
      refreshToken: 'refresh-someone-else',
      expiresAt: 5,
    });
    renew(renewed.dir);

    const updated = propagateRenewal({
      renewedDir: renewed.dir,
      siblings: [other],
      retired,
      renewed: credentialFingerprint(renewed.dir),
    });
    expect(updated).toEqual([]);
    expect(refreshTokenOf(other.dir)).toBe('refresh-someone-else');
  });

  it('does nothing when there is no fingerprint to match on', () => {
    const { renewed, sibling } = sharedPair();
    renew(renewed.dir);
    const updated = propagateRenewal({
      renewedDir: renewed.dir,
      siblings: [sibling],
      retired: null,
      renewed: credentialFingerprint(renewed.dir),
    });
    expect(updated).toEqual([]);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-shared');
  });

  it('never writes over the profile that was renewed', () => {
    // Checked BEFORE the renewal on purpose. Afterwards this profile no longer
    // matches the retired fingerprint, so the exact-match check would refuse it
    // anyway and the guard would prove nothing. Before it, only the self-check
    // stops it copying a file onto itself.
    const { renewed, retired } = sharedPair();
    const updated = propagateRenewal({
      renewedDir: renewed.dir,
      siblings: [renewed],
      retired,
      renewed: retired,
    });
    expect(updated).toEqual([]);
    expect(refreshTokenOf(renewed.dir)).toBe('refresh-shared');
  });

  it('carries on when one profile cannot be written', () => {
    // The write failure is FORCED, not hoped for. An earlier version of this
    // test used a perfectly writable directory, so the failure handler it
    // claimed to cover never ran once.
    const { home, renewed, sibling, retired } = sharedPair();
    const broken = profile(home, 'broken', {
      accessToken: 'sk-old',
      refreshToken: 'refresh-shared',
      expiresAt: 1,
    });
    renew(renewed.dir);

    const updated = propagateRenewal(
      {
        renewedDir: renewed.dir,
        siblings: [broken, sibling],
        retired,
        renewed: credentialFingerprint(renewed.dir),
      },
      {
        install: (destDir, sourceFile) => {
          if (destDir === broken.dir) throw new Error('disk on fire');
          writeFileSync(path.join(destDir, '.credentials.json'), readFileSync(sourceFile, 'utf8'));
          return true;
        },
      },
    );

    expect(updated).toEqual(['maxed']);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-rotated');
  });
});

describe('something changing between the check and the write', () => {
  it('leaves a sibling alone when its login changed after the check', () => {
    // The window: the fingerprint is checked, then the file is replaced. If a
    // sign-in lands in between, an unguarded write would replace that NEWER
    // login with an older one. The injected lock stages that interleaving.
    const { renewed, sibling, retired } = sharedPair();
    renew(renewed.dir);
    const written: string[] = [];

    const updated = propagateRenewal(
      {
        renewedDir: renewed.dir,
        siblings: [sibling],
        retired,
        renewed: credentialFingerprint(renewed.dir),
      },
      {
        lock: (dir, fn) => {
          // Another process signs the SIBLING in while its lock is taken. The
          // source lock is left alone, or the run would stop before this point.
          if (dir === sibling.dir) renew(dir, 'refresh-signed-in-just-now');
          fn();
        },
        install: (destDir) => {
          written.push(destDir);
          return true;
        },
      },
    );

    expect(updated).toEqual([]);
    expect(written).toEqual([]);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-signed-in-just-now');
  });

  it('carries nothing when the SOURCE login changed after the renewal', () => {
    // Bound to the credential the renewal actually produced. If the source has
    // been replaced again since, spreading it would push a token nobody asked
    // for onto the old cohort.
    const { renewed, sibling, retired } = sharedPair();
    renew(renewed.dir);
    const renewedFingerprint = credentialFingerprint(renewed.dir);
    renew(renewed.dir, 'refresh-rotated-yet-again');

    const updated = propagateRenewal({
      renewedDir: renewed.dir,
      siblings: [sibling],
      retired,
      renewed: renewedFingerprint,
    });
    expect(updated).toEqual([]);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-shared');
  });
});

describe('the order of taking the snapshot', () => {
  it('works when taken BEFORE the renewal', () => {
    const { renewed, sibling } = sharedPair();
    const snapshot = snapshotSharing(renewed, [renewed, sibling], ['maxed']);
    renew(renewed.dir);

    const updated = propagateRenewal({
      renewedDir: renewed.dir,
      siblings: snapshot.sharedWith,
      retired: snapshot.fingerprint,
      renewed: credentialFingerprint(renewed.dir),
    });
    expect(updated).toEqual(['maxed']);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-rotated');
  });

  it('is USELESS when taken after, which is why it is a separate step', () => {
    // Renewing rotates the token, so by then there is no shared value left to
    // match on and the sibling is silently left holding a dead login. This is
    // the mistake the snapshot exists to prevent.
    const { renewed, sibling } = sharedPair();
    renew(renewed.dir);
    const tooLate = snapshotSharing(renewed, [renewed, sibling], ['maxed']);

    const updated = propagateRenewal({
      renewedDir: renewed.dir,
      siblings: tooLate.sharedWith,
      retired: tooLate.fingerprint,
      renewed: credentialFingerprint(renewed.dir),
    });
    expect(updated).toEqual([]);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-shared'); // still the dead one
  });
});

describe('the cheap checks before the lock', () => {
  it('takes no lock for a profile that plainly does not match', () => {
    // The inner re-check is what makes this correct; the outer one is what
    // makes it cheap. Asserting the lock is never taken is the only way that
    // difference is observable, and without it the outer check is untested.
    const { home, renewed, retired } = sharedPair();
    const other = profile(home, 'second', {
      accessToken: 'sk-other',
      refreshToken: 'refresh-someone-else',
      expiresAt: 5,
    });
    renew(renewed.dir);
    const locked: string[] = [];

    const updated = propagateRenewal(
      {
        renewedDir: renewed.dir,
        siblings: [other],
        retired,
        renewed: credentialFingerprint(renewed.dir),
      },
      { lock: (dir, fn) => { locked.push(dir); fn(); } },
    );

    expect(updated).toEqual([]);
    // The source is locked to take the snapshot; the point is that the sibling
    // that obviously does not match is never locked at all.
    expect(locked).not.toContain(other.dir);
  });

  it('stops before touching any sibling when the source has moved on', () => {
    const { renewed, sibling, retired } = sharedPair();
    renew(renewed.dir);
    const renewedFingerprint = credentialFingerprint(renewed.dir);
    renew(renewed.dir, 'refresh-rotated-yet-again');
    const locked: string[] = [];

    const updated = propagateRenewal(
      {
        renewedDir: renewed.dir,
        siblings: [sibling],
        retired,
        renewed: renewedFingerprint,
      },
      { lock: (dir, fn) => { locked.push(dir); fn(); } },
    );

    expect(updated).toEqual([]);
    expect(locked).toEqual([]);
  });
});

describe('the source changing while siblings are being written', () => {
  it('writes the credential that was VERIFIED, not whatever the source holds later', () => {
    // The gap the snapshot closes: verifying the source and then handing the
    // installer its PATH lets the file change before the installer reads it, so
    // a sign-in in that window would land in a sibling unchecked.
    const { renewed, sibling, retired } = sharedPair();
    renew(renewed.dir);
    const verified = credentialFingerprint(renewed.dir);
    const installedFrom: string[] = [];

    const updated = propagateRenewal(
      {
        renewedDir: renewed.dir,
        siblings: [sibling],
        retired,
        renewed: verified,
      },
      {
        lock: (dir, fn) => {
          fn();
          // The source is signed in again the moment its lock is released,
          // before any sibling is written.
          if (dir === renewed.dir) renew(dir, 'refresh-source-changed-mid-flight');
        },
        install: (destDir, sourceFile) => {
          installedFrom.push(readFileSync(sourceFile, 'utf8'));
          writeFileSync(path.join(destDir, '.credentials.json'), readFileSync(sourceFile, 'utf8'));
          return true;
        },
      },
    );

    expect(updated).toEqual(['maxed']);
    // The sibling holds the verified login, NOT the one that arrived afterwards.
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-rotated');
    expect(installedFrom.join()).not.toContain('refresh-source-changed-mid-flight');
  });
});

describe('the sequence a live session performs when it saves its login back', () => {
  it('carries a token the RUNNING claude refreshed, not just one ccx renewed', () => {
    // This is the path that fires most often: a long-running Claude refreshes
    // its own token every few hours, ccx mirrors it into the active profile,
    // and a duplicate profile would rot while its twin is being used. The steps
    // here are exactly what saveBack does, with the real functions.
    const { home, renewed: active, sibling } = sharedPair();

    // What the running session ends up holding after Claude refreshes it.
    const sessionDir = path.join(home, 'session');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-session', refreshToken: 'refresh-from-claude', expiresAt: 999 },
      }),
      'utf8',
    );

    // 1. who shares the login being replaced, asked BEFORE the write
    const sharing = snapshotSharing(active, [active, sibling], ['maxed']);
    // 2. the save-back itself
    installCredential(active.dir, path.join(sessionDir, '.credentials.json'));
    // 3. carry it across
    const carried = propagateRenewal({
      renewedDir: active.dir,
      siblings: sharing.sharedWith,
      retired: sharing.fingerprint,
      renewed: credentialFingerprint(active.dir),
    });

    expect(carried).toEqual(['maxed']);
    expect(refreshTokenOf(active.dir)).toBe('refresh-from-claude');
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-from-claude');
  });

  it('leaves the sibling stranded if the snapshot is taken after the save', () => {
    // Why the order in saveBack is load-bearing rather than incidental.
    const { home, renewed: active, sibling } = sharedPair();
    const sessionDir = path.join(home, 'session');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-session', refreshToken: 'refresh-from-claude', expiresAt: 999 },
      }),
      'utf8',
    );

    installCredential(active.dir, path.join(sessionDir, '.credentials.json'));
    const tooLate = snapshotSharing(active, [active, sibling], ['maxed']);
    const carried = propagateRenewal({
      renewedDir: active.dir,
      siblings: tooLate.sharedWith,
      retired: tooLate.fingerprint,
      renewed: credentialFingerprint(active.dir),
    });

    expect(carried).toEqual([]);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-shared'); // the dead one
  });
});

describe('writing a login and carrying it, as one operation', () => {
  it('carries the new login to the profiles that shared the old one', () => {
    // The save-back path. Doing this as three statements at the call site meant
    // a later edit could reorder them and nothing would fail: removing the
    // carry from session.ts broke no test at all, which is why it lives here.
    const { renewed: active, sibling } = sharedPair();

    const carried = writeAndCarry(active, [active, sibling], ['maxed'], () => {
      renew(active.dir, 'refresh-from-claude');
    });

    expect(carried).toEqual(['maxed']);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-from-claude');
  });

  it('takes the snapshot before the write, which is the whole reason it exists', () => {
    // If the snapshot moved below the write there would be no shared value left
    // to match on, and the sibling would be stranded holding a dead token. The
    // only way to see the difference is that the sibling IS updated here.
    const { renewed: active, sibling } = sharedPair();
    const seen: string[] = [];

    writeAndCarry(active, [active, sibling], ['maxed'], () => {
      seen.push(refreshTokenOf(sibling.dir)); // still the shared login at write time
      renew(active.dir, 'refresh-from-claude');
    });

    expect(seen).toEqual(['refresh-shared']);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-from-claude');
  });

  it('carries nothing when nobody shares the login', () => {
    const { home, renewed: active } = sharedPair();
    const stranger = profile(home, 'second', {
      accessToken: 'sk-other',
      refreshToken: 'refresh-someone-else',
      expiresAt: 5,
    });

    const carried = writeAndCarry(active, [active, stranger], [], () => {
      renew(active.dir, 'refresh-from-claude');
    });

    expect(carried).toEqual([]);
    expect(refreshTokenOf(stranger.dir)).toBe('refresh-someone-else');
  });

  it('lets a failed write through, so the caller decides what it means', () => {
    const { renewed: active, sibling } = sharedPair();
    expect(() =>
      writeAndCarry(active, [active, sibling], ['maxed'], () => {
        throw new Error('disk full');
      }),
    ).toThrow('disk full');
    // Nothing was carried, because there was no successful write to carry.
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-shared');
  });
});

describe('renewing a login and carrying it, as one operation', () => {
  it('carries the renewed login to the profiles that shared the old one', async () => {
    const { renewed: active, sibling } = sharedPair();

    const { result, carried } = await renewAndCarry(
      active,
      [active, sibling],
      ['maxed'],
      async () => {
        renew(active.dir, 'refresh-from-endpoint');
        return { status: 'refreshed' as const };
      },
    );

    expect(result.status).toBe('refreshed');
    expect(carried).toEqual(['maxed']);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-from-endpoint');
  });

  it('carries nothing when the renewal left the credential alone', async () => {
    // A renewal that was not needed changes no file. Copying it over identical
    // siblings would announce work that never happened.
    const { renewed: active, sibling } = sharedPair();

    const { carried } = await renewAndCarry(active, [active, sibling], ['maxed'], async () => ({
      status: 'not-needed' as const,
    }));

    expect(carried).toEqual([]);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-shared');
  });

  it('carries nothing when the renewal was refused', async () => {
    const { renewed: active, sibling } = sharedPair();

    const { carried } = await renewAndCarry(active, [active, sibling], ['maxed'], async () => ({
      status: 'needs-login' as const,
    }));

    expect(carried).toEqual([]);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-shared');
  });

  it('takes the snapshot before the renewal, across the await', async () => {
    // An ordering split across an await is even easier to get wrong than one
    // split across three statements, which is why this is one call.
    const { renewed: active, sibling } = sharedPair();
    const seenDuringRenewal: string[] = [];

    await renewAndCarry(active, [active, sibling], ['maxed'], async () => {
      seenDuringRenewal.push(refreshTokenOf(sibling.dir));
      renew(active.dir, 'refresh-from-endpoint');
      return { status: 'refreshed' as const };
    });

    expect(seenDuringRenewal).toEqual(['refresh-shared']);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-from-endpoint');
  });
});
