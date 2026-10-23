import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import type { CliContext } from '../../src/context.js';
import { FAKE_ENV, PTY_AVAILABLE, fakeClaude, freshUsage, launches, readLog } from './typeable-claude.js';

/**
 * Which logins a running session keeps in step, and whether for good. One it
 * let go of after two minutes unasked would be read with `security` on the
 * thread that relays Claude the next time a decision asked about it. The
 * Keychain is a map here.
 */
const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock('../../src/accounts/keychain.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/accounts/keychain.js')>();
  const read = (dir: string): string | null => keychain.get(dir) ?? null;
  const write = (dir: string, text: string): void => {
    keychain.set(dir, text.trim());
  };
  const remove = (dir: string): void => {
    keychain.delete(dir);
  };
  return {
    ...real,
    readKeychainCredential: read,
    writeKeychainCredential: write,
    deleteKeychainCredential: remove,
    readKeychainCredentialAsync: async (dir: string) => read(dir),
    writeKeychainCredentialAsync: async (dir: string, text: string) => write(dir, text),
    deleteKeychainCredentialAsync: async (dir: string) => remove(dir),
  };
});
const watched = vi.hoisted(() => [] as Array<{ dir: string; pinned: boolean }>);
vi.mock('../../src/accounts/keychain-view.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/accounts/keychain-view.js')>();
  return {
    ...real,
    watchKeychain: () => {
      const watch = real.watchKeychain();
      return {
        watch: (dirs: string[], options?: { pinned?: boolean }) => {
          for (const dir of dirs) watched.push({ dir, pinned: options?.pinned === true });
          return watch.watch(dirs, options);
        },
        look: () => watch.look(),
        stop: () => watch.stop(),
      };
    },
  };
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await sleep(25);
}

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)('the logins a running session keeps in step', () => {
  afterEach(() => {
    for (const name of FAKE_ENV) delete process.env[name];
    watched.length = 0;
    keychain.clear();
  });

  it("keeps every account's login, one added while it runs included, for as long as Claude runs", { timeout: 60_000 }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-keychain-pins-'));
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
    const dirOf = (name: string): string => path.join(home, 'profiles', name);
    for (const name of ['A', 'B']) {
      await addCommand(context, name, { dir: dirOf(name), login: false });
      mkdirSync(dirOf(name), { recursive: true });
      writeFileSync(path.join(dirOf(name), '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
    }
    freshUsage(home, ['A', 'B']);
    setActive('A', ctx);
    const runsLog = path.join(home, 'runs.jsonl');
    const exitClaude = path.join(home, 'claude-exit');
    Object.assign(process.env, { FAKE_CLAUDE_RUNS_LOG: runsLog, FAKE_CLAUDE_IDLE_MS: '30000', FAKE_CLAUDE_EXIT_WHEN: exitClaude });

    const running = runCommand(context, []);
    await until(() => launches(readLog(runsLog)).length > 0, 30_000);
    // An account added while Claude runs, which the session's next look takes up.
    await addCommand(context, 'C', { dir: dirOf('C'), login: false });
    mkdirSync(dirOf('C'), { recursive: true });
    writeFileSync(path.join(dirOf('C'), '.credentials.json'), JSON.stringify({ account: 'C' }), 'utf8');
    await until(() => watched.some((w) => w.dir === dirOf('C')), 10_000);
    writeFileSync(exitClaude, '');
    expect(await running).toBe(0);

    for (const name of ['A', 'B', 'C']) {
      const of = watched.filter((w) => w.dir === dirOf(name));
      expect(of.length, name).toBeGreaterThan(0);
      expect(of.every((w) => w.pinned), name).toBe(true);
    }
    expect(existsSync(runsLog) && readFileSync(runsLog, 'utf8').length > 0).toBe(true);
  });
});
