import { describe, it, expect } from 'vitest';
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  MAX_BUNDLE_BYTES,
  buildLendBundle,
  buildRevokeBundle,
  containsRefreshToken,
  lentCredentialText,
  parseBundle,
  serializeBundle,
} from './bundle.js';
import { LENT_MARKER, lentLoginFromText } from './lent-login.js';
import { LendError } from '../util/errors.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function ownerLogin(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'at-owner-secret',
      refreshToken: 'rt-owner-secret',
      expiresAt: NOW + 6 * HOUR,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      ...extra,
    },
  });
}

/** What parseBundle threw, which every refusal here must be. */
function refusalOf(text: string, now = NOW): LendError {
  try {
    parseBundle(text, now);
  } catch (error) {
    expect(error).toBeInstanceOf(LendError);
    return error as LendError;
  }
  throw new Error('the bundle was accepted');
}

function lendJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    kind: 'lend',
    account: 'work',
    issuedAt: NOW,
    claudeAiOauth: { accessToken: 'at-lent', expiresAt: NOW + HOUR },
    ...overrides,
  };
}

describe('the bundle an owner lends a login in', () => {
  it('carries the access token and its expiry, and never the refresh token', () => {
    const bundle = buildLendBundle({ account: 'work', credential: ownerLogin(), now: NOW });
    const sent = serializeBundle(bundle);
    expect(bundle.claudeAiOauth.accessToken).toBe('at-owner-secret');
    expect(bundle.claudeAiOauth.expiresAt).toBe(NOW + 6 * HOUR);
    expect(sent).not.toContain('rt-owner-secret');
    expect(sent).not.toMatch(/refresh/i);
  });

  it('copies only the fields it knows are safe to lend', () => {
    // A field Claude adds later is not lent until ccx is taught it is safe.
    const bundle = buildLendBundle({
      account: 'work',
      credential: ownerLogin({ idToken: 'id-secret', futureField: 'x' }),
      now: NOW,
    });
    expect(Object.keys(bundle.claudeAiOauth).sort()).toEqual([
      'accessToken',
      'expiresAt',
      'scopes',
      'subscriptionType',
    ]);
    expect(serializeBundle(bundle)).not.toContain('id-secret');
  });

  it("carries who the account is, from the owner's identity and registration", () => {
    const bundle = buildLendBundle({
      account: 'work',
      email: 'work@example.com',
      credential: ownerLogin(),
      oauthAccount: { emailAddress: 'work@example.com', accountUuid: 'u-1' },
      now: NOW,
    });
    expect(bundle).toMatchObject({
      format: 'ccx-lend',
      version: 1,
      kind: 'lend',
      account: 'work',
      email: 'work@example.com',
      issuedAt: NOW,
      oauthAccount: { emailAddress: 'work@example.com', accountUuid: 'u-1' },
    });
  });

  it('refuses to lend a login that is itself lent', () => {
    const lent = JSON.stringify({
      claudeAiOauth: { accessToken: 'at', expiresAt: NOW + HOUR },
      [LENT_MARKER]: { version: 1 },
    });
    expect(() => buildLendBundle({ account: 'work', credential: lent, now: NOW })).toThrow(
      /is lent to this machine/,
    );
  });

  it('refuses a login with no access token, or no expiry, naming the account and no value', () => {
    const signedOut = JSON.stringify({
      claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 },
    });
    expect(() => buildLendBundle({ account: 'work', credential: signedOut, now: NOW })).toThrow(
      /"work" has no signed-in login/,
    );
    const undated = JSON.stringify({
      claudeAiOauth: { accessToken: 'at-x', refreshToken: 'rt-x' },
    });
    expect(() => buildLendBundle({ account: 'work', credential: undated, now: NOW })).toThrow(
      /does not say when it expires/,
    );
  });

  it('refuses rather than send an identity that names a refresh token', () => {
    let message = '';
    try {
      buildLendBundle({
        account: 'work',
        credential: ownerLogin(),
        oauthAccount: { refreshToken: 'rt-hidden' },
        now: NOW,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/refresh token/);
    expect(message).not.toContain('rt-hidden');
  });
});

describe('reading a bundle on the receiving machine', () => {
  it('reads back exactly what was lent', () => {
    const bundle = buildLendBundle({
      account: 'work',
      email: 'w@example.com',
      credential: ownerLogin(),
      now: NOW,
    });
    expect(parseBundle(serializeBundle(bundle), NOW)).toEqual(bundle);
  });

  it('refuses a refresh token wherever it is, by name or by its shape', () => {
    const cases = [
      lendJson({
        claudeAiOauth: { accessToken: 'at', expiresAt: NOW + HOUR, refreshToken: 'rt-1' },
      }),
      lendJson({ oauthAccount: { nested: [{ refresh_token: 'rt-2' }] } }),
      lendJson({ oauthAccount: { innocent: 'sk-ant-ort01-made-up' } }),
    ];
    for (const raw of cases) {
      const error = refusalOf(JSON.stringify(raw));
      expect(error.message).toMatch(/carries a refresh token/);
      expect(error.message).not.toMatch(/rt-1|rt-2|sk-ant-ort01/);
    }
  });

  it('refuses text that is not JSON without repeating it, since it can hold a token', () => {
    const error = refusalOf('{"claudeAiOauth": {"accessToken": "at-pasted-secret", oops');
    expect(error.message).toMatch(/not valid JSON/);
    expect(error.message).not.toContain('at-pasted-secret');
  });

  it('refuses another format, and a newer version with what to do about it', () => {
    expect(refusalOf(JSON.stringify({ ...lendJson(), format: 'something-else' })).message).toMatch(
      /not a ccx lend bundle/,
    );
    expect(refusalOf(JSON.stringify({ ...lendJson(), version: 2 })).message).toMatch(
      /version 2.*update ccx here/,
    );
    const unversioned = lendJson();
    delete unversioned.version;
    expect(refusalOf(JSON.stringify(unversioned)).message).toMatch(/no version/);
  });

  it('refuses a malformed field by naming where it is, never its value', () => {
    const noToken = refusalOf(
      JSON.stringify(lendJson({ claudeAiOauth: { expiresAt: NOW + HOUR } })),
    );
    expect(noToken.message).toMatch(/claudeAiOauth\.accessToken/);
    const badExpiry = refusalOf(
      JSON.stringify(lendJson({ claudeAiOauth: { accessToken: 'at-value', expiresAt: 'soon' } })),
    );
    expect(badExpiry.message).toMatch(/claudeAiOauth\.expiresAt/);
    expect(badExpiry.message).not.toContain('at-value');
  });

  it('refuses a lend that has already expired', () => {
    const error = refusalOf(
      JSON.stringify(lendJson({ claudeAiOauth: { accessToken: 'at', expiresAt: NOW - 1 } })),
    );
    expect(error.message).toMatch(/already expired/);
  });

  it('refuses an account name that could not be a folder name', () => {
    expect(refusalOf(JSON.stringify(lendJson({ account: '../escape' }))).message).toMatch(
      /names an account ccx cannot use/,
    );
  });

  it('refuses anything larger than a bundle can be, before reading it', () => {
    expect(refusalOf('x'.repeat(MAX_BUNDLE_BYTES + 1)).message).toMatch(
      /larger than any lend bundle/,
    );
  });

  it('reads a bundle that takes a lend back', () => {
    const revoke = buildRevokeBundle('work', NOW);
    expect(parseBundle(serializeBundle(revoke), NOW)).toEqual({
      format: 'ccx-lend',
      version: 1,
      kind: 'revoke',
      account: 'work',
      issuedAt: NOW,
    });
  });

  it('drops a field it does not know rather than install it', () => {
    const raw = lendJson({
      claudeAiOauth: { accessToken: 'at', expiresAt: NOW + HOUR, notYetKnown: 'x' },
    });
    const bundle = parseBundle(JSON.stringify(raw), NOW);
    expect(bundle.kind === 'lend' && 'notYetKnown' in bundle.claudeAiOauth).toBe(false);
  });
});

describe('the credential a receiver keeps', () => {
  it("is Claude's own shape, marked as lent, with no refresh token", () => {
    const bundle = buildLendBundle({ account: 'work', credential: ownerLogin(), now: NOW });
    const text = lentCredentialText(bundle);
    const parsed = JSON.parse(text) as Record<string, Record<string, unknown>>;
    expect(parsed.claudeAiOauth).toEqual(bundle.claudeAiOauth);
    expect(parsed[LENT_MARKER]).toEqual({ version: 1, issuedAt: NOW });
    expect(text).not.toMatch(/refresh/i);
    expect(lentLoginFromText(text)).toEqual({ expiresAt: NOW + 6 * HOUR });
  });
});

describe('looking for a refresh token', () => {
  it('counts a structure nested deeper than any bundle as one, rather than search half of it', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i++) deep = { inner: deep };
    expect(containsRefreshToken(deep)).toBe(true);
    expect(containsRefreshToken({ a: [{ b: 'plain' }] })).toBe(false);
  });
});
