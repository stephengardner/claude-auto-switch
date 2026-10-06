import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/config.js';
import { addAccount } from '../accounts/registry.js';
import { getActive } from '../state/active.js';
import { readSwitchRequest } from '../state/switch-request.js';
import { useCommand } from './use.js';
import type { CliContext } from '../context.js';
import type { SessionLease } from '../session/lease.js';

function setup(): { context: CliContext; said: string[] } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-use-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const said: string[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: 'claude', prefixArgs: [] },
    out: (m: string) => said.push(m),
    err: () => {},
    json: false,
    quiet: false,
  };
  for (const name of ['a', 'b']) addAccount({ name, dir: path.join(home, name) }, ctx);
  return { context, said };
}

const lease = (pid: number, account: string, cwd: string): SessionLease => ({
  pid,
  account,
  configDir: `/s/${pid}`,
  cwd,
  at: 1,
});

describe('ccx use without naming a session', () => {
  it('with nothing running, only sets the account new sessions start on', () => {
    const { context } = setup();
    expect(useCommand(context, 'b', {}, () => [])).toBe(0);
    expect(getActive(context.ctx)).toBe('b');
    expect(readSwitchRequest(context.ctx)).toBeNull();
  });

  it('moves the only running session, by a request addressed to it', () => {
    const { context } = setup();
    expect(useCommand(context, 'b', {}, () => [lease(4242, 'a', '/w/api')])).toBe(0);
    expect(readSwitchRequest(context.ctx, 4242)).toMatchObject({ account: 'b', mode: 'seamless' });
    // Never the shared request, which whichever session looked first would take.
    expect(readSwitchRequest(context.ctx)).toBeNull();
  });

  it('with several running, moves none and says how to pick', () => {
    const { context, said } = setup();
    const running = [lease(11, 'a', '/w/api'), lease(12, 'a', '/w/web')];
    expect(useCommand(context, 'b', {}, () => running)).toBe(0);
    expect(getActive(context.ctx)).toBe('b');
    expect(readSwitchRequest(context.ctx, 11)).toBeNull();
    expect(readSwitchRequest(context.ctx, 12)).toBeNull();
    expect(said.join('\n')).toContain('2 sessions are running, so none was moved');
    expect(said.join('\n')).toContain('ccx use b --session <pid>');
  });

  it('with --all, moves every one not already there, each by its own request', () => {
    const { context } = setup();
    const running = [lease(11, 'a', '/w/api'), lease(12, 'b', '/w/web'), lease(13, 'a', '/w/cli')];
    expect(useCommand(context, 'b', { all: true, now: true }, () => running)).toBe(0);
    expect(readSwitchRequest(context.ctx, 11)).toMatchObject({ account: 'b', mode: 'restart' });
    expect(readSwitchRequest(context.ctx, 12)).toBeNull();
    expect(readSwitchRequest(context.ctx, 13)).toMatchObject({ account: 'b', mode: 'restart' });
  });
});
