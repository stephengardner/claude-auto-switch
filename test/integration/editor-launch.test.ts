import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { useCommand } from '../../src/commands/use.js';
import { editorLaunch } from '../../src/commands/editor-launch.js';
import { loadConfig } from '../../src/config/config.js';
import { getActive } from '../../src/state/active.js';
import { loadLedger } from '../../src/ledger/ledger.js';
import { rememberDeadLogin } from '../../src/usage/dead-login-store.js';
import { credentialFileFingerprint } from '../../src/accounts/credential-vault.js';
import type { CliContext } from '../../src/context.js';

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));

function makeContext(home: string): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
}

function seed(dir: string, opts: { capped?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), '{}', 'utf8'); // makes hasLogin true
  writeFileSync(
    path.join(dir, 'fake-scenario.json'),
    JSON.stringify({
      authStatus: { loggedIn: true, subscriptionType: 'max', email: 'x@y.com' },
      capped: opts.capped ?? false,
      capMessage: "You've reached your Fable 5 limit. Run /usage-credits to continue.",
      capExitCode: 1,
    }),
    'utf8',
  );
}

describe('editorLaunch (against fake-claude)', () => {
  it('runs on the active account and, on a cap, flips active to the next healthy one', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-'));
    const context = makeContext(home);
    const dirA = path.join(home, 'profiles', 'A');
    const dirB = path.join(home, 'profiles', 'B');
    await addCommand(context, 'A', { dir: dirA, login: false });
    await addCommand(context, 'B', { dir: dirB, login: false });
    seed(dirA, { capped: true }); // active account will hit its limit
    seed(dirB, { capped: false });
    useCommand(context, 'A');

    const exit = await editorLaunch(context, ['chat']);
    expect(exit).toBe(1); // the capped run's exit code passes through

    // A is recorded capped, and the active account has flipped to B for next time.
    expect(loadLedger(context.ctx).caps.map((c) => c.account)).toContain('A');
    expect(getActive(context.ctx)).toBe('B');
  });

  it('runs on the active account normally when it is not capped', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-'));
    const context = makeContext(home);
    const dirA = path.join(home, 'profiles', 'A');
    await addCommand(context, 'A', { dir: dirA, login: false });
    seed(dirA, { capped: false });
    useCommand(context, 'A');

    expect(await editorLaunch(context, ['chat'])).toBe(0);
    expect(getActive(context.ctx)).toBe('A'); // unchanged
    expect(loadLedger(context.ctx).caps).toHaveLength(0);
  });
});

describe('editorLaunch and a login the token endpoint has rejected', () => {
  /** A profile with a real login, plus a fake-claude that reports it signed in. */
  function seedReal(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-ant-x', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
      }),
      'utf8',
    );
    writeFileSync(
      path.join(dir, 'fake-scenario.json'),
      JSON.stringify({
        authStatus: { loggedIn: true, subscriptionType: 'max', email: 'x@y.com' },
        capped: false,
      }),
      'utf8',
    );
  }

  it('does not launch on it even when the health probe calls it signed in', async () => {
    // The gap this closes: the probe asks Claude whether the stored file LOOKS
    // signed in, and fake-claude says yes here, exactly as the real one would.
    // Only ccx knows the token endpoint refused this credential afterwards.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-dead-'));
    const context = makeContext(home);
    const dirDead = path.join(home, 'profiles', 'DEAD');
    const dirGood = path.join(home, 'profiles', 'GOOD');
    await addCommand(context, 'DEAD', { dir: dirDead, login: false });
    await addCommand(context, 'GOOD', { dir: dirGood, login: false });
    seedReal(dirDead);
    seedReal(dirGood);
    useCommand(context, 'DEAD');

    rememberDeadLogin(
      credentialFileFingerprint(dirDead),
      'token endpoint 400: invalid_grant',
      context.ctx,
    );

    await editorLaunch(context, ['chat']);
    expect(getActive(context.ctx)).toBe('GOOD');
  });
});
