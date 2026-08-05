import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logCredentialEvent, readCredentialEvents } from './credential-log.js';

function ctx(): { env: { CLAUDE_AUTO_SWITCH_HOME: string } } {
  return { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-credlog-')) } };
}

describe('a repeated credential event', () => {
  it('collapses for DISPLAY while every line stays in the file', () => {
    // This is an audit trail, so nothing is rewritten. The run is folded only
    // when read, which is what stops one repeated line pushing the useful
    // entries off `ccx history` exactly when it is being read.
    const c = ctx();
    logCredentialEvent({ account: 'work', kind: 'renewed', at: 500 }, c);
    for (let i = 0; i < 40; i += 1) {
      logCredentialEvent({ account: 'main', kind: 'needs-login', detail: 'invalid_grant', at: 1000 + i }, c);
    }

    const events = readCredentialEvents(50, c);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('renewed');
    expect(events[1]?.count).toBe(40);
    // Time shown is the most recent occurrence: "is this still happening".
    expect(events[1]?.at).toBe(1039);

    // The file is untouched, which is the property that makes this safe.
    const home = c.env.CLAUDE_AUTO_SWITCH_HOME;
    const lines = readFileSync(path.join(home, 'credential-log.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(41);
  });

  it('does not merge different accounts, kinds or details', () => {
    const c = ctx();
    logCredentialEvent({ account: 'a', kind: 'needs-login', detail: 'x', at: 1 }, c);
    logCredentialEvent({ account: 'b', kind: 'needs-login', detail: 'x', at: 2 }, c);
    logCredentialEvent({ account: 'b', kind: 'renewed', at: 3 }, c);
    logCredentialEvent({ account: 'b', kind: 'needs-login', detail: 'y', at: 4 }, c);
    expect(readCredentialEvents(50, c)).toHaveLength(4);
  });

  it('only merges CONSECUTIVE repeats, so the order is preserved', () => {
    const c = ctx();
    logCredentialEvent({ account: 'a', kind: 'needs-login', detail: 'x', at: 1 }, c);
    logCredentialEvent({ account: 'b', kind: 'renewed', at: 2 }, c);
    logCredentialEvent({ account: 'a', kind: 'needs-login', detail: 'x', at: 3 }, c);
    expect(readCredentialEvents(50, c).map((e) => e.account)).toEqual(['a', 'b', 'a']);
  });

  it('counts the LIMIT in things that happened, not copies of one', () => {
    const c = ctx();
    for (let i = 0; i < 30; i += 1) {
      logCredentialEvent({ account: 'main', kind: 'needs-login', detail: 'x', at: i }, c);
    }
    logCredentialEvent({ account: 'work', kind: 'renewed', at: 99 }, c);
    expect(readCredentialEvents(5, c).map((e) => e.account)).toEqual(['main', 'work']);
  });
});

describe('credential log', () => {
  it('records events in order and reads them back', () => {
    const c = ctx();
    logCredentialEvent({ account: 'work', kind: 'renewed', at: 1000 }, c);
    logCredentialEvent({ account: 'work', kind: 'needs-login', detail: 'invalid_grant', at: 2000 }, c);

    const events = readCredentialEvents(50, c);
    expect(events.map((e) => e.kind)).toEqual(['renewed', 'needs-login']);
    expect(events[1]?.detail).toBe('invalid_grant');
    expect(events[1]?.at).toBe(2000);
  });

  it('never stores a token, only what happened', () => {
    const c = ctx();
    logCredentialEvent({ account: 'work', kind: 'renewed' }, c);
    const file = path.join(c.env.CLAUDE_AUTO_SWITCH_HOME, 'credential-log.jsonl');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('renewed');
    expect(text).not.toMatch(/accessToken|refreshToken|sk-ant/);
  });

  it('returns the most recent entries when there are more than asked for', () => {
    const c = ctx();
    for (let i = 0; i < 10; i++) logCredentialEvent({ account: `a${i}`, kind: 'renewed', at: i }, c);
    const events = readCredentialEvents(3, c);
    expect(events.map((e) => e.account)).toEqual(['a7', 'a8', 'a9']);
  });

  it('survives a truncated or corrupt line', () => {
    const c = ctx();
    logCredentialEvent({ account: 'good', kind: 'renewed' }, c);
    const file = path.join(c.env.CLAUDE_AUTO_SWITCH_HOME, 'credential-log.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"at":1,"acc\n`, 'utf8');
    expect(readCredentialEvents(50, c).map((e) => e.account)).toEqual(['good']);
  });

  it('reads as empty when nothing has been recorded, and never throws', () => {
    expect(readCredentialEvents(50, ctx())).toEqual([]);
    expect(() =>
      logCredentialEvent({ account: 'x', kind: 'renewed' }, { env: { CLAUDE_AUTO_SWITCH_HOME: '' } }),
    ).not.toThrow();
  });
});
