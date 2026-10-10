import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { writeSwitchRequest } from '../../src/state/switch-request.js';
import { loadConfig } from '../../src/config/config.js';
import { sessionDirFor } from '../../src/session/session-dir.js';
import type { CliContext } from '../../src/context.js';
import { PTY_AVAILABLE, fakeClaude, readLog, waitFor } from './typeable-claude.js';

/**
 * A login moved under a running Claude is only used once Claude reads it
 * again. Claude keeps the login it read for up to 30 seconds and drops it
 * early only when the time of `.credentials.json` in its folder changes, and
 * a login that lives in the macOS Keychain is replaced without touching that
 * file. So every move in place ends by changing that file's time. The fake
 * cannot hold a login in the Keychain, so this checks that the nudge is made,
 * after the login is replaced; the nudge itself is tested on its own.
 */

const nudged = vi.hoisted(() => [] as Array<{ dir: string; at: number }>);
vi.mock('../../src/accounts/credential-vault.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/accounts/credential-vault.js')>();
  return {
    ...real,
    nudgeLoginReread: (dir: string, now?: Date) => {
      nudged.push({ dir, at: Date.now() });
      real.nudgeLoginReread(dir, now);
    },
  };
});

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)('a login moved under a running Claude', () => {
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_IDLE_MS;
    delete process.env.FAKE_CLAUDE_RUNS_LOG;
  });

  it('is followed by a nudge to read it again', { timeout: 60_000 }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-login-reread-'));
    const runsLog = path.join(home, 'runs.jsonl');
    Object.assign(process.env, { FAKE_CLAUDE_IDLE_MS: '2500', FAKE_CLAUDE_RUNS_LOG: runsLog });
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
    const context: CliContext = {
      ctx,
      config: loadConfig(ctx),
      claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
      verifyCap: () => Promise.resolve('allowed'),
      out: () => {},
      err: () => {},
      json: false,
      quiet: false,
    };
    for (const name of ['A', 'B']) {
      const dir = path.join(home, 'profiles', name);
      await addCommand(context, name, { dir, login: false });
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
    }
    setActive('A', context.ctx);

    const running = runCommand(context, []);
    await waitFor(
      'the launch',
      () => readLog(runsLog),
      (log) => log.some((e) => e.type === 'launch'),
    );
    const asked = Date.now();
    writeSwitchRequest('B', asked, 'seamless', context.ctx, process.pid);
    expect(await running).toBe(0);

    const sessionDir = sessionDirFor(process.pid, context.ctx);
    // Moved in place (one launch), and nudged after the move was asked for.
    expect(readLog(runsLog).filter((e) => e.type === 'launch')).toHaveLength(1);
    expect(
      readLog(runsLog)
        .filter((e) => e.type === 'reread')
        .pop()?.marker,
    ).toBe('B');
    expect(nudged.filter((n) => n.dir === sessionDir && n.at >= asked)).toHaveLength(1);
  });
});
