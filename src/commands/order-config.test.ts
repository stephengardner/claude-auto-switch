import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { orderCommand } from './order-config.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

function makeContext(): { c: CliContext; lines: string[]; home: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-order-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const lines: string[] = [];
  return { c: { ctx, config: loadConfig(ctx), out: (m) => lines.push(m), json: false, quiet: false }, lines, home };
}

describe('ccx order', () => {
  it('defaults to most-room (least-used)', () => {
    const { c } = makeContext();
    expect(c.config.rotation.accountOrder).toBe('most-room');
  });

  it('status describes the current mode without changing it', () => {
    const { c, lines, home } = makeContext();
    expect(orderCommand(c)).toBe(0);
    expect(lines.join('\n')).toContain('most-room');
    // Not written to disk on a status read.
    expect(loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: home } }).rotation.accountOrder).toBe('most-room');
  });

  it('switches to priority and persists it', () => {
    const { c, home } = makeContext();
    expect(orderCommand(c, 'priority')).toBe(0);
    expect(loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: home } }).rotation.accountOrder).toBe('priority');
  });

  it('switches back to most-room and persists it', () => {
    const { c, home } = makeContext();
    orderCommand(c, 'priority');
    // A fresh context reads priority from disk; switching back must persist.
    const c2 = { ...c, config: loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: home } }) };
    expect(orderCommand(c2, 'most-room')).toBe(0);
    expect(loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: home } }).rotation.accountOrder).toBe('most-room');
  });

  it('rejects an unknown mode', () => {
    const { c, home } = makeContext();
    expect(orderCommand(c, 'sideways')).toBe(1);
    expect(loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: home } }).rotation.accountOrder).toBe('most-room');
  });

  it('does not bake a temporary environment override into the file', () => {
    // A CAS_* override is effective for the process but must not be written to
    // disk by a read-modify-write of one setting.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-order-env-'));
    const env = { CLAUDE_AUTO_SWITCH_HOME: home, CAS_BROWSER_DEBUG_PORT: '9999' };
    const ctx = { env };
    const c: CliContext = { ctx, config: loadConfig(ctx), out: () => {}, json: false, quiet: false };
    // The effective config reflects the override...
    expect(c.config.browser.debugPort).toBe(9999);

    expect(orderCommand(c, 'priority')).toBe(0);

    // ...but the file holds only the change, not the env-derived port.
    const raw = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')) as {
      rotation?: { accountOrder?: string };
      browser?: { debugPort?: number };
    };
    expect(raw.rotation?.accountOrder).toBe('priority');
    expect(raw.browser?.debugPort).toBeUndefined();
  });
});
