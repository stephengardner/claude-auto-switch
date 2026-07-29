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
  it('reports the room LEFT on the window that runs out first', async () => {
    const { context, lines } = setup('work', {
      work: entry({ fiveHour: 0.1, sevenDay: 0.62, models: [{ name: 'Fable', utilization: 0.78 }] }),
    });
    expect(await statuslineCommand(context)).toBe(0);
    // Not the hour or the week: the model window is what would stop you. And it
    // says what remains, because a bare "78%" reads as plenty when it is not.
    expect(lines[0]).toBe('work Fable 22% left');
  });

  it('says "spent" and shows the reset once a window is exhausted', async () => {
    const { context, lines } = setup('work', {
      work: entry({
        fiveHour: 0,
        sevenDay: 0,
        models: [{ name: 'Fable', utilization: 1, resetsAt: Date.now() + 2 * 3600_000 }],
      }),
    });
    await statuslineCommand(context);
    expect(lines[0]).toContain('Fable spent');
    expect(lines[0]).toContain('resets 2h');
    expect(lines[0]?.startsWith('!')).toBe(true);
  });

  it('keeps the reset time out of the way while there is room', async () => {
    const { context, lines } = setup('work', {
      work: entry({ fiveHour: 0.2, sevenDay: 0.1, fiveHourReset: Date.now() + 3600_000 }),
    });
    await statuslineCommand(context);
    expect(lines[0]).toBe('work 5h 80% left');
    expect(lines[0]).not.toContain('resets');
  });

  it('omits the account name with --compact (when your line already shows it)', async () => {
    const { context, lines } = setup('work', {
      work: entry({ fiveHour: 0.25, sevenDay: 0.1 }),
    });
    await statuslineCommand(context, { compact: true });
    expect(lines[0]).toBe('5h 75% left');
  });

  it('stays quiet and useful when usage is unknown', async () => {
    const { context, lines } = setup('work');
    await statuslineCommand(context);
    expect(lines[0]).toBe('work');
  });

  it('says so when no account is selected', async () => {
    const { context, lines } = setup(null);
    await statuslineCommand(context);
    expect(lines[0]).toContain('no account');
  });

  it('prints the settings snippet with --install', async () => {
    const { context, lines } = setup('work');
    await statuslineCommand(context, { install: true });
    expect(lines.join('\n')).toContain('"statusLine"');
    expect(lines.join('\n')).toContain('ccx statusline');
  });
});
