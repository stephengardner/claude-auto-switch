import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { advanceActiveToHealthy } from './active-sync.js';
import { addAccount } from '../accounts/registry.js';
import { getActive, setActive } from './active.js';
import { saveLedger, markCapped } from '../ledger/ledger.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

function makeContext(): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-adv-')) } };
  return { ctx, config: loadConfig(ctx), out: () => {}, err: () => {}, json: false, quiet: false };
}

describe('advanceActiveToHealthy', () => {
  it('leaves the active account when it is still usable', () => {
    const c = makeContext();
    addAccount({ name: 'a', dir: '/a' }, c.ctx);
    addAccount({ name: 'b', dir: '/b' }, c.ctx);
    setActive('a', c.ctx);
    expect(advanceActiveToHealthy(c, new Set(['a', 'b']))).toBe('a');
    expect(getActive(c.ctx)).toBe('a');
  });

  it('advances to a healthy account when the active one is capped', () => {
    const c = makeContext();
    addAccount({ name: 'a', dir: '/a' }, c.ctx);
    addAccount({ name: 'b', dir: '/b' }, c.ctx);
    setActive('a', c.ctx);
    saveLedger(markCapped({ caps: [] }, { account: 'a', now: Date.now(), resetAt: null, backoffMinutes: 300 }), c.ctx);

    expect(advanceActiveToHealthy(c, new Set(['a', 'b']))).toBe('b');
    expect(getActive(c.ctx)).toBe('b');
  });

  it('stays put when no other healthy account exists', () => {
    const c = makeContext();
    addAccount({ name: 'a', dir: '/a' }, c.ctx);
    setActive('a', c.ctx);
    saveLedger(markCapped({ caps: [] }, { account: 'a', now: Date.now(), resetAt: null, backoffMinutes: 300 }), c.ctx);
    // a is capped and there is no alternative; active is unchanged.
    expect(advanceActiveToHealthy(c, new Set(['a']))).toBe('a');
    expect(getActive(c.ctx)).toBe('a');
  });
});
