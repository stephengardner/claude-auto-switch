import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWatched } from './launcher.js';

const fakeClaude = fileURLToPath(
  new URL('../../test/fake-claude/fake-claude.mjs', import.meta.url),
);
const invoker = { bin: process.execPath, prefixArgs: [fakeClaude] };

function accountDir(scenario?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-watched-'));
  if (scenario !== undefined) {
    writeFileSync(path.join(dir, 'fake-scenario.json'), JSON.stringify(scenario), 'utf8');
  }
  return dir;
}

describe('launchWatched', () => {
  it('detects a cap from stderr during a session', async () => {
    const dir = accountDir({ capped: true, capMessage: 'Usage limit reached.', capExitCode: 1 });
    const r = await launchWatched(['-p', 'hi'], { name: 'a', dir }, { claude: invoker });
    expect(r.classification.kind).toBe('capped');
    expect(r.exitCode).toBe(1);
  });

  it('classifies a normal session as ok', async () => {
    const r = await launchWatched(['chat'], { name: 'a', dir: accountDir() }, { claude: invoker });
    expect(r.classification.kind).toBe('ok');
    expect(r.exitCode).toBe(0);
  });
});
