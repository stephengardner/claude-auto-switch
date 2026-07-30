import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAccountIdentities } from './identity-check.js';
import { credentialPath } from './credential-vault.js';

/** A profile dir holding `token`, claiming to be `claims`. */
function profile(token: string | null, claims?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-ident-'));
  writeFileSync(
    credentialPath(dir),
    JSON.stringify({ claudeAiOauth: { accessToken: token ?? '' } }),
    'utf8',
  );
  if (claims) {
    writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: claims } }),
      'utf8',
    );
  }
  return dir;
}

/** Maps a bearer token to the account it belongs to. */
function apiFor(owners: Record<string, string>): typeof fetch {
  return (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    const auth = init?.headers?.authorization ?? '';
    const token = auth.replace('Bearer ', '');
    const email = owners[token];
    if (!email) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ account: { email_address: email } }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('verifyAccountIdentities', () => {
  it('confirms a profile whose token belongs to the account it claims', async () => {
    const findings = await verifyAccountIdentities(
      [{ name: 'work', dir: profile('t-work', 'work@example.com') }],
      apiFor({ 't-work': 'work@example.com' }),
    );
    expect(findings[0]).toMatchObject({ account: 'work', kind: 'ok', actual: 'work@example.com' });
  });

  it('CATCHES a profile holding someone else\'s login', async () => {
    // The exact failure that scrambled real profiles: the config says one
    // account, the stored token belongs to another.
    const findings = await verifyAccountIdentities(
      [{ name: 'personal', dir: profile('t-other', 'personal@example.com') }],
      apiFor({ 't-other': 'someone.else@example.com' }),
    );
    expect(findings[0]?.kind).toBe('mismatch');
    expect(findings[0]?.detail).toContain('someone.else@example.com');
    expect(findings[0]?.detail).toContain('ccx login personal');
  });

  it('prefers the registered address over what the profile claims', async () => {
    const findings = await verifyAccountIdentities(
      [{ name: 'work', dir: profile('t1', 'stale@example.com'), email: 'registered@example.com' }],
      apiFor({ t1: 'registered@example.com' }),
    );
    expect(findings[0]?.kind).toBe('ok');
  });

  it('CATCHES two profiles sharing one login', async () => {
    const findings = await verifyAccountIdentities(
      [
        { name: 'a', dir: profile('same-token', 'a@example.com') },
        { name: 'b', dir: profile('same-token', 'b@example.com') },
      ],
      apiFor({ 'same-token': 'a@example.com' }),
    );
    expect(findings[0]?.kind).toBe('ok');
    expect(findings[1]?.kind).toBe('duplicate');
    expect(findings[1]?.detail).toContain('"a"');
    // The message has to say what is at stake, not just that it is a duplicate:
    // renewing one of them ends the other, which is how two accounts were lost.
    expect(findings[1]?.detail).toContain('renewing either would end the other');
  });

  it('reports an empty credential as logged out, not as a mismatch', async () => {
    const findings = await verifyAccountIdentities(
      [{ name: 'dead', dir: profile(null, 'dead@example.com') }],
      apiFor({}),
    );
    expect(findings[0]?.kind).toBe('logged-out');
  });

  it('says unknown (never mismatch) when the account cannot be confirmed', async () => {
    const offline = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const findings = await verifyAccountIdentities(
      [{ name: 'work', dir: profile('t1', 'work@example.com') }],
      offline,
    );
    expect(findings[0]?.kind).toBe('unknown');
  });
});
