import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CREDENTIAL_EVENT_REASONS,
  logCredentialEvent,
  needsLoginReason,
  readCredentialEvents,
  type WrittenCredentialReason,
} from './credential-log.js';
import { mkdirSync } from 'node:fs';
import { renewIdleLogin } from '../usage/usage-store.js';

function ctx() {
  return { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-credreason-')) } };
}

/** Lines as an older ccx wrote them, with no reason, straight into the file. */
function writeLines(c: ReturnType<typeof ctx>, records: object[]): void {
  writeFileSync(
    path.join(c.env.CLAUDE_AUTO_SWITCH_HOME, 'credential-log.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
}

describe('why a credential event happened', () => {
  it('is recorded by the writer and read back as written', () => {
    const c = ctx();
    logCredentialEvent(
      { account: 'a', kind: 'refused', detail: 'any words at all', reason: 'session-using-it' },
      c,
    );
    const [event] = readCredentialEvents(10, c);
    expect(event?.reason).toBe('session-using-it');
  });

  it('is worked out for a record written before ccx recorded one, from what it wrote then', () => {
    const c = ctx();
    const cases: Array<[object, string]> = [
      [{ kind: 'renewed' }, 'idle-renewal'],
      [
        { kind: 'renewed', detail: 'expired login renewed before starting' },
        'renewed-before-start',
      ],
      [
        {
          kind: 'installed',
          detail:
            'shares a login with "main", which was just renewed; carried across so this one keeps working',
        },
        'carried-shared-login',
      ],
      [
        {
          kind: 'installed',
          detail:
            'the stored login was renewed elsewhere; carried into this running session so its next refresh cannot die on the retired one',
        },
        'carried-into-session',
      ],
      [
        {
          kind: 'installed',
          detail:
            'the stored login was dead, but the live session (pid 42) holds a working one for this account; adopted it instead of asking for a sign-in',
        },
        'adopted-from-session',
      ],
      [
        { kind: 'installed', detail: 'a renewal kept when its save failed, saved now' },
        'kept-renewal-saved',
      ],
      [
        {
          kind: 'installed',
          detail: 'the stored login was renewed elsewhere; carried into the editor',
        },
        'carried-into-editor',
      ],
      [
        { kind: 'installed', detail: 'the editor renewed this login; saved home' },
        'saved-from-editor',
      ],
      [{ kind: 'needs-login', detail: 'invalid_grant: account_on_hold' }, 'on-hold'],
      [{ kind: 'needs-login', detail: 'no stored login' }, 'no-login'],
      [{ kind: 'needs-login', detail: 'invalid_grant' }, 'renewal-refused'],
      [{ kind: 'renew-failed', detail: 'renewal unavailable' }, 'renewal-unavailable'],
      [
        {
          kind: 'refused',
          detail: 'not renewed: a session is using main; renewing would sign it out',
        },
        'session-using-it',
      ],
      [
        {
          kind: 'refused',
          detail:
            'not renewed: your editor is pointed at a profile that shares this login and may be using it',
        },
        'editor-may-be-using-it',
      ],
      [
        {
          kind: 'refused',
          detail:
            "not renewed: your editor holds a newer copy of this login, which ccx could not yet confirm is this account's",
        },
        'editor-copy-unconfirmed',
      ],
      [
        {
          kind: 'rolled-back',
          detail: 'the stored login had been saved cut short; put back the one kept before it',
        },
        'saved-cut-short',
      ],
      [
        { kind: 'signed-out', detail: 'session had no login; left the stored one alone' },
        'session-had-no-login',
      ],
    ];
    writeLines(
      c,
      cases.map(([record], i) => ({ at: i, account: `a${i}`, ...record })),
    );
    expect(readCredentialEvents(100, c).map((e) => e.reason)).toEqual(
      cases.map(([, reason]) => reason),
    );
  });

  it('is unknown, never a guess, for a record it cannot place', () => {
    const c = ctx();
    writeLines(c, [
      { at: 1, account: 'a', kind: 'refused', detail: 'some wording no ccx wrote' },
      { at: 2, account: 'b', kind: 'renewed', detail: 'a sentence from a future ccx' },
      { at: 3, account: 'c', kind: 'not-a-kind' },
    ]);
    expect(readCredentialEvents(10, c).map((e) => e.reason)).toEqual([
      'unknown',
      'unknown',
      'unknown',
    ]);
  });

  it('ignores a stored value that is not a reason, and works one out instead', () => {
    const c = ctx();
    writeLines(c, [{ at: 1, account: 'a', kind: 'renew-failed', reason: 'made-up', detail: 'x' }]);
    expect(readCredentialEvents(10, c)[0]?.reason).toBe('renewal-unavailable');
  });

  it('keeps two events with different reasons apart when folding repeats', () => {
    const c = ctx();
    logCredentialEvent(
      { account: 'a', kind: 'needs-login', detail: 'x', reason: 'renewal-refused', at: 1 },
      c,
    );
    logCredentialEvent(
      { account: 'a', kind: 'needs-login', detail: 'x', reason: 'on-hold', at: 2 },
      c,
    );
    expect(readCredentialEvents(10, c).map((e) => e.reason)).toEqual([
      'renewal-refused',
      'on-hold',
    ]);
  });

  it('reads every reason a writer can record back as written, whatever the words beside it', () => {
    const c = ctx();
    const written = CREDENTIAL_EVENT_REASONS.filter(
      (r): r is WrittenCredentialReason => r !== 'unknown',
    );
    // Words the decoder for older records cannot place, so only the stored value can answer.
    written.forEach((reason, i) =>
      logCredentialEvent({ account: `a${i}`, kind: 'refused', detail: `x${i}`, reason }, c),
    );
    expect(readCredentialEvents(100, c).map((e) => e.reason)).toEqual(written);
  });

  it('says why a login has to be signed in again by one rule', () => {
    expect(needsLoginReason('invalid_grant: account_on_hold', true)).toBe('on-hold');
    expect(needsLoginReason('see claude.ai/restricted', false)).toBe('on-hold');
    expect(needsLoginReason('invalid_grant', true)).toBe('renewal-refused');
    expect(needsLoginReason(undefined, true)).toBe('renewal-refused');
    expect(needsLoginReason('no stored login', false)).toBe('no-login');
  });

  it('is on-hold or refused, as the renewal says, when a usage refresh renews a login', async () => {
    for (const [detail, reason] of [
      ['invalid_grant: account_on_hold', 'on-hold'],
      ['invalid_grant', 'renewal-refused'],
    ] as const) {
      const c = ctx();
      const dir = path.join(c.env.CLAUDE_AUTO_SWITCH_HOME, 'profiles', 'a');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 't' } }),
        'utf8',
      );
      const account = { name: 'a', dir };
      await renewIdleLogin(account, [account], c, {
        renew: () => Promise.resolve({ status: 'needs-login', detail }),
        editorAccount: null,
      });
      expect(readCredentialEvents(10, c).map((e) => [e.kind, e.reason])).toEqual([
        ['needs-login', reason],
      ]);
    }
  });

  it('publishes exactly these reasons: a reader depends on each, so none leaves without a schema change', () => {
    expect([...CREDENTIAL_EVENT_REASONS]).toEqual([
      'idle-renewal',
      'renewed-before-start',
      'carried-shared-login',
      'carried-into-session',
      'adopted-from-session',
      'kept-renewal-saved',
      'carried-into-editor',
      'saved-from-editor',
      'on-hold',
      'renewal-refused',
      'no-login',
      'renewal-unavailable',
      'session-using-it',
      'editor-may-be-using-it',
      'editor-copy-unconfirmed',
      'saved-cut-short',
      'session-had-no-login',
      'unknown',
    ]);
  });

  it('lists each reason once', () => {
    expect(new Set(CREDENTIAL_EVENT_REASONS).size).toBe(CREDENTIAL_EVENT_REASONS.length);
  });
});
