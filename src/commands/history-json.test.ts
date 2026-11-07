import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { historyCommand } from './history.js';
import { logCredentialEvent } from '../accounts/credential-log.js';
import { appendEvent } from '../events/log.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';
import type { CredentialEvent } from '../accounts/credential-log.js';
import type { SwitchEvent } from '../events/switch-events.js';

function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-history-json-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const lines: string[] = [];
  const context = {
    ctx,
    config: loadConfig(ctx),
    out: (m: string) => lines.push(m),
    err: () => {},
    json: true,
    quiet: false,
  } as unknown as CliContext;
  const read = () => {
    lines.length = 0;
    expect(historyCommand(context)).toBe(0);
    return JSON.parse(lines.join('\n')) as {
      schemaVersion: number;
      credentialEvents: CredentialEvent[];
      switchEvents: SwitchEvent[];
    };
  };
  return { home, ctx, read };
}

describe('`ccx history --json`', () => {
  it('gives the login events with their reasons and the moves as values, beside each other', () => {
    const { home, ctx, read } = setup();
    logCredentialEvent({ account: 'a', kind: 'renewed', reason: 'idle-renewal', at: 10 }, ctx);
    appendEvent(home, 'a sentence', 20, { kind: 'cap-relief', data: { from: 'a', to: 'b' } });
    appendEvent(home, 'another sentence', 30);

    const history = read();
    expect(history.schemaVersion).toBe(1);
    expect(history.credentialEvents).toEqual([
      { at: 10, account: 'a', kind: 'renewed', reason: 'idle-renewal' },
    ]);
    expect(history.switchEvents).toEqual([
      { at: 20, kind: 'moved', from: 'a', to: 'b', reason: 'capacity', v: expect.any(String) },
    ]);
  });

  it('answers with empty lists on a machine where nothing has happened', () => {
    const { read } = setup();
    expect(read()).toEqual({ schemaVersion: 1, credentialEvents: [], switchEvents: [] });
  });
});
