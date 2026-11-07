import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CREDENTIAL_EVENT_REASONS,
  logCredentialEvent,
  readCredentialEvents,
} from './credential-log.js';

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

  it('lists each reason once', () => {
    expect(new Set(CREDENTIAL_EVENT_REASONS).size).toBe(CREDENTIAL_EVENT_REASONS.length);
  });
});
