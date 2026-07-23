import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadless } from './launcher.js';

const fakeClaude = fileURLToPath(
  new URL('../../test/fake-claude/fake-claude.mjs', import.meta.url),
);
const invoker = { bin: process.execPath, prefixArgs: [fakeClaude] };

function accountDir(scenario?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-headless-'));
  if (scenario !== undefined) {
    writeFileSync(path.join(dir, 'fake-scenario.json'), JSON.stringify(scenario), 'utf8');
  }
  return dir;
}

describe('launchHeadless', () => {
  it('classifies a normal run as ok and captures stdout', async () => {
    const r = await launchHeadless(['-p', 'hi'], { name: 'a', dir: accountDir() }, { claude: invoker });
    expect(r.classification.kind).toBe('ok');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('fake-claude ran');
  });

  it('classifies a capped run as capped', async () => {
    const dir = accountDir({ capped: true, capMessage: 'Usage limit reached.', capExitCode: 1 });
    const r = await launchHeadless(['-p', 'hi'], { name: 'a', dir }, { claude: invoker });
    expect(r.classification.kind).toBe('capped');
  });
});
