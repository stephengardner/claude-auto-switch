import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gettingStarted, homeCommand } from './home.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

function context(lines: string[]): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-home-')) } };
  return { ctx, config: loadConfig(ctx), out: (m) => lines.push(m), json: false, quiet: false };
}

describe('gettingStarted', () => {
  it('names the tool and the three first steps', () => {
    const g = gettingStarted();
    expect(g).toContain('claude-auto-switch');
    expect(g).toContain('ccx add');
    expect(g).toContain('ccx run');
    expect(g).toContain('ccx dashboard');
  });
});

describe('homeCommand', () => {
  it('shows the getting-started guide when there are no accounts', async () => {
    const lines: string[] = [];
    const code = await homeCommand(context(lines));
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Get started:');
  });
});
