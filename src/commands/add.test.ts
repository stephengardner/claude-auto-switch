import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCommand } from './add.js';
import { addAccount, listAccounts, getAccount } from '../accounts/registry.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

/**
 * `ccx add` is the path that actually creates duplicates: your browser is still
 * signed in to the account you added last, so a second `add` hands you the same
 * one. It used to run `claude auth login` directly, which meant the refusal in
 * `ccx login` did not apply to it at all.
 */

/** A stand-in for `claude auth login` that just writes a credential. */
function fakeLoginContext(lines: string[], owner: string | null): CliContext {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-add-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    // node writing a credential into CLAUDE_CONFIG_DIR: what a real login leaves.
    claude: {
      bin: process.execPath,
      prefixArgs: [
        '-e',
        'const fs=require("fs"),p=require("path");const d=process.env.CLAUDE_CONFIG_DIR;' +
          'fs.mkdirSync(d,{recursive:true});' +
          'fs.writeFileSync(p.join(d,".credentials.json"),JSON.stringify({claudeAiOauth:{accessToken:"at-new",refreshToken:"rt-new"}}));',
      ],
    },
    lookupOwner: () => Promise.resolve(owner),
    out: (m) => lines.push(m),
    json: false,
    quiet: false,
  };
}

describe('addCommand', () => {
  it('keeps a genuinely new account and records who it is', async () => {
    const lines: string[] = [];
    const c = fakeLoginContext(lines, 'fresh@example.com');

    expect(await addCommand(c, 'fresh')).toBe(0);
    expect(getAccount('fresh', c.ctx)?.email).toBe('fresh@example.com');
  });

  it('REFUSES a duplicate and does not keep the registration', async () => {
    const lines: string[] = [];
    const c = fakeLoginContext(lines, 'taken@example.com');
    // An account that already holds the login the browser will hand back.
    const existingDir = path.join(
      c.ctx.env?.CLAUDE_AUTO_SWITCH_HOME as string,
      'profiles',
      'work',
    );
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(
      path.join(existingDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at-work', refreshToken: 'rt-work' } }),
      'utf8',
    );
    addAccount({ name: 'work', dir: existingDir, enabled: true, email: 'taken@example.com' }, c.ctx);

    const exit = await addCommand(c, 'personal');

    expect(exit).toBe(1);
    expect(lines.join('\n')).toContain('REFUSED');
    // Back where you started: no half-registered profile left behind, and the
    // duplicate credential is not left sitting there active.
    expect(listAccounts(c.ctx).map((a) => a.name)).toEqual(['work']);
    const personalDir = path.join(
      c.ctx.env?.CLAUDE_AUTO_SWITCH_HOME as string,
      'profiles',
      'personal',
    );
    expect(existsSync(path.join(personalDir, '.credentials.json'))).toBe(false);
  });

  it('skips the whole check when there is no login to check (--no-login)', async () => {
    const lines: string[] = [];
    let looked = false;
    const c = fakeLoginContext(lines, 'anyone@example.com');
    c.lookupOwner = () => {
      looked = true;
      return Promise.resolve('anyone@example.com');
    };
    expect(await addCommand(c, 'later', { login: false })).toBe(0);
    expect(looked).toBe(false);
    expect(listAccounts(c.ctx).map((a) => a.name)).toEqual(['later']);
  });
});
