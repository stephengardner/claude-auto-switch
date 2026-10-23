import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  LENT_HINT_FILE,
  LENT_MARKER,
  lendMarginMs,
  lendUnavailable,
  lendUsable,
  lentLoginFromText,
  lentLoginIn,
} from './lent-login.js';
import { HOUR, MINUTE, machine, writeConfig } from '../../test/lending-fixtures.js';

const NOW = 1_800_000_000_000;

function lentText(oauth: Record<string, unknown>): string {
  return JSON.stringify({ claudeAiOauth: oauth, [LENT_MARKER]: { version: 1, issuedAt: NOW } });
}

/** A profile folder holding `text` as its login, with the hint a lend import writes beside it unless told not to. */
function profile(text: string, { hint = true } = {}): string {
  const dir = path.join(machine().home, 'profiles', 'work');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), text, 'utf8');
  if (hint) writeFileSync(path.join(dir, LENT_HINT_FILE), '{}\n', 'utf8');
  return dir;
}

describe('recognising a lent login by what it holds', () => {
  it('is the marker beside an access token, with no refresh token', () => {
    expect(lentLoginFromText(lentText({ accessToken: 'at', expiresAt: NOW + HOUR }))).toEqual({
      expiresAt: NOW + HOUR,
    });
  });

  it('is not lent once a sign-in made here has given it a refresh token, whatever else the file keeps', () => {
    expect(
      lentLoginFromText(
        lentText({ accessToken: 'at', refreshToken: 'rt-own', expiresAt: NOW + HOUR }),
      ),
    ).toBeNull();
  });

  it('is not lent without the marker, or without an access token, or when it is not JSON', () => {
    expect(
      lentLoginFromText(JSON.stringify({ claudeAiOauth: { accessToken: 'at', expiresAt: NOW } })),
    ).toBeNull();
    expect(lentLoginFromText(lentText({ accessToken: '', expiresAt: NOW }))).toBeNull();
    expect(lentLoginFromText('not json')).toBeNull();
  });

  it('reads a lend that names no expiry as expiring at 0, so it is never picked', () => {
    expect(lentLoginFromText(lentText({ accessToken: 'at' }))).toEqual({ expiresAt: 0 });
  });
});

describe("a profile folder's lent login", () => {
  it('is found where a lend import put it', () => {
    expect(lentLoginIn(profile(lentText({ accessToken: 'at', expiresAt: NOW + HOUR })))).toEqual({
      expiresAt: NOW + HOUR,
    });
  });

  it('is looked for only beside the hint, so an ordinary account costs one look at its folder', () => {
    expect(
      lentLoginIn(profile(lentText({ accessToken: 'at', expiresAt: NOW + HOUR }), { hint: false })),
    ).toBeNull();
  });

  it('is gone once the folder holds a login of its own, even with the hint left behind', () => {
    const own = JSON.stringify({
      claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + HOUR },
    });
    expect(lentLoginIn(profile(own))).toBeNull();
  });
});

describe('the expiry margin', () => {
  it('is ten minutes on a machine with no lending section', () => {
    expect(lendMarginMs(machine().ctx)).toBe(10 * MINUTE);
  });

  it("is the receiver's own lending.expiryMarginMinutes, read again when config.json changes", () => {
    const m = machine();
    writeConfig(m, { lending: { expiryMarginMinutes: 30 } });
    expect(lendMarginMs(m.ctx)).toBe(30 * MINUTE);
    writeConfig(m, { lending: { expiryMarginMinutes: 5, renewAheadMinutes: 60 } });
    expect(lendMarginMs(m.ctx)).toBe(5 * MINUTE);
  });

  it('falls back to the default when config.json does not load, so the rule still holds', () => {
    const m = machine();
    writeFileSync(path.join(m.home, 'config.json'), '{ not json', 'utf8');
    expect(lendMarginMs(m.ctx)).toBe(10 * MINUTE);
  });

  it('takes a lend out of use once that close to its end, and puts nothing else out', () => {
    const ctx = machine().ctx;
    const soon = profile(lentText({ accessToken: 'at', expiresAt: NOW + 9 * MINUTE }));
    const later = profile(lentText({ accessToken: 'at', expiresAt: NOW + 11 * MINUTE }));
    const gone = profile(lentText({ accessToken: 'at', expiresAt: NOW - MINUTE }));
    const own = profile(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW - HOUR },
      }),
    );
    expect(lendUnavailable(soon, ctx, NOW)).toBe(true);
    expect(lendUnavailable(later, ctx, NOW)).toBe(false);
    expect(lendUnavailable(gone, ctx, NOW)).toBe(true);
    // An expired login of this machine's own is for the renewal to deal with, not this rule.
    expect(lendUnavailable(own, ctx, NOW)).toBe(false);
    expect(lendUsable({ expiresAt: NOW + 10 * MINUTE }, 10 * MINUTE, NOW)).toBe(false);
  });
});
