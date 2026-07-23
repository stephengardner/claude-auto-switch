import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './launcher.js';

const fakeClaude = fileURLToPath(
  new URL('../../test/fake-claude/fake-claude.mjs', import.meta.url),
);
const invoker = { bin: process.execPath, prefixArgs: [fakeClaude] };

function accountDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cas-launch-'));
}

describe('launch', () => {
  it('runs claude with CLAUDE_CONFIG_DIR set to the account dir and passes args', async () => {
    const dir = accountDir();
    const result = await launch(['-p', 'hi'], { name: 'acct', dir }, { claude: invoker });
    expect(result.exitCode).toBe(0);

    const record = JSON.parse(readFileSync(path.join(dir, 'fake-last-run.json'), 'utf8'));
    expect(record.configDir).toBe(dir);
    expect(record.args).toEqual(['-p', 'hi']);
  });

  it('propagates the child exit code', async () => {
    const dir = accountDir();
    writeFileSync(
      path.join(dir, 'fake-scenario.json'),
      JSON.stringify({ capped: true, capExitCode: 7 }),
      'utf8',
    );
    const result = await launch(['-p', 'hi'], { name: 'acct', dir }, { claude: invoker });
    expect(result.exitCode).toBe(7);
  });
});
