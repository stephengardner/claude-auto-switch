import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { statuslineCommand } from './statusline.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

function setup(active: string | null, usage?: Record<string, unknown>): { context: CliContext; lines: string[] } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-status-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  if (active) writeFileSync(path.join(home, 'active.json'), JSON.stringify({ active }), 'utf8');
  if (usage) {
    writeFileSync(path.join(home, 'usage-snapshot.json'), JSON.stringify({ accounts: usage }), 'utf8');
  }
  const lines: string[] = [];
  return {
    lines,
    context: { ctx, config: loadConfig(ctx), out: (m) => lines.push(m), json: false, quiet: false },
  };
}

const entry = (over: Record<string, unknown>) => ({
  fiveHour: null,
  sevenDay: null,
  fiveHourReset: null,
  sevenDayReset: null,
  at: Date.now(),
  ...over,
});

describe('statuslineCommand', () => {
  it('shows the account and the window closest to its limit', () => {
    const { context, lines } = setup('work', {
      work: entry({ fiveHour: 0.1, sevenDay: 0.62, models: [{ name: 'Fable', utilization: 0.78 }] }),
    });
    expect(statuslineCommand(context)).toBe(0);
    // Not the hour or the week: the model window is what would stop you.
    expect(lines[0]).toContain('work');
    expect(lines[0]).toContain('Fable 78%');
  });

  it('warns once the binding window is nearly (or fully) spent', () => {
    const { context, lines } = setup('work', {
      work: entry({ fiveHour: 0, sevenDay: 0, models: [{ name: 'Fable', utilization: 1 }] }),
    });
    statuslineCommand(context);
    expect(lines[0]?.startsWith('!')).toBe(true);
  });

  it('stays quiet and useful when usage is unknown', () => {
    const { context, lines } = setup('work');
    statuslineCommand(context);
    expect(lines[0]).toBe('· work');
  });

  it('says so when no account is selected', () => {
    const { context, lines } = setup(null);
    statuslineCommand(context);
    expect(lines[0]).toContain('no account selected');
  });

  it('prints the settings snippet with --install', () => {
    const { context, lines } = setup('work');
    statuslineCommand(context, { install: true });
    expect(lines.join('\n')).toContain('"statusLine"');
    expect(lines.join('\n')).toContain('ccx statusline');
  });
});
