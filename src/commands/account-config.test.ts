import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enableCommand, disableCommand, priorityCommand } from './account-config.js';
import { addAccount, getAccount } from '../accounts/registry.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

function makeContext(): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-cfg-cmd-')) } };
  return { ctx, config: loadConfig(ctx), out: () => {}, json: false, quiet: false };
}

describe('account config commands', () => {
  it('disables and re-enables an account', () => {
    const c = makeContext();
    addAccount({ name: 'a', dir: '/a' }, c.ctx);
    expect(disableCommand(c, 'a')).toBe(0);
    expect(getAccount('a', c.ctx)?.enabled).toBe(false);
    expect(enableCommand(c, 'a')).toBe(0);
    expect(getAccount('a', c.ctx)?.enabled).toBe(true);
  });

  it('sets an integer priority', () => {
    const c = makeContext();
    addAccount({ name: 'a', dir: '/a' }, c.ctx);
    expect(priorityCommand(c, 'a', '5')).toBe(0);
    expect(getAccount('a', c.ctx)?.priority).toBe(5);
  });

  it('rejects a non-integer priority and an unknown account', () => {
    const c = makeContext();
    addAccount({ name: 'a', dir: '/a' }, c.ctx);
    expect(priorityCommand(c, 'a', 'x')).toBe(1);
    expect(enableCommand(c, 'missing')).toBe(1);
  });
});
