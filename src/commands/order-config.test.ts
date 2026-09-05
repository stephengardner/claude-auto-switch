import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
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
});
