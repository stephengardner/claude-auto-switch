import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe, probeAll, type ProbeableAccount } from './prober.js';

const fakeClaude = fileURLToPath(
  new URL('../../test/fake-claude/fake-claude.mjs', import.meta.url),
);
const invoker = { bin: process.execPath, prefixArgs: [fakeClaude] };

function seedAccount(scenario: unknown): ProbeableAccount {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-acct-'));
  writeFileSync(path.join(dir, 'fake-scenario.json'), JSON.stringify(scenario), 'utf8');
  return { name: path.basename(dir), dir };
}

describe('probe', () => {
  it('reports a logged-in account with plan and email', async () => {
    const acct = seedAccount({
      authStatus: { loggedIn: true, email: 'a@b.com', subscriptionType: 'max' },
    });
    const result = await probe(acct, { claude: invoker, now: () => 123 });
    expect(result.loggedIn).toBe(true);
    expect(result.plan).toBe('max');
    expect(result.email).toBe('a@b.com');
    expect(result.checkedAt).toBe(123);
  });

  it('reports a logged-out account', async () => {
    const acct = seedAccount({ authStatus: { loggedIn: false, authMethod: 'none' } });
    const result = await probe(acct, { claude: invoker });
    expect(result.loggedIn).toBe(false);
  });

  it('probes multiple accounts in parallel', async () => {
    const a = seedAccount({ authStatus: { loggedIn: true, subscriptionType: 'max' } });
    const b = seedAccount({ authStatus: { loggedIn: false } });
    const results = await probeAll([a, b], { claude: invoker });
    expect(results.map((r) => r.loggedIn).sort()).toEqual([false, true]);
  });
});
