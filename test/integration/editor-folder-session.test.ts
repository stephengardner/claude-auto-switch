import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { workerCommand, type WorkerIo } from '../../src/commands/worker.js';
import { editorCommand } from '../../src/commands/editor.js';
import { setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import { processIsAlive } from '../../src/session/lease.js';
import type { CliContext } from '../../src/context.js';

/**
 * Every Claude ccx runs in a terminal or as a worker is in a folder of its own,
 * the user's Claude but for the login, made by one piece of code; and a
 * terminal session and the editor's folder, which never ends, keep each other
 * in step: the login they share, and the user's files.
 *
 * The Keychain is a map here, never the real one.
 */

const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock('../../src/accounts/keychain.js', () => ({
  keychainService: (dir: string) => `Claude Code-credentials-${dir}`,
  readKeychainCredential: vi.fn((dir: string) => keychain.get(dir) ?? null),
  writeKeychainCredential: vi.fn((dir: string, text: string) => {
    keychain.set(dir, text);
  }),
  deleteKeychainCredential: vi.fn((dir: string) => {
    keychain.delete(dir);
  }),
}));

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const HOURS = 3_600_000;
const emailOf = (name: string): string => `${name.toLowerCase()}@example.com`;
/** A login of `name`'s, generation `gen`, which the fake claude reports as `marker`. */
const login = (name: string, marker: string, gen: number, expiresAt = Date.now() + (8 + gen) * HOURS): string =>
  JSON.stringify({
    account: marker,
    claudeAiOauth: { accessToken: `a-${name}-${gen}`, refreshToken: `r-${name}-${gen}`, expiresAt },
  });
const tokenOf = (text: string | null): string | null => {
  try {
    return (JSON.parse(text ?? '') as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
};
const read = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const json = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(done: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!done() && Date.now() < until) await settle(25);
}
const isRealFolder = (dir: string): boolean => {
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

interface Folder {
  configDir: string | null;
  projects: string | null;
  skills: string | null;
  settings: Record<string, unknown>;
  email: string | null;
}
interface Entry {
  type: string;
  marker?: string | null;
  folder?: Folder;
}

interface Sandbox {
  home: string;
  context: CliContext;
  runsLog: string;
  folder: string;
  dirOf: (name: string) => string;
}

async function sandbox(names: string[]): Promise<Sandbox> {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-session-'));
  const runsLog = path.join(home, 'runs.jsonl');
  process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData') } };
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap: () => Promise.resolve('allowed' as const),
    isClaudeProcess: processIsAlive,
    // Who a login belongs to, as the API would say: by the account its token was made for.
    lookupOwner: (dir) => {
      const match = /^a-([A-Za-z]+)-/.exec(tokenOf(read(path.join(dir, '.credentials.json'))) ?? '');
      return Promise.resolve(match ? emailOf(match[1]!) : null);
    },
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
  const dirOf = (name: string): string => path.join(home, 'profiles', name);
  for (const name of names) {
    await addCommand(context, name, { dir: dirOf(name), login: false, email: emailOf(name) });
    writeFileSync(path.join(dirOf(name), '.credentials.json'), login(name, `${name}1`, 1));
    writeFileSync(
      path.join(dirOf(name), '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: emailOf(name), accountUuid: `uuid-${name}` } }),
    );
  }
  setActive(names[0]!, ctx);
  mkdirSync(path.join(home, '.claude', 'skills', 'mine'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'fable' }, null, 2));
  writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
  return { home, context, runsLog, folder: path.join(home, 'editor-active'), dirOf };
}

const entries = (runsLog: string): Entry[] =>
  existsSync(runsLog)
    ? readFileSync(runsLog, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Entry)
    : [];
const launches = (runsLog: string): Entry[] => entries(runsLog).filter((e) => e.type === 'launch');

/** `ccx editor on`, and the folder it gives the editor. */
async function editorOn(s: Sandbox): Promise<void> {
  expect(editorCommand(s.context, 'on')).toBe(0);
  await waitFor(() => isRealFolder(s.folder) && tokenOf(read(path.join(s.folder, '.credentials.json'))) !== null);
  expect(isRealFolder(s.folder)).toBe(true);
}

const TOUCHED = ['FAKE_CLAUDE_RUNS_LOG', 'FAKE_CLAUDE_IDLE_MS', 'FAKE_CLAUDE_LOG_FOLDER'];

describe('every folder ccx runs Claude in, made by one piece of code', () => {
  afterEach(() => {
    for (const name of TOUCHED) delete process.env[name];
    vi.unstubAllGlobals();
    keychain.clear();
  });

  /** What a folder of ccx's holds: the user's projects, skills and settings, and the account's identity. */
  const expectAccountFolder = (s: Sandbox, folder: Folder | undefined): void => {
    expect(path.dirname(folder?.configDir ?? '')).toBe(realpathSync(path.join(s.home, 'sessions')));
    expect(folder?.projects).toBe(realpathSync(path.join(s.home, '.claude', 'projects')));
    expect(folder?.skills).toBe(realpathSync(path.join(s.home, '.claude', 'skills')));
    expect(folder?.settings).toEqual({ model: 'fable' });
    expect(folder?.email).toBe('a@example.com');
  };

  it("runs a terminal session in a folder of its own: your projects, skills and settings, and its account's login", { timeout: 60_000 }, async () => {
    const s = await sandbox(['A']);
    process.env.FAKE_CLAUDE_LOG_FOLDER = '1';
    process.env.FAKE_CLAUDE_IDLE_MS = '300';
    expect(await runCommand(s.context, [])).toBe(0);
    const [launch] = launches(s.runsLog);
    expectAccountFolder(s, launch?.folder);
    expect(launch?.marker).toBe('A1');
  });

  it('runs a worker in a folder of its own, made the same way', { timeout: 60_000 }, async () => {
    const s = await sandbox(['A']);
    process.env.FAKE_CLAUDE_LOG_FOLDER = '1';
    const io: WorkerIo = { stdout: () => {}, stderr: () => {}, signals: new EventEmitter() };
    expect(await workerCommand(s.context, ['hi'], {}, [], io)).toBe(0);
    const [launch] = launches(s.runsLog);
    expectAccountFolder(s, launch?.folder);
    expect(launch?.marker).toBe('A1');
  });

  it('takes up, in a terminal session on the account the editor is on, a renewal the editor made while both run', { timeout: 60_000 }, async () => {
    const s = await sandbox(['A', 'B']);
    await editorOn(s);
    process.env.FAKE_CLAUDE_IDLE_MS = '16000';
    const running = runCommand(s.context, []);
    await waitFor(() => launches(s.runsLog).length > 0, 15_000);
    // The editor's Claude renews the login it holds, in its own folder.
    writeFileSync(path.join(s.folder, '.credentials.json'), login('A', 'A-renewed', 2));
    expect(await running).toBe(0);

    expect(isRealFolder(s.folder)).toBe(true);
    expect(tokenOf(read(path.join(s.dirOf('A'), '.credentials.json')))).toBe('a-A-2');
    expect(entries(s.runsLog).filter((e) => e.type === 'reread').pop()?.marker).toBe('A-renewed');
  });

  it("carries a renewal a terminal session's Claude made into the editor's folder, which held the login it replaced", { timeout: 60_000 }, async () => {
    const s = await sandbox(['A']);
    await editorOn(s);
    // Who a login belongs to, as the API says when the session's mirror asks.
    vi.stubGlobal('fetch', (url: unknown) =>
      Promise.resolve(
        String(url).includes('oauth/profile')
          ? new Response(JSON.stringify({ account: { email_address: 'a@example.com' } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('{}', { status: 500 }),
      ),
    );
    process.env.FAKE_CLAUDE_IDLE_MS = '6000';
    const running = runCommand(s.context, []);
    await waitFor(() => launches(s.runsLog).length > 0, 15_000);
    // The session's Claude renews the login in its own folder.
    writeFileSync(path.join(s.home, 'sessions', String(process.pid), '.credentials.json'), login('A', 'A2', 2));
    expect(await running).toBe(0);

    expect(isRealFolder(s.folder)).toBe(true);
    expect(tokenOf(read(path.join(s.dirOf('A'), '.credentials.json')))).toBe('a-A-2');
    expect(tokenOf(read(path.join(s.folder, '.credentials.json')))).toBe('a-A-2');
  });

  it('takes home, at a session start, a renewal the editor made rather than renew the token it retired', { timeout: 60_000 }, async () => {
    const s = await sandbox(['A']);
    // Due for renewal in the profile, and renewed by the editor's Claude in its folder.
    writeFileSync(path.join(s.dirOf('A'), '.credentials.json'), login('A', 'A1', 1, Date.now() + 60_000));
    await editorOn(s);
    writeFileSync(path.join(s.folder, '.credentials.json'), login('A', 'A-renewed', 2));
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: unknown) => {
      asked.push(String(url));
      return Promise.resolve(new Response('{}', { status: 500 }));
    });
    process.env.FAKE_CLAUDE_IDLE_MS = '300';

    expect(await runCommand(s.context, [])).toBe(0);

    expect(isRealFolder(s.folder)).toBe(true);
    expect(asked.filter((url) => url.includes('oauth/token'))).toEqual([]);
    expect(launches(s.runsLog)[0]?.marker).toBe('A-renewed');
  });

  it('takes home, at a worker start, a renewal the editor made rather than renew the token it retired', { timeout: 60_000 }, async () => {
    const s = await sandbox(['A']);
    writeFileSync(path.join(s.dirOf('A'), '.credentials.json'), login('A', 'A1', 1, Date.now() + 60_000));
    await editorOn(s);
    writeFileSync(path.join(s.folder, '.credentials.json'), login('A', 'A-renewed', 2));
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: unknown) => {
      asked.push(String(url));
      return Promise.resolve(new Response('{}', { status: 500 }));
    });
    const io: WorkerIo = { stdout: () => {}, stderr: () => {}, signals: new EventEmitter() };

    expect(await workerCommand(s.context, ['hi'], {}, [], io)).toBe(0);

    expect(isRealFolder(s.folder)).toBe(true);
    expect(asked.filter((url) => url.includes('oauth/token'))).toEqual([]);
    expect(launches(s.runsLog)[0]?.marker).toBe('A-renewed');
  });

  it('brings the editor folder into step with your files at a terminal session start', { timeout: 60_000 }, async () => {
    const s = await sandbox(['A']);
    await editorOn(s);
    const theirs = path.join(s.folder, 'settings.json');
    writeFileSync(theirs, JSON.stringify({ ...json(theirs), model: 'sonnet' }, null, 2));
    process.env.FAKE_CLAUDE_IDLE_MS = '600';

    expect(await runCommand(s.context, [])).toBe(0);
    await waitFor(() => json(path.join(s.home, '.claude', 'settings.json')).model === 'sonnet');

    expect(json(path.join(s.home, '.claude', 'settings.json')).model).toBe('sonnet');
  });
});
