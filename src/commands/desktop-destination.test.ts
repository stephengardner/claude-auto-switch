import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { destinationFor } from './desktop.js';
import { addAccount } from '../accounts/registry.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

/**
 * Where a conversation leaving Claude Desktop goes, judged for the model it
 * will carry on with: an account whose Fable week is spent cannot take a
 * conversation on Fable, however much else it has.
 */
function setup(): CliContext {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-desk-dest-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  for (const name of ['desktop', 'fable-spent', 'fresh-ish']) {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }));
    addAccount({ name, dir }, ctx);
  }
  const now = Date.now();
  const window = (fiveHour: number, sevenDay: number, fable: number) => ({
    fiveHour,
    sevenDay,
    fiveHourReset: now + 3_600_000,
    sevenDayReset: now + 100 * 3_600_000,
    models: [{ name: 'Fable', utilization: fable, resetsAt: now + 100 * 3_600_000 }],
    at: now,
  });
  writeFileSync(
    path.join(home, 'usage-snapshot.json'),
    JSON.stringify({
      accounts: {
        desktop: window(1, 0.5, 0.5),
        // The most runway on Opus, but its Fable week is spent.
        'fable-spent': window(0, 0.1, 1),
        'fresh-ish': window(0.4, 0.2, 0.2),
      },
    }),
  );
  return {
    ctx,
    config: loadConfig(ctx),
    out: () => {},
    json: false,
    quiet: false,
  };
}

describe("a Desktop conversation's destination", () => {
  it('goes where its own model has room', () => {
    const context = setup();
    expect(destinationFor(context, 'desktop', 'claude-fable-5[1m]')).toBe('fresh-ish');
  });

  it('goes to the account with the longest run for a conversation on Opus', () => {
    const context = setup();
    expect(destinationFor(context, 'desktop', 'claude-opus-5-5')).toBe('fable-spent');
  });

  it('judges by the preferred model when the conversation names none', () => {
    const context = setup();
    // Opus by default.
    expect(destinationFor(context, 'desktop', null)).toBe('fable-spent');
  });
});
