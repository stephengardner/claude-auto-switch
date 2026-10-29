import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../commands/add.js';
import { useCommand } from '../commands/use.js';
import { editorCommand } from '../commands/editor.js';
import { editorLaunch } from '../commands/editor-launch.js';
import { setActive } from '../state/active.js';
import { loadConfig } from '../config/config.js';
import { sha256Fingerprint } from '../util/fingerprint.js';
import { installEditorEnvVar, readEditorEnvVar, uninstallEditorEnvVar } from './install.js';
import { queueEditorCarry, readEditorRecord, retryEditorCarries } from './folder-login.js';
import { readTarget, setTarget } from '../daemon/junction.js';
import { refreshCredentialIfExpired } from '../usage/oauth-refresh.js';
import { renewIdleLogin } from '../usage/usage-store.js';
import { listAccounts } from '../accounts/registry.js';
import { credentialFileFingerprint, loginTextFingerprint } from '../accounts/credential-vault.js';
import { rememberDeadLogin } from '../usage/dead-login-store.js';
import { readKeychainCredential } from '../accounts/keychain.js';
import type { CliContext } from '../context.js';
import {
  editorChatsOpen,
  editorStanding,
  refreshEditor,
  retireEditor,
  setUpEditor,
  takeUpEditorRenewal,
} from './folder.js';
import { acquireOwnedLock } from '../claude/locks.js';
import { noteEditorChat } from './editor-chats.js';

/**
 * The editor's Claude folder, end to end through the commands that set it up
 * and switch it: `ccx editor on|off` and `ccx use`, and the renewals that touch
 * the login it holds. The Keychain is a map here, never the real one; it is
 * keyed by the folder exactly as Claude names its item, by the text it was
 * given.
 */

const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock('../accounts/keychain.js', () => {
  const read = vi.fn((dir: string) => keychain.get(dir) ?? null);
  const write = vi.fn((dir: string, text: string) => {
    keychain.set(dir, text);
  });
  const remove = vi.fn((dir: string) => {
    keychain.delete(dir);
  });
  return {
    keychainService: (dir: string) => `Claude Code-credentials-${dir}`,
    readKeychainCredential: read,
    writeKeychainCredential: write,
    deleteKeychainCredential: remove,
    // Off the thread, the same Keychain: what a test stages on the blocking form holds here too.
    readKeychainCredentialAsync: async (dir: string) => read(dir),
    writeKeychainCredentialAsync: async (dir: string, text: string) => write(dir, text),
    deleteKeychainCredentialAsync: async (dir: string) => remove(dir),
  };
});

const fakeClaude = fileURLToPath(
  new URL('../../test/fake-claude/fake-claude.mjs', import.meta.url),
);
const HOURS = 3_600_000;
const emailOf = (name: string): string => `${name.toLowerCase()}@example.com`;
/** A login of `name`'s, generation `gen`: a renewal is the next generation, with a later expiry. */
const login = (name: string, gen: number, expiresAt = Date.now() + (8 + gen) * HOURS): string =>
  JSON.stringify({
    account: `${name}${gen}`,
    claudeAiOauth: { accessToken: `a-${name}-${gen}`, refreshToken: `r-${name}-${gen}`, expiresAt },
  });
const tokenOf = (text: string | null | undefined): string | null => {
  try {
    return (JSON.parse(text ?? '') as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
};
/** Sign-ins to other services (`claude mcp login`), which Claude keeps in the same text as the account's login. */
const mcpLogins = (n: number) => ({
  'notion|1': {
    serverName: 'notion',
    accessToken: `mcp-access-fake-${n}`,
    refreshToken: `mcp-refresh-fake-${n}`,
    expiresAt: 1_900_000_000_000 + n,
  },
});
const MCP = mcpLogins(1);
/** What a store that ended earlier parked in an account's saved login: it expires before the folder's own. */
const PARKED = mcpLogins(0);
/** A Notion sign-in expiring at `expiresAt`, a later expiry being a later refresh, tokens named by `by`. */
const notionExpiring = (expiresAt: number, by: string) => ({
  'notion|1': {
    serverName: 'notion',
    accessToken: `mcp-access-fake-${by}`,
    refreshToken: `mcp-refresh-fake-${by}`,
    expiresAt,
  },
});
/** Sign-ins to a second server, so a merge per server can be told from one that replaces the lot. */
const datadogLogins = (n: number) => ({
  'datadog|2': {
    serverName: 'datadog',
    accessToken: `dd-access-fake-${n}`,
    refreshToken: `dd-refresh-fake-${n}`,
  },
});
const withMcp = (text: string, mcpOAuth: unknown = MCP): string =>
  JSON.stringify({ ...(JSON.parse(text) as object), mcpOAuth });
const mcpOf = (text: string | null | undefined): unknown => {
  try {
    return (JSON.parse(text ?? '') as { mcpOAuth?: unknown }).mcpOAuth;
  } catch {
    return undefined;
  }
};
/** Who a login belongs to, as the API would say: by the account its token was made for. */
const ownerOf = (text: string): string | null => {
  const match = /^a-([A-Za-z]+)-/.exec(tokenOf(text) ?? '');
  return match ? emailOf(match[1]!) : null;
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
async function waitFor(done: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!done() && Date.now() < until) await settle(25);
}
/** A real folder at the editor's path, ccx's own: not the old link to an account's folder. */
const isRealFolder = (dir: string): boolean => {
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

interface Scene {
  home: string;
  ccx: string;
  folder: string;
  context: CliContext;
  dirOf: (name: string) => string;
  /** A path in the user's own ~/.claude. */
  user: (rel: string) => string;
}

async function scene(names: string[] = ['A', 'B'], platform?: NodeJS.Platform): Promise<Scene> {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-folder-'));
  const ccx = path.join(home, 'ccx');
  const ctx = {
    env: { CLAUDE_AUTO_SWITCH_HOME: ccx, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData') },
    ...(platform ? { platform } : {}),
  };
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
    lookupOwner: (dir) => Promise.resolve(ownerOf(readFileSync(path.join(dir, '.credentials.json'), 'utf8'))),
  };
  const dirOf = (name: string): string => path.join(ccx, 'profiles', name);
  for (const name of names) {
    await addCommand(context, name, { dir: dirOf(name), login: false, email: emailOf(name) });
    writeFileSync(path.join(dirOf(name), '.credentials.json'), login(name, 1));
    writeFileSync(
      path.join(dirOf(name), '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: emailOf(name), accountUuid: `uuid-${name}` }, userID: `user-${name}` }),
    );
  }
  setActive(names[0]!, ctx);
  // The user's own Claude.
  const user = (rel: string): string => path.join(home, '.claude', rel);
  mkdirSync(user(path.join('skills', 'mine')), { recursive: true });
  writeFileSync(user(path.join('skills', 'mine', 'SKILL.md')), 'mine');
  writeFileSync(user('settings.json'), JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] } }, null, 2));
  writeFileSync(user('CLAUDE.md'), 'my memory');
  writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', mcpServers: { mine: { command: 'mine' } } }),
  );
  return { home, ccx, folder: path.join(ccx, 'editor-active'), context, dirOf, user };
}

/** `ccx editor on`, and the folder it gives the editor. */
async function editorOn(s: Scene): Promise<void> {
  expect(await editorCommand(s.context, 'on')).toBe(0);
  await waitFor(() => isRealFolder(s.folder) && tokenOf(read(path.join(s.folder, '.credentials.json'))) !== null);
  expect(isRealFolder(s.folder)).toBe(true);
}

/** `ccx use <name>`, which moves the editor and brings its folder into step; done once `until` holds. */
async function use(s: Scene, name: string, until: () => boolean = () => true): Promise<void> {
  expect(useCommand(s.context, name, {}, () => [])).toBe(0);
  await waitFor(until);
  // Whatever else it set off has finished.
  await settle(150);
}

const folderLogin = (s: Scene): string | null => read(path.join(s.folder, '.credentials.json'));
const profileLogin = (s: Scene, name: string): string | null => read(path.join(s.dirOf(name), '.credentials.json'));

/** Run `step` while the Keychain item named after the editor's folder cannot be read, as a locked Keychain refuses. */
async function whileUnreadable<T>(
  s: Scene,
  step: () => Promise<T>,
  unreadable: string = s.folder,
): Promise<T> {
  vi.mocked(readKeychainCredential).mockImplementation((dir: string) => {
    if (dir === unreadable) throw new Error('Could not read the profile login from macOS Keychain');
    return keychain.get(dir) ?? null;
  });
  try {
    return await step();
  } finally {
    vi.mocked(readKeychainCredential).mockImplementation((dir: string) => keychain.get(dir) ?? null);
  }
}

beforeEach(() => {
  keychain.clear();
});

describe('the editor has a Claude folder of its own', () => {
  it("is the user's own Claude but for the login, made by ccx editor on", async () => {
    const s = await scene();
    await editorOn(s);

    expect(realpathSync(path.join(s.folder, 'projects'))).toBe(realpathSync(s.user('projects')));
    expect(realpathSync(path.join(s.folder, 'skills'))).toBe(realpathSync(s.user('skills')));
    expect(json(path.join(s.folder, 'settings.json'))).toEqual({ model: 'opus', permissions: { allow: ['Bash(ls)'] } });
    expect(read(path.join(s.folder, 'CLAUDE.md'))).toBe('my memory');
    const state = json(path.join(s.folder, '.claude.json'));
    expect((state.oauthAccount as { emailAddress?: string }).emailAddress).toBe('a@example.com');
    expect(state.mcpServers).toEqual({ mine: { command: 'mine' } });
    expect(tokenOf(folderLogin(s))).toBe('a-A-1');
    expect(readEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', s.context.ctx)).toBe(s.folder);
    // The account's own folder is not written to.
    expect(json(path.join(s.dirOf('A'), '.claude.json'))).not.toHaveProperty('hasCompletedOnboarding');
  });

  it('takes the next login in the same folder on a switch, and a login its Claude renewed goes home', async () => {
    const s = await scene();
    await editorOn(s);
    const folderBefore = statSync(s.folder, { bigint: true }).ino;
    // The editor's Claude renewed A's login in its folder.
    writeFileSync(path.join(s.folder, '.credentials.json'), login('A', 2));

    await use(s, 'B', () => tokenOf(folderLogin(s)) === 'a-B-1');

    expect(isRealFolder(s.folder)).toBe(true);
    expect(statSync(s.folder, { bigint: true }).ino).toBe(folderBefore);
    expect(tokenOf(folderLogin(s))).toBe('a-B-1');
    expect((json(path.join(s.folder, '.claude.json')).oauthAccount as { emailAddress?: string }).emailAddress).toBe(
      'b@example.com',
    );
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(tokenOf(profileLogin(s, 'B'))).toBe('a-B-1');
  });

  it('takes a login its Claude renewed home on a switch while whose it is cannot be asked, by who the folder says it is', async () => {
    const s = await scene();
    s.context.lookupOwner = () => Promise.resolve(null);
    await editorOn(s);
    writeFileSync(path.join(s.folder, '.credentials.json'), login('A', 2));

    await use(s, 'B', () => tokenOf(folderLogin(s)) === 'a-B-1');

    expect(tokenOf(folderLogin(s))).toBe('a-B-1');
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
  });

  it('leaves an editor setting that names the folder another way as it is, at ccx editor on', async () => {
    const s = await scene();
    await editorOn(s);
    const spelled = `${s.folder}${path.sep}`;
    expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', spelled, s.context.ctx).ok).toBe(true);

    expect(await editorCommand(s.context, 'on')).toBe(0);
    await settle(150);

    expect(readEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', s.context.ctx)).toBe(spelled);
  });

  it("writes the Keychain item its Claude saved a login in, on macOS, and no profile loses its file", async () => {
    const s = await scene();
    await editorOn(s);
    // Claude's first save of a login: the item named after its config folder,
    // and the folder's own file removed.
    keychain.set(s.folder, login('A', 2));
    rmSync(path.join(s.folder, '.credentials.json'));

    await use(s, 'B', () => tokenOf(keychain.get(s.folder)) === 'a-B-1');

    expect(tokenOf(keychain.get(s.folder))).toBe('a-B-1');
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(tokenOf(profileLogin(s, 'B'))).toBe('a-B-1');
  });

  it("writes the item named after the editor setting's text, a trailing separator and all", async () => {
    const s = await scene();
    await editorOn(s);
    const spelled = `${s.folder}${path.sep}`;
    expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', spelled, s.context.ctx).ok).toBe(true);
    keychain.set(spelled, login('A', 2));
    rmSync(path.join(s.folder, '.credentials.json'));

    await use(s, 'B', () => tokenOf(keychain.get(spelled)) === 'a-B-1');

    expect(tokenOf(keychain.get(spelled))).toBe('a-B-1');
    expect(keychain.has(s.folder)).toBe(false);
  });

  it("gives ccx-claude's Claude the folder as the editor's setting spells it, so one Keychain item holds the login and a renewal goes home", async () => {
    const s = await scene();
    // The only editor setting that names the folder is VS Code's, with a trailing separator.
    const spelled = `${s.folder}${path.sep}`;
    expect(installEditorEnvVar('vscode', 'CLAUDE_CONFIG_DIR', spelled, s.context.ctx).ok).toBe(
      true,
    );

    // A launch through ccx-claude, which makes the folder, gives Claude exactly the text the setting has.
    const launching = { ...s.context, claude: { bin: process.execPath, prefixArgs: [fakeClaude] } };
    expect(await editorLaunch(launching, ['chat'])).toBe(0);
    const ran = JSON.parse(read(path.join(s.folder, 'fake-last-run.json')) ?? '{}') as {
      configDir?: string;
    };
    expect(ran.configDir).toBe(spelled);

    // That Claude renewed A's login in the item named after that text, and A's profile holds the older one.
    keychain.set(spelled, login('A', 2));
    rmSync(path.join(s.folder, '.credentials.json'));
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-1');
    await use(s, 'B', () => tokenOf(keychain.get(spelled)) === 'a-B-1');

    // The renewal went home before the move replaced it, and no second item was written.
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(tokenOf(keychain.get(spelled))).toBe('a-B-1');
    expect(keychain.has(s.folder)).toBe(false);
  });

  it("keeps the spelling it gave Claude among the folder's, so a renewal still goes home once the setting is edited away", async () => {
    const s = await scene();
    const spelled = `${s.folder}${path.sep}`;
    expect(installEditorEnvVar('vscode', 'CLAUDE_CONFIG_DIR', spelled, s.context.ctx).ok).toBe(
      true,
    );
    const launching = { ...s.context, claude: { bin: process.execPath, prefixArgs: [fakeClaude] } };
    expect(await editorLaunch(launching, ['chat'])).toBe(0);
    const ran = JSON.parse(read(path.join(s.folder, 'fake-last-run.json')) ?? '{}') as {
      configDir?: string;
    };
    expect(ran.configDir).toBe(spelled);

    // Someone edits the setting away by hand, while that Claude goes on keeping its login in the item named after the old text.
    expect(uninstallEditorEnvVar('vscode', 'CLAUDE_CONFIG_DIR', s.context.ctx).ok).toBe(true);
    expect(readEditorEnvVar('vscode', 'CLAUDE_CONFIG_DIR', s.context.ctx)).toBeNull();
    keychain.set(spelled, login('A', 2));
    rmSync(path.join(s.folder, '.credentials.json'));
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-1');
    await use(s, 'B', () => tokenOf(keychain.get(spelled)) === 'a-B-1');

    // The renewal went home before the move replaced it, in the item that Claude still reads.
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(tokenOf(keychain.get(spelled))).toBe('a-B-1');
  });

  it('notes that spelling in one try, so a launch does not wait for another ccx that holds the editor lock', async () => {
    const s = await scene();
    const spelled = `${s.folder}${path.sep}`;
    expect(installEditorEnvVar('vscode', 'CLAUDE_CONFIG_DIR', spelled, s.context.ctx).ok).toBe(
      true,
    );
    await setUpEditor(s.context);
    const launching = { ...s.context, claude: { bin: process.execPath, prefixArgs: [fakeClaude] } };
    const lock = acquireOwnedLock(path.join(s.ccx, 'editor-folder.lock'), {
      waitMs: 0,
      staleMs: 60_000,
      maxHoldMs: 60_000,
    });
    try {
      const started = Date.now();
      expect(await editorLaunch(launching, ['chat'])).toBe(0);

      // Noting it once waited 10 s for the lock, as `ccx editor off` does.
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(readEditorRecord(s.folder)?.spellings).toBeUndefined();
    } finally {
      lock.release();
    }

    // The next launch notes it.
    expect(await editorLaunch(launching, ['chat'])).toBe(0);
    expect(readEditorRecord(s.folder)?.spellings).toEqual([spelled]);
  });

  it.skipIf(process.platform === 'win32')(
    "writes the item named after the setting's text in another case, on macOS",
    async () => {
      const s = await scene(['A', 'B'], 'darwin');
      await editorOn(s);
      const spelled = path.join(path.dirname(s.folder), 'EDITOR-ACTIVE');
      expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', spelled, s.context.ctx).ok).toBe(true);
      keychain.set(spelled, login('A', 2));
      rmSync(path.join(s.folder, '.credentials.json'));

      await use(s, 'B', () => tokenOf(keychain.get(spelled)) === 'a-B-1');

      expect(tokenOf(keychain.get(spelled))).toBe('a-B-1');
      expect(keychain.has(s.folder)).toBe(false);
    },
  );

  it("keeps a chat its Claude writes in the user's own history, found again on the next account", async () => {
    const s = await scene();
    await editorOn(s);
    mkdirSync(path.join(s.folder, 'projects', '-work'), { recursive: true });
    writeFileSync(path.join(s.folder, 'projects', '-work', 'chat.jsonl'), 'line 1\n');

    await use(s, 'B', () => tokenOf(folderLogin(s)) === 'a-B-1');

    expect(read(s.user(path.join('projects', '-work', 'chat.jsonl')))).toBe('line 1\n');
    expect(read(path.join(s.folder, 'projects', '-work', 'chat.jsonl'))).toBe('line 1\n');
    expect(existsSync(path.join(s.dirOf('A'), 'projects', '-work', 'chat.jsonl'))).toBe(false);
  });

  it('says so when ccx editor on cannot set the editor up yet', async () => {
    const s = await scene();
    // A folder at its path that ccx did not make, with an editor chat open in it.
    mkdirSync(path.join(s.folder, 'sessions'), { recursive: true });
    writeFileSync(
      path.join(s.folder, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, entrypoint: 'claude-vscode' }),
    );
    writeFileSync(path.join(s.folder, 'history.jsonl'), '{"display":"typed there"}\n');
    const said: string[] = [];

    let code: number | string;
    try {
      code = await editorCommand({ ...s.context, out: (line: string) => said.push(line) }, 'on');
    } catch (error) {
      code = String(error);
    }

    expect(code).toBe(1);
    expect(said.join('\n')).toContain('not set up');
  });
});

describe("a switch and the locks the editor's Claude takes", () => {
  it("does not move the editor while its Claude holds its login's lock, and moves it once that is let go", { timeout: 20_000 }, async () => {
    const s = await scene();
    await editorOn(s);
    const lock = path.join(s.folder, '.oauth_refresh.lock');
    mkdirSync(lock);

    await use(s, 'B');
    await settle(3_000);
    expect(tokenOf(folderLogin(s))).toBe('a-A-1');
    expect(json(path.join(s.folder, '.claude.json')).oauthAccount).toMatchObject({ emailAddress: emailOf('A') });

    rmSync(lock, { recursive: true });
    await waitFor(() => tokenOf(folderLogin(s)) === 'a-B-1', 8_000);
    expect(tokenOf(folderLogin(s))).toBe('a-B-1');
    expect(json(path.join(s.folder, '.claude.json')).oauthAccount).toMatchObject({ emailAddress: emailOf('B') });
  });

  it('does not move the editor while its Claude is saving its state, and moves it once that is done', { timeout: 20_000 }, async () => {
    const s = await scene();
    await editorOn(s);
    const lock = path.join(s.folder, '.claude.json.lock');
    mkdirSync(lock);

    await use(s, 'B');
    await settle(3_000);
    expect(tokenOf(folderLogin(s))).toBe('a-A-1');
    expect(json(path.join(s.folder, '.claude.json')).oauthAccount).toMatchObject({ emailAddress: emailOf('A') });

    rmSync(lock, { recursive: true });
    await waitFor(() => tokenOf(folderLogin(s)) === 'a-B-1', 8_000);
    expect(tokenOf(folderLogin(s))).toBe('a-B-1');
  });

  it('does not move the editor off a renewal its Claude made that could not be saved home, and moves it once it can be', { timeout: 20_000 }, async () => {
    const s = await scene();
    await editorOn(s);
    writeFileSync(path.join(s.folder, '.credentials.json'), login('A', 2));
    // Where ccx keeps its private copy of a login it saves home, taken: the save cannot be made.
    const copy = path.join(s.ccx, `.editor-login.${process.pid}.tmp`);
    mkdirSync(copy);

    await use(s, 'B');
    await settle(1_000);
    expect(tokenOf(folderLogin(s))).toBe('a-A-2');

    rmSync(copy, { recursive: true });
    await waitFor(() => tokenOf(folderLogin(s)) === 'a-B-1', 12_000);
    expect(tokenOf(folderLogin(s))).toBe('a-B-1');
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
  });
});

describe('the editor folder kept in step with your own files', () => {
  const editSettings = (file: string, change: (s: Record<string, unknown>) => void): void => {
    const settings = json(file);
    change(settings);
    writeFileSync(file, JSON.stringify(settings, null, 2));
  };

  it('takes a setting changed in the editor to your settings.json at the next refresh', async () => {
    const s = await scene();
    await editorOn(s);
    editSettings(path.join(s.folder, 'settings.json'), (x) => {
      x.model = 'sonnet';
    });

    await use(s, 'A', () => json(s.user('settings.json')).model === 'sonnet');

    expect(json(s.user('settings.json'))).toEqual({ model: 'sonnet', permissions: { allow: ['Bash(ls)'] } });
    expect(json(path.join(s.folder, 'settings.json')).model).toBe('sonnet');
  });

  it('brings a setting you changed into the editor at the next refresh', async () => {
    const s = await scene();
    await editorOn(s);
    editSettings(s.user('settings.json'), (x) => {
      x.model = 'haiku';
    });

    await use(s, 'A', () => read(path.join(s.folder, 'settings.json'))?.includes('haiku') === true);

    expect(json(path.join(s.folder, 'settings.json'))).toEqual({ model: 'haiku', permissions: { allow: ['Bash(ls)'] } });
  });

  it("keeps yours where both changed one setting, and the editor's file in rescued/", async () => {
    const s = await scene();
    await editorOn(s);
    editSettings(path.join(s.folder, 'settings.json'), (x) => {
      x.model = 'sonnet';
    });
    editSettings(s.user('settings.json'), (x) => {
      x.model = 'haiku';
    });
    const rescued = path.join(s.ccx, 'rescued');

    await use(s, 'A', () => existsSync(rescued));

    expect(json(s.user('settings.json')).model).toBe('haiku');
    expect(json(path.join(s.folder, 'settings.json')).model).toBe('haiku');
    const kept = (existsSync(rescued) ? readdirSync(rescued) : []).filter((name) =>
      name.endsWith('editor-active-settings.json'),
    );
    expect(kept).toHaveLength(1);
    expect(json(path.join(rescued, kept[0]!)).model).toBe('sonnet');
  });

  it('never drops either side, and changes nothing at a second refresh', async () => {
    const s = await scene();
    await editorOn(s);
    editSettings(path.join(s.folder, 'settings.json'), (x) => {
      x.permissions = { allow: ['Bash(ls)', 'Read'] };
    });
    editSettings(s.user('settings.json'), (x) => {
      x.env = { FROM_YOU: '1' };
    });

    await use(s, 'A', () => json(s.user('settings.json')).permissions !== undefined && read(s.user('settings.json'))?.includes('"Read"') === true);

    const both = { model: 'opus', permissions: { allow: ['Bash(ls)', 'Read'] }, env: { FROM_YOU: '1' } };
    expect(json(s.user('settings.json'))).toEqual(both);
    expect(json(path.join(s.folder, 'settings.json'))).toEqual(both);
    const yours = read(s.user('settings.json'));
    const its = read(path.join(s.folder, 'settings.json'));
    await use(s, 'A');
    expect(read(s.user('settings.json'))).toBe(yours);
    expect(read(path.join(s.folder, 'settings.json'))).toBe(its);
  });

  it('brings two changes of yours in a row in, calling neither a clash', async () => {
    const s = await scene();
    await editorOn(s);
    for (const model of ['haiku', 'sonnet']) {
      editSettings(s.user('settings.json'), (x) => {
        x.model = model;
      });
      await use(s, 'A', () => read(path.join(s.folder, 'settings.json'))?.includes(model) === true);
    }

    expect(json(path.join(s.folder, 'settings.json')).model).toBe('sonnet');
    expect(json(s.user('settings.json')).model).toBe('sonnet');
    expect(existsSync(path.join(s.ccx, 'rescued'))).toBe(false);
  });

  it("waits for the editor's Claude to finish writing its .claude.json before writing it", async () => {
    const s = await scene();
    await editorOn(s);
    const userState = path.join(s.home, '.claude.json');
    writeFileSync(
      userState,
      JSON.stringify({ ...json(userState), mcpServers: { mine: { command: 'mine' }, added: { command: 'added' } } }),
    );
    // The lock Claude takes to write its state (2.1.302's saveConfigWithLock).
    const lock = path.join(s.folder, '.claude.json.lock');
    mkdirSync(lock);

    await use(s, 'A');
    expect(json(path.join(s.folder, '.claude.json')).mcpServers).toEqual({ mine: { command: 'mine' } });

    rmSync(lock, { recursive: true });
    await use(s, 'A', () => JSON.stringify(json(path.join(s.folder, '.claude.json')).mcpServers).includes('added'));
    expect(json(path.join(s.folder, '.claude.json')).mcpServers).toEqual({
      mine: { command: 'mine' },
      added: { command: 'added' },
    });
  });

  it("takes MCP servers and preferences in .claude.json both ways, and keeps the folder's own account", async () => {
    const s = await scene();
    await editorOn(s);
    const theirs = path.join(s.folder, '.claude.json');
    const state = json(theirs);
    writeFileSync(theirs, JSON.stringify({ ...state, theme: 'light' }));
    const userState = path.join(s.home, '.claude.json');
    writeFileSync(
      userState,
      JSON.stringify({ ...json(userState), mcpServers: { mine: { command: 'mine' }, added: { command: 'added' } } }),
    );

    await use(s, 'A', () => json(userState).theme === 'light');

    expect(json(userState).theme).toBe('light');
    expect(json(userState)).not.toHaveProperty('oauthAccount');
    const now = json(theirs);
    expect(now.mcpServers).toEqual({ mine: { command: 'mine' }, added: { command: 'added' } });
    expect(now.theme).toBe('light');
    expect((now.oauthAccount as { emailAddress?: string }).emailAddress).toBe('a@example.com');
  });

  it('takes a memory the editor saved as a new file to your CLAUDE.md, and makes them one file again', async () => {
    const s = await scene();
    await editorOn(s);
    // An editor that saves by writing a new file and renaming it over the old one.
    const mine = path.join(s.folder, 'CLAUDE.md');
    rmSync(mine);
    writeFileSync(mine, 'remembered in the editor');

    await use(s, 'A', () => read(s.user('CLAUDE.md')) === 'remembered in the editor');

    expect(read(s.user('CLAUDE.md'))).toBe('remembered in the editor');
    expect(statSync(mine, { bigint: true }).ino).toBe(statSync(s.user('CLAUDE.md'), { bigint: true }).ino);
  });

  it('waits for another refresh to end rather than run beside it', async () => {
    const s = await scene();
    await editorOn(s);
    // Held by a running process that is not this one.
    const lock = path.join(s.ccx, 'editor-folder.lock');
    writeFileSync(lock, String(process.ppid));
    editSettings(path.join(s.folder, 'settings.json'), (x) => {
      x.model = 'sonnet';
    });

    expect(useCommand(s.context, 'A', {}, () => [])).toBe(0);
    await settle(600);
    expect(json(s.user('settings.json')).model).toBe('opus');

    rmSync(lock);
    await waitFor(() => json(s.user('settings.json')).model === 'sonnet');
    expect(json(s.user('settings.json')).model).toBe('sonnet');
  });
});

describe('renewing the login the editor holds', () => {
  const tokenResponse = (name: string, gen: number): Response =>
    new Response(
      JSON.stringify({ access_token: `a-${name}-${gen}`, refresh_token: `r-${name}-${gen}`, expires_in: 8 * 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  /** The editor on A, with A's login due for renewal, in its profile and the folder. */
  async function dueOnA(): Promise<Scene> {
    const s = await scene();
    writeFileSync(path.join(s.dirOf('A'), '.credentials.json'), login('A', 1, Date.now() + 60_000));
    await editorOn(s);
    return s;
  }

  it("renews under the editor folder's lock, and puts the renewal in the folder before letting go", async () => {
    const s = await dueOnA();
    let folderLockHeld: boolean | null = null;
    const outcome = await refreshCredentialIfExpired(s.dirOf('A'), {
      ctx: s.context.ctx,
      fetchImpl: () => {
        folderLockHeld = existsSync(path.join(s.folder, '.oauth_refresh.lock'));
        return Promise.resolve(tokenResponse('A', 2));
      },
    });

    expect(outcome.status).toBe('refreshed');
    expect(folderLockHeld).toBe(true);
    expect(tokenOf(folderLogin(s))).toBe('a-A-2');
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
  });

  it("sends nothing while the editor's Claude is renewing that login itself", async () => {
    const s = await dueOnA();
    mkdirSync(path.join(s.folder, '.oauth_refresh.lock'));
    let asked = 0;
    const outcome = await refreshCredentialIfExpired(s.dirOf('A'), {
      ctx: s.context.ctx,
      fetchImpl: () => {
        asked += 1;
        return Promise.resolve(tokenResponse('A', 2));
      },
    });

    expect(outcome.status).toBe('busy');
    expect(asked).toBe(0);
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-1');
  });

  it('keeps a renewal whose answer takes 5 s, in the profile and the folder', { timeout: 20_000 }, async () => {
    const s = await dueOnA();
    const outcome = await refreshCredentialIfExpired(s.dirOf('A'), {
      ctx: s.context.ctx,
      fetchImpl: () => new Promise<Response>((resolve) => setTimeout(() => resolve(tokenResponse('A', 2)), 5_000)),
    });

    expect(isRealFolder(s.folder)).toBe(true);
    expect(outcome.status).toBe('refreshed');
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(tokenOf(folderLogin(s))).toBe('a-A-2');
  });

  it("sends nothing while the editor's Keychain item cannot be read, since it may hold that login", async () => {
    const s = await dueOnA();
    let asked = 0;
    const outcome = await whileUnreadable(s, () =>
      refreshCredentialIfExpired(s.dirOf('A'), {
        ctx: s.context.ctx,
        fetchImpl: () => {
          asked += 1;
          return Promise.resolve(tokenResponse('A', 2));
        },
      }),
    );

    expect(outcome.status).toBe('busy');
    expect(asked).toBe(0);
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-1');
  });

  it('does not renew that account while the Keychain item its editor saves in cannot be read', async () => {
    const s = await dueOnA();
    const accounts = listAccounts(s.context.ctx);
    const a = accounts.find((x) => x.name === 'A')!;
    let renewed = 0;
    const result = await whileUnreadable(s, () =>
      renewIdleLogin(a, accounts, s.context.ctx, {
        renew: () => {
          renewed += 1;
          return Promise.resolve({ status: 'refreshed' as const });
        },
        ...(s.context.lookupOwner ? { lookupOwner: s.context.lookupOwner } : {}),
      }),
    );

    expect(result.refusal).not.toBeNull();
    expect(renewed).toBe(0);
  });

  it('gives up on an owner lookup that does not answer, and does not renew that account meanwhile', { timeout: 20_000 }, async () => {
    const s = await dueOnA();
    writeFileSync(path.join(s.folder, '.credentials.json'), login('A', 2));
    const accounts = listAccounts(s.context.ctx);
    const a = accounts.find((x) => x.name === 'A')!;
    let renewed = 0;
    const result = await Promise.race([
      renewIdleLogin(a, accounts, s.context.ctx, {
        renew: () => {
          renewed += 1;
          return Promise.resolve({ status: 'refreshed' as const });
        },
        lookupOwner: () => new Promise<string | null>(() => {}),
      }),
      settle(10_000).then(() => 'no answer' as const),
    ]);

    expect(result).not.toBe('no answer');
    expect(result === 'no answer' ? null : result.refusal).not.toBeNull();
    expect(renewed).toBe(0);
  });

  it("takes home a renewal the editor's Claude made before ccx renews that account", async () => {
    const s = await dueOnA();
    writeFileSync(path.join(s.folder, '.credentials.json'), login('A', 2));
    const accounts = listAccounts(s.context.ctx);
    const a = accounts.find((x) => x.name === 'A')!;
    const seen: Array<string | null> = [];
    await renewIdleLogin(a, accounts, s.context.ctx, {
      renew: (dir) => {
        seen.push(tokenOf(read(path.join(dir, '.credentials.json'))));
        return Promise.resolve({ status: 'not-needed' as const });
      },
      ...(s.context.lookupOwner ? { lookupOwner: s.context.lookupOwner } : {}),
    });

    expect(isRealFolder(s.folder)).toBe(true);
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(seen.every((token) => token === 'a-A-2')).toBe(true);
  });

  it('does not renew that account while whose that renewal is cannot be asked', async () => {
    const s = await dueOnA();
    writeFileSync(path.join(s.folder, '.credentials.json'), login('A', 2));
    const accounts = listAccounts(s.context.ctx);
    const a = accounts.find((x) => x.name === 'A')!;
    let renewed = 0;
    const result = await renewIdleLogin(a, accounts, s.context.ctx, {
      renew: () => {
        renewed += 1;
        return Promise.resolve({ status: 'refreshed' as const });
      },
      lookupOwner: () => Promise.resolve(null),
    });

    expect(result.refusal).not.toBeNull();
    expect(renewed).toBe(0);
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-1');
  });

  it('does not renew that account while that renewal could not be saved home, and saves it at the next look', async () => {
    const s = await dueOnA();
    writeFileSync(path.join(s.folder, '.credentials.json'), login('A', 2));
    const accounts = listAccounts(s.context.ctx);
    const a = accounts.find((x) => x.name === 'A')!;
    // Where ccx keeps its private copy of a login it saves home, taken: the save cannot be made.
    const copy = path.join(s.ccx, `.editor-login.${process.pid}.tmp`);
    mkdirSync(copy);
    const seen: Array<string | null> = [];
    const options = {
      renew: (dir: string) => {
        seen.push(tokenOf(read(path.join(dir, '.credentials.json'))));
        return Promise.resolve({ status: 'refreshed' as const });
      },
      ...(s.context.lookupOwner ? { lookupOwner: s.context.lookupOwner } : {}),
    };

    const first = await renewIdleLogin(a, accounts, s.context.ctx, options);
    expect(first.refusal).not.toBeNull();
    expect(seen).toEqual([]);

    rmSync(copy, { recursive: true });
    await renewIdleLogin(a, accounts, s.context.ctx, options);
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(seen.every((token) => token === 'a-A-2')).toBe(true);
  });
});

describe('an install on the old link, moved into the folder', () => {
  /** An install from before: the editor set to the link, which leads to `name`'s folder. */
  async function onTheLink(name: string): Promise<Scene> {
    const s = await scene();
    setTarget(s.folder, s.dirOf(name));
    expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', s.folder, s.context.ctx).ok).toBe(true);
    return s;
  }
  const put = (file: string, text: string): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const list = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

  it("moves at the first switch, at the same path, with the account folders' chats merged and their own files kept aside", async () => {
    const s = await onTheLink('A');
    put(path.join(s.dirOf('A'), 'projects', '-work', 'old.jsonl'), 'from A\n');
    put(path.join(s.dirOf('B'), 'projects', '-other', 'older.jsonl'), 'from B\n');
    put(path.join(s.dirOf('A'), 'history.jsonl'), '{"display":"typed in the editor"}\n');
    put(path.join(s.dirOf('A'), 'settings.json'), JSON.stringify({ model: 'haiku' }));
    put(path.join(s.dirOf('A'), 'CLAUDE.md'), 'account memory');

    await use(s, 'A', () => isRealFolder(s.folder));

    expect(isRealFolder(s.folder)).toBe(true);
    expect(readEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', s.context.ctx)).toBe(s.folder);
    expect(realpathSync(path.join(s.folder, 'projects'))).toBe(realpathSync(s.user('projects')));
    expect(read(s.user(path.join('projects', '-work', 'old.jsonl')))).toBe('from A\n');
    expect(read(s.user(path.join('projects', '-other', 'older.jsonl')))).toBe('from B\n');
    expect(read(s.user('history.jsonl'))).toContain('typed in the editor');
    const rescuedDir = path.join(s.ccx, 'rescued');
    const rescued = existsSync(rescuedDir) ? readdirSync(rescuedDir) : [];
    const settingsKept = rescued.find((name) => name.endsWith('A-settings.json'));
    expect(settingsKept).toBeDefined();
    expect(json(path.join(s.ccx, 'rescued', settingsKept!)).model).toBe('haiku');
    expect(rescued.some((name) => name.endsWith('A-CLAUDE.md'))).toBe(true);
    // Nothing in the account folders is moved or deleted, and your files are as they were.
    expect(read(path.join(s.dirOf('A'), 'projects', '-work', 'old.jsonl'))).toBe('from A\n');
    expect(read(path.join(s.dirOf('A'), 'settings.json'))).toBe(JSON.stringify({ model: 'haiku' }));
    expect(json(s.user('settings.json')).model).toBe('opus');
    expect(read(s.user('CLAUDE.md'))).toBe('my memory');
    expect(tokenOf(folderLogin(s))).toBe('a-A-1');
  });

  it('takes home a login its Claude kept in a Keychain item of its own, and the folder goes on with it', async () => {
    const s = await onTheLink('B');
    // The first save, while the link led to A: an item named after the link,
    // and A's own file removed through it. The link was moved to B since.
    keychain.set(s.folder, login('A', 2));
    rmSync(path.join(s.dirOf('A'), '.credentials.json'));
    setActive('B', s.context.ctx);

    await use(s, 'B', () => isRealFolder(s.folder) && tokenOf(keychain.get(s.folder)) === 'a-B-1');

    expect(isRealFolder(s.folder)).toBe(true);
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(tokenOf(keychain.get(s.folder))).toBe('a-B-1');
    expect(tokenOf(profileLogin(s, 'B'))).toBe('a-B-1');
  });

  it("gives back, as it moves, the login file its Claude's first save took, though whose it is can be asked only then", async () => {
    const s = await onTheLink('A');
    keychain.set(s.folder, login('A', 2));
    rmSync(path.join(s.dirOf('A'), '.credentials.json'));
    // The API answers once, for the move, and not again.
    let answers = 0;
    s.context.lookupOwner = (dir) => {
      answers += 1;
      return Promise.resolve(answers === 1 ? ownerOf(readFileSync(path.join(dir, '.credentials.json'), 'utf8')) : null);
    };

    await use(s, 'A', () => isRealFolder(s.folder));

    expect(isRealFolder(s.folder)).toBe(true);
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(tokenOf(keychain.get(s.folder))).toBe('a-A-2');
  });

  it('waits while an editor chat started through the link is open, and goes ahead a day on', async () => {
    const s = await onTheLink('A');
    // An editor chat's Claude, running: its record where the link leads, whichever account that is.
    for (const name of ['A', 'B']) {
      mkdirSync(path.join(s.dirOf(name), 'sessions'), { recursive: true });
      writeFileSync(
        path.join(s.dirOf(name), 'sessions', `${process.pid}.json`),
        JSON.stringify({ pid: process.pid, entrypoint: 'claude-vscode', sessionId: '11111111-1111-4111-8111-111111111111' }),
      );
    }

    await use(s, 'B');
    expect(lstatSync(s.folder).isSymbolicLink()).toBe(true);
    // Pointed as before meanwhile.
    expect(path.resolve(readTarget(s.folder) ?? '')).toBe(path.resolve(s.dirOf('B')));

    writeFileSync(path.join(s.ccx, 'editor-move-held.json'), JSON.stringify({ since: Date.now() - 25 * HOURS }));
    await use(s, 'B', () => isRealFolder(s.folder));
    expect(isRealFolder(s.folder)).toBe(true);
  });

  it('merges once more, after the editor chat open at the move closes, the prompts it went on writing where the link led', async () => {
    const s = await onTheLink('A');
    // An editor chat's Claude, started through the link and still running a day on.
    const chat = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => chat.once('exit', resolve));
    try {
      mkdirSync(path.join(s.dirOf('A'), 'sessions'), { recursive: true });
      writeFileSync(
        path.join(s.dirOf('A'), 'sessions', `${chat.pid}.json`),
        JSON.stringify({ pid: chat.pid, entrypoint: 'claude-vscode', sessionId: '22222222-2222-4222-8222-222222222222' }),
      );
      writeFileSync(path.join(s.ccx, 'editor-move-held.json'), JSON.stringify({ since: Date.now() - 25 * HOURS }));
      await use(s, 'A', () => isRealFolder(s.folder));
      expect(isRealFolder(s.folder)).toBe(true);
      // It goes on adding to the prompt history it kept open where the link led.
      appendFileSync(path.join(s.dirOf('A'), 'history.jsonl'), '{"display":"after the move"}\n');
      await use(s, 'A');
      expect(read(s.user('history.jsonl')) ?? '').not.toContain('after the move');
    } finally {
      chat.kill();
    }
    await exited;

    await use(s, 'A', () => read(s.user('history.jsonl'))?.includes('after the move') === true);
    expect(read(s.user('history.jsonl'))).toContain('after the move');
  });

  it("tries the account folders' history again at a later refresh when the move could not merge it", async () => {
    const s = await onTheLink('A');
    writeFileSync(path.join(s.dirOf('A'), 'history.jsonl'), '{"display":"typed in the editor"}\n');
    // Your prompt history cannot be added to while the move runs.
    mkdirSync(s.user('history.jsonl'));

    await use(s, 'A', () => isRealFolder(s.folder));
    expect(isRealFolder(s.folder)).toBe(true);

    rmSync(s.user('history.jsonl'), { recursive: true });
    await use(s, 'A', () => read(s.user('history.jsonl'))?.includes('typed in the editor') === true);
    expect(read(s.user('history.jsonl'))).toContain('typed in the editor');
  });

  it('tries a chat again at a later refresh when the move could not merge it', async () => {
    const s = await onTheLink('A');
    const agent = path.join('projects', '-work', 'chat', 'subagents', 'agent.jsonl');
    put(path.join(s.dirOf('A'), agent), 'from A\n');
    // A file of yours stands where the chat's folder would go.
    put(s.user(path.join('projects', '-work', 'chat')), 'in the way');

    await use(s, 'A', () => isRealFolder(s.folder));
    expect(isRealFolder(s.folder)).toBe(true);
    expect(read(s.user(agent))).toBeNull();

    rmSync(s.user(path.join('projects', '-work', 'chat')));
    await use(s, 'A', () => read(s.user(agent)) === 'from A\n');
    expect(read(s.user(agent))).toBe('from A\n');
  });

  it('adds to a chat you already have what the copy in an account folder went on to hold', async () => {
    const s = await onTheLink('A');
    const chat = path.join('projects', '-work', 'chat.jsonl');
    put(path.join(s.dirOf('A'), chat), 'line 1\nline 2\n');
    put(s.user(chat), 'line 1\n');

    await use(s, 'A', () => isRealFolder(s.folder));
    expect(isRealFolder(s.folder)).toBe(true);

    expect(read(s.user(chat))).toBe('line 1\nline 2\n');
    expect(list(path.join(s.ccx, 'rescued', 'A-projects'))).toEqual([]);
  });

  it('keeps aside, once, an account copy that differs from yours, and leaves yours as it is', async () => {
    const s = await onTheLink('A');
    const chat = path.join('projects', '-work', 'chat.jsonl');
    const older = path.join('projects', '-work', 'older.jsonl');
    put(path.join(s.dirOf('A'), chat), 'line 1\ntheirs\n');
    put(s.user(chat), 'line 1\nmine\n');
    // Yours holds all of this one and more.
    put(path.join(s.dirOf('A'), older), 'line 1\n');
    put(s.user(older), 'line 1\nline 2\n');

    await use(s, 'A', () => isRealFolder(s.folder));
    expect(isRealFolder(s.folder)).toBe(true);

    expect(read(s.user(chat))).toBe('line 1\nmine\n');
    expect(read(s.user(older))).toBe('line 1\nline 2\n');
    const kept = path.join(s.ccx, 'rescued', 'A-projects', '-work');
    expect(list(kept)).toEqual(['chat.jsonl']);
    expect(read(path.join(kept, 'chat.jsonl'))).toBe('line 1\ntheirs\n');
    expect(read(path.join(s.dirOf('A'), chat))).toBe('line 1\ntheirs\n');
  });

  it('takes over a folder at its path that ccx did not make, keeping its chats, its own files and the login its Claude ran on', async () => {
    const s = await scene();
    // What an editor's Claude leaves at the path when it runs on with ccx's folder gone.
    put(path.join(s.folder, 'projects', '-work', 'chat.jsonl'), 'a chat\n');
    put(path.join(s.folder, 'history.jsonl'), '{"display":"typed there"}\n');
    put(path.join(s.folder, 'settings.json'), JSON.stringify({ model: 'haiku' }));
    put(path.join(s.folder, '.claude.json'), JSON.stringify({ theme: 'light' }));
    put(path.join(s.folder, '.credentials.json'), login('A', 3));
    expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', s.folder, s.context.ctx).ok).toBe(true);
    // The API answers whose that login is once, for the take-over, and then no more.
    const ask = s.context.lookupOwner!;
    let asked = 0;
    s.context.lookupOwner = (dir) => (asked++ === 0 ? ask(dir) : Promise.resolve(null));

    await use(s, 'A', () => existsSync(path.join(s.folder, '.ccx-editor.json')));

    expect(existsSync(path.join(s.folder, '.ccx-editor.json'))).toBe(true);
    expect(read(s.user(path.join('projects', '-work', 'chat.jsonl')))).toBe('a chat\n');
    expect(read(s.user('history.jsonl'))).toContain('typed there');
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-3');
    expect(tokenOf(folderLogin(s))).toBe('a-A-3');
    // Merged once more and gone, as no editor chat is open in it.
    await use(s, 'A', () => !list(s.ccx).some((name) => name.startsWith('editor-active.taken-over')));
    expect(list(s.ccx).filter((name) => name.startsWith('editor-active.taken-over'))).toEqual([]);
    // Its own files kept aside once, though each pass looks at them.
    const rescued = list(path.join(s.ccx, 'rescued'));
    expect(rescued.filter((name) => name.endsWith('editor-settings.json'))).toHaveLength(1);
    expect(rescued.filter((name) => name.endsWith('editor-claude-choices.json'))).toHaveLength(1);
  });

  for (const [what, file, text, kept] of [
    ['settings', 'settings.json', JSON.stringify({ model: 'haiku' }), 'editor-settings.json'],
    ['Claude choices', '.claude.json', JSON.stringify({ theme: 'light' }), 'editor-claude-choices.json'],
  ] as const) {
    it(`keeps a folder it took over until its own ${what} are kept aside`, async () => {
      const s = await scene();
      put(path.join(s.folder, 'projects', '-work', 'chat.jsonl'), 'a chat\n');
      put(path.join(s.folder, file), text);
      expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', s.folder, s.context.ctx).ok).toBe(true);
      // Nothing can be kept in rescued/ yet.
      writeFileSync(path.join(s.ccx, 'rescued'), 'in the way');
      const takenOver = (): string[] => list(s.ccx).filter((name) => name.startsWith('editor-active.taken-over'));

      await use(s, 'A', () => existsSync(path.join(s.folder, '.ccx-editor.json')));
      expect(existsSync(path.join(s.folder, '.ccx-editor.json'))).toBe(true);
      expect(takenOver()).toHaveLength(1);

      rmSync(path.join(s.ccx, 'rescued'));
      await use(s, 'A', () => takenOver().length === 0);

      expect(takenOver()).toEqual([]);
      expect(list(path.join(s.ccx, 'rescued')).filter((name) => name.endsWith(kept))).toHaveLength(1);
    });
  }

  it('keeps its own files aside as it takes a folder over, when no note to look at it again can be written', async () => {
    const s = await scene();
    put(path.join(s.folder, 'projects', '-work', 'chat.jsonl'), 'a chat\n');
    put(path.join(s.folder, 'settings.json'), JSON.stringify({ model: 'haiku' }));
    put(path.join(s.folder, '.claude.json'), JSON.stringify({ theme: 'light' }));
    expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', s.folder, s.context.ctx).ok).toBe(true);
    // No later pass will look at the folder taken over, as nothing notes it.
    mkdirSync(path.join(s.ccx, 'editor-taken-over.json'));

    await use(s, 'A', () => existsSync(path.join(s.folder, '.ccx-editor.json')));

    expect(existsSync(path.join(s.folder, '.ccx-editor.json'))).toBe(true);
    expect(list(s.ccx).filter((name) => name.startsWith('editor-active.taken-over'))).toHaveLength(1);
    expect(read(s.user(path.join('projects', '-work', 'chat.jsonl')))).toBe('a chat\n');
    const rescued = list(path.join(s.ccx, 'rescued'));
    expect(rescued.filter((name) => name.endsWith('editor-settings.json'))).toHaveLength(1);
    expect(rescued.filter((name) => name.endsWith('editor-claude-choices.json'))).toHaveLength(1);
  });

  it("keeps whole, before a folder it took over goes, a Claude state file there that does not parse", async () => {
    const s = await scene();
    put(path.join(s.folder, 'projects', '-work', 'chat.jsonl'), 'a chat\n');
    const half = '{"mcpServers": {"mine": {"command": "mine"';
    put(path.join(s.folder, '.claude.json'), half);
    expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', s.folder, s.context.ctx).ok).toBe(true);
    const takenOver = (): string[] => list(s.ccx).filter((name) => name.startsWith('editor-active.taken-over'));

    await use(s, 'A', () => existsSync(path.join(s.folder, '.ccx-editor.json')) && takenOver().length === 0);

    expect(existsSync(path.join(s.folder, '.ccx-editor.json'))).toBe(true);
    expect(takenOver()).toEqual([]);
    const kept = list(path.join(s.ccx, 'rescued')).filter((name) => name.endsWith('-editor-.claude.json'));
    expect(kept).toHaveLength(1);
    expect(read(path.join(s.ccx, 'rescued', kept[0]!))).toBe(half);
  });

  // Only where a file can be made unreadable: not on Windows, nor as root.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps a folder it took over while its Claude state file cannot be read',
    async () => {
      const s = await scene();
      put(path.join(s.folder, 'projects', '-work', 'chat.jsonl'), 'a chat\n');
      put(path.join(s.folder, '.claude.json'), JSON.stringify({ theme: 'light' }));
      chmodSync(path.join(s.folder, '.claude.json'), 0o000);
      expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', s.folder, s.context.ctx).ok).toBe(true);
      const takenOver = (): string[] => list(s.ccx).filter((name) => name.startsWith('editor-active.taken-over'));

      await use(s, 'A', () => existsSync(path.join(s.folder, '.ccx-editor.json')));
      expect(existsSync(path.join(s.folder, '.ccx-editor.json'))).toBe(true);
      expect(takenOver()).toHaveLength(1);

      chmodSync(path.join(s.ccx, takenOver()[0]!, '.claude.json'), 0o600);
      await use(s, 'A', () => takenOver().length === 0);

      expect(takenOver()).toEqual([]);
      expect(list(path.join(s.ccx, 'rescued')).filter((name) => name.endsWith('editor-claude-choices.json'))).toHaveLength(1);
    },
  );

  it('keeps in rescued/ a login a folder it takes over ran on, of an account ccx does not have', async () => {
    const s = await scene();
    put(path.join(s.folder, 'projects', '-work', 'chat.jsonl'), 'a chat\n');
    put(path.join(s.folder, '.credentials.json'), login('Z', 1));
    expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', s.folder, s.context.ctx).ok).toBe(true);

    await use(s, 'A', () => tokenOf(folderLogin(s)) === 'a-A-1');

    expect(tokenOf(folderLogin(s))).toBe('a-A-1');
    const kept = list(path.join(s.ccx, 'rescued')).find((name) => name.endsWith('editor-login.json'));
    expect(kept).toBeDefined();
    expect(tokenOf(read(path.join(s.ccx, 'rescued', kept!)))).toBe('a-Z-1');
  });

  it('moves with a chat file held open under the old target, as Windows keeps one', async () => {
    const s = await onTheLink('A');
    const chat = path.join(s.dirOf('A'), 'projects', '-work', 'open.jsonl');
    mkdirSync(path.dirname(chat), { recursive: true });
    writeFileSync(chat, 'line 1\n');
    const handle = openSync(chat, 'a');
    try {
      await use(s, 'A', () => isRealFolder(s.folder));
      expect(isRealFolder(s.folder)).toBe(true);
      // The chat's Claude goes on writing to the file it has open.
      writeSync(handle, 'line 2\n');
    } finally {
      closeSync(handle);
    }
    expect(read(s.user(path.join('projects', '-work', 'open.jsonl')))).toBe('line 1\nline 2\n');
    expect(read(chat)).toBe('line 1\nline 2\n');
  });
});

describe('ccx editor off', () => {
  it("retires the folder losing nothing: its login goes home, your settings take its changes, the setting goes", async () => {
    const s = await scene();
    await editorOn(s);
    writeFileSync(path.join(s.folder, '.credentials.json'), login('A', 2));
    const settings = json(path.join(s.folder, 'settings.json'));
    writeFileSync(path.join(s.folder, 'settings.json'), JSON.stringify({ ...settings, model: 'sonnet' }, null, 2));
    mkdirSync(path.join(s.folder, 'projects', '-work'), { recursive: true });
    writeFileSync(path.join(s.folder, 'projects', '-work', 'chat.jsonl'), 'kept\n');

    expect(await editorCommand(s.context, 'off')).toBe(0);

    expect(existsSync(s.folder)).toBe(false);
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(json(s.user('settings.json')).model).toBe('sonnet');
    expect(readEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', s.context.ctx)).toBeNull();
    expect(read(s.user(path.join('projects', '-work', 'chat.jsonl')))).toBe('kept\n');
    expect(read(s.user(path.join('skills', 'mine', 'SKILL.md')))).toBe('mine');
  });

  it("leaves no login behind in the Keychain item named after the setting's text", async () => {
    const s = await scene();
    await editorOn(s);
    const spelled = `${s.folder}${path.sep}`;
    expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', spelled, s.context.ctx).ok).toBe(true);
    keychain.set(spelled, login('A', 2));
    rmSync(path.join(s.folder, '.credentials.json'));

    expect(await editorCommand(s.context, 'off')).toBe(0);

    expect(keychain.has(spelled)).toBe(false);
    expect(keychain.has(s.folder)).toBe(false);
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
  });

  it("still knows the setting's spelling at a second ccx editor off, after the first could not retire the folder", async () => {
    const s = await scene();
    await editorOn(s);
    const spelled = `${s.folder}${path.sep}`;
    expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', spelled, s.context.ctx).ok).toBe(true);
    keychain.set(spelled, login('A', 2));
    rmSync(path.join(s.folder, '.credentials.json'));
    // Something of the folder's own that cannot go into yours yet.
    mkdirSync(path.join(s.folder, 'jobs'));
    writeFileSync(path.join(s.folder, 'jobs', 'one.json'), '{}');
    writeFileSync(s.user('jobs'), 'in the way');
    expect(await editorCommand(s.context, 'off')).toBe(1);

    // A switch meanwhile reaches the item a Claude started before the setting went still reads.
    await use(s, 'B', () => tokenOf(keychain.get(spelled)) === 'a-B-1');
    expect(tokenOf(keychain.get(spelled))).toBe('a-B-1');

    rmSync(s.user('jobs'));
    expect(await editorCommand(s.context, 'off')).toBe(0);

    expect(keychain.has(spelled)).toBe(false);
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(tokenOf(profileLogin(s, 'B'))).toBe('a-B-1');
  });

  it("keeps each editor's spelling of the folder as its setting goes, so the last ccx editor off clears both", async () => {
    const s = await scene();
    await editorOn(s);
    const spelled = `${s.folder}${path.sep}`;
    expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', spelled, s.context.ctx).ok).toBe(true);
    expect(installEditorEnvVar('vscode', 'CLAUDE_CONFIG_DIR', s.folder, s.context.ctx).ok).toBe(true);
    keychain.set(spelled, login('A', 2));
    rmSync(path.join(s.folder, '.credentials.json'));

    expect(await editorCommand(s.context, 'off', { editor: 'cursor' })).toBe(0);
    expect(isRealFolder(s.folder)).toBe(true);
    expect(await editorCommand(s.context, 'off', { editor: 'vscode' })).toBe(0);

    expect(existsSync(s.folder)).toBe(false);
    expect(keychain.has(spelled)).toBe(false);
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
  });

  it('keeps the folder while an editor chat started through it is open, and retires it once that has closed', async () => {
    const s = await scene();
    await editorOn(s);
    // Two editor chats: one started while the setting named the folder, one after it went.
    const before = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const after = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const beforeExited = new Promise((resolve) => before.once('exit', resolve));
    const afterExited = new Promise((resolve) => after.once('exit', resolve));
    try {
      mkdirSync(path.join(s.folder, 'sessions'), { recursive: true });
      const record = (pid: number | undefined, startedAt: number): string =>
        JSON.stringify({ pid, entrypoint: 'claude-vscode', startedAt });
      writeFileSync(path.join(s.folder, 'sessions', `${before.pid}.json`), record(before.pid, Date.now() - 60_000));
      writeFileSync(path.join(s.folder, 'sessions', `${after.pid}.json`), record(after.pid, Date.now() + HOURS));

      expect(await editorCommand(s.context, 'off')).toBe(0);
      expect(isRealFolder(s.folder)).toBe(true);
      await use(s, 'A');
      expect(isRealFolder(s.folder)).toBe(true);

      before.kill();
      await beforeExited;
      await use(s, 'A', () => !existsSync(s.folder));
      expect(existsSync(s.folder)).toBe(false);
    } finally {
      before.kill();
      after.kill();
    }
    await afterExited;
  });

  it('keeps the folder while another editor is still set to it', async () => {
    const s = await scene();
    await editorOn(s);
    expect(await editorCommand(s.context, 'on', { editor: 'vscode' })).toBe(0);
    await settle(150);

    expect(await editorCommand(s.context, 'off', { editor: 'cursor' })).toBe(0);

    expect(isRealFolder(s.folder)).toBe(true);
    expect(readEditorEnvVar('vscode', 'CLAUDE_CONFIG_DIR', s.context.ctx)).toBe(s.folder);
    expect(tokenOf(folderLogin(s))).toBe('a-A-1');
  });

  it('brings the folders it holds of its own into your ~/.claude, and never its locks or backups', async () => {
    const s = await scene();
    await editorOn(s);
    const own = (rel: string, text: string): void => {
      mkdirSync(path.dirname(path.join(s.folder, rel)), { recursive: true });
      writeFileSync(path.join(s.folder, rel), text);
    };
    // One its Claude made that your ~/.claude did not have, and one moved aside when it was linked.
    own(path.join('jobs', 'one.json'), '{"job":1}');
    own(path.join('todos.pre-share', 'list.json'), '[]');
    own(path.join('install.lock', 'pid'), '1');
    own(path.join('backups', '.claude.json.backup'), '{}');

    expect(await editorCommand(s.context, 'off')).toBe(0);

    expect(existsSync(s.folder)).toBe(false);
    expect(read(s.user(path.join('jobs', 'one.json')))).toBe('{"job":1}');
    expect(read(s.user(path.join('todos', 'list.json')))).toBe('[]');
    expect(existsSync(s.user('install.lock'))).toBe(false);
    expect(existsSync(s.user('backups'))).toBe(false);
  });

  it('keeps the folder while a folder it holds of its own cannot go into yours', async () => {
    const s = await scene();
    await editorOn(s);
    mkdirSync(path.join(s.folder, 'jobs'));
    writeFileSync(path.join(s.folder, 'jobs', 'one.json'), '{"job":1}');
    // A file of yours where that folder would go.
    writeFileSync(s.user('jobs'), 'in the way');

    expect(await editorCommand(s.context, 'off')).toBe(1);

    expect(read(path.join(s.folder, 'jobs', 'one.json'))).toBe('{"job":1}');
  });

  it('keeps the folder while something deeper in a folder of its own cannot go into yours', async () => {
    const s = await scene();
    await editorOn(s);
    mkdirSync(path.join(s.folder, 'jobs', 'one'), { recursive: true });
    writeFileSync(path.join(s.folder, 'jobs', 'one', 'state.json'), '{}');
    // Your own jobs folder, with a file where that one would go.
    mkdirSync(s.user('jobs'));
    writeFileSync(s.user(path.join('jobs', 'one')), 'in the way');

    expect(await editorCommand(s.context, 'off')).toBe(1);

    expect(isRealFolder(s.folder)).toBe(true);
  });
});

/** A process that runs until it is killed, standing in for a Claude. */
function stayingProcess(): { pid: number; end: () => Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return {
    pid: child.pid!,
    end: () => {
      child.kill();
      return exited;
    },
  };
}

describe('a Claude ccx-claude runs on the editor folder', () => {
  it('keeps the folder from being retired while it runs, and lets it go once it has ended', async () => {
    const s = await scene();
    await editorOn(s);
    const claude = stayingProcess();
    try {
      // A running chat started before the check; retireEditor skips one started at or after it.
      const ended = noteEditorChat(s.context.ctx, claude.pid, s.folder, Date.now() - 1_000);

      expect(retireEditor(s.context)).toBe('held');
      expect(isRealFolder(s.folder)).toBe(true);

      ended();
      expect(retireEditor(s.context)).toBe('retired');
      expect(existsSync(s.folder)).toBe(false);
    } finally {
      await claude.end();
    }
  });

  it("holds the retirement of the editor folder, but not the merge into an account's folder or a taken-over copy", async () => {
    const s = await scene();
    await editorOn(s);
    const claude = stayingProcess();
    try {
      // A running chat started before the check; retireEditor skips one started at or after it.
      noteEditorChat(s.context.ctx, claude.pid, s.folder, Date.now() - 1_000);

      expect(editorChatsOpen(s.context.ctx, s.folder)).toBe(true);
      expect(retireEditor(s.context)).toBe('held');
      // A Conductor user always has a chat open, and that must not hold off what is done to other folders.
      expect(editorChatsOpen(s.context.ctx, s.dirOf('A'))).toBe(false);
      expect(editorChatsOpen(s.context.ctx, `${s.folder}.taken-over`)).toBe(false);
    } finally {
      await claude.end();
    }
  });

  it('counts for nothing once its process is gone, and its note is cleared', async () => {
    const s = await scene();
    await editorOn(s);
    const claude = stayingProcess();
    noteEditorChat(s.context.ctx, claude.pid, s.folder);
    await claude.end();
    const note = path.join(s.ccx, 'editor-chats', `${claude.pid}.json`);
    expect(existsSync(note)).toBe(true);

    expect(retireEditor(s.context)).toBe('retired');

    expect(existsSync(s.folder)).toBe(false);
    expect(existsSync(note)).toBe(false);
  });
});

describe('a launch from ccx-claude, with the retirement of the editor folder pending', () => {
  /** The setting gone while an editor chat was open, which held the folder's retirement off; that chat has closed since. */
  async function retirementPending(): Promise<Scene> {
    const s = await scene();
    await editorOn(s);
    const chat = stayingProcess();
    mkdirSync(path.join(s.folder, 'sessions'), { recursive: true });
    writeFileSync(
      path.join(s.folder, 'sessions', `${chat.pid}.json`),
      JSON.stringify({
        pid: chat.pid,
        entrypoint: 'claude-vscode',
        startedAt: Date.now() - 60_000,
      }),
    );
    expect(await editorCommand(s.context, 'off')).toBe(0);
    expect(existsSync(path.join(s.ccx, 'editor-retire.json'))).toBe(true);
    await chat.end();
    return s;
  }

  it('clears the retirement and keeps the folder, as an editor setting naming the folder does', async () => {
    const s = await retirementPending();

    const up = await setUpEditor(s.context, { launch: true });

    expect(up.state).toBe('ready');
    expect(existsSync(path.join(s.ccx, 'editor-retire.json'))).toBe(false);
    expect(isRealFolder(s.folder)).toBe(true);
    expect(tokenOf(folderLogin(s))).toBe('a-A-1');
  });

  it('is the only launch to: setting the editor up without one retires the folder, as before', async () => {
    const s = await retirementPending();

    const up = await setUpEditor(s.context);

    expect(up.state).toBe('not-ready');
    expect(existsSync(s.folder)).toBe(false);
  });
});

describe('a launch from ccx-claude, which makes one try at each step', () => {
  it('does not wait for another ccx to end its change to the folder, and leaves the move to the next event', async () => {
    const s = await scene();
    await editorOn(s);
    setActive('B', s.context.ctx);
    const lock = acquireOwnedLock(path.join(s.ccx, 'editor-folder.lock'), {
      waitMs: 0,
      staleMs: 60_000,
      maxHoldMs: 60_000,
    });
    try {
      const started = Date.now();
      const up = await setUpEditor(s.context, { launch: true });

      // It once waited 10 s for the lock.
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(up.state).toBe('not-ready');
      expect(tokenOf(folderLogin(s))).toBe('a-A-1');
    } finally {
      lock.release();
    }

    // An event that moves nothing by itself makes the move, since a launch left it pending.
    await refreshEditor(s.context);
    expect(tokenOf(folderLogin(s))).toBe('a-B-1');
  });

  it("does not look for Claude's locks for long, and leaves the move to the next event", async () => {
    const s = await scene();
    await editorOn(s);
    setActive('B', s.context.ctx);
    s.context.editorMoveRetryMs = 8_000;
    const lock = path.join(s.folder, '.oauth_refresh.lock');
    mkdirSync(lock);

    const started = Date.now();
    const up = await setUpEditor(s.context, { launch: true });

    // A move under a running Claude looks again every 200 ms for as long as editorMoveRetryMs.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(up.state).toBe('meanwhile');
    expect(tokenOf(folderLogin(s))).toBe('a-A-1');
    rmSync(lock, { recursive: true });
    await refreshEditor(s.context);
    expect(tokenOf(folderLogin(s))).toBe('a-B-1');
  });
});

describe("a renewal the editor's Claude made, saved home from a running session", () => {
  it('neither waits for, nor writes past, the lock of a profile sharing that login', async () => {
    const s = await scene();
    await editorOn(s);
    // C is a second profile on A's login, as signing in twice leaves, and
    // another ccx is changing C's login right now.
    await addCommand(s.context, 'C', { dir: s.dirOf('C'), login: false });
    mkdirSync(s.dirOf('C'), { recursive: true });
    writeFileSync(path.join(s.dirOf('C'), '.credentials.json'), login('A', 1));
    mkdirSync(path.join(s.dirOf('C'), '.oauth_refresh.lock'));
    writeFileSync(path.join(s.folder, '.credentials.json'), login('A', 2));

    const started = Date.now();
    const took = await takeUpEditorRenewal(s.context.ctx, {
      ...(s.context.lookupOwner ? { lookupOwner: s.context.lookupOwner } : {}),
      lockWaitMs: 0,
    });

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(took).toBe('taken');
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(tokenOf(profileLogin(s, 'C'))).toBe('a-A-1');
  });
});

describe('whether the account the editor is on is signed in, as ccx doctor says', () => {
  it("is not, when that account's saved login was refused, though the folder's text differs from it by its MCP logins", async () => {
    const s = await scene();
    await editorOn(s);
    writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(folderLogin(s)!, MCP));
    expect(editorStanding(s.context)).toEqual({ name: 'A', loggedIn: true });

    rememberDeadLogin(credentialFileFingerprint(s.dirOf('A')), 'invalid_grant', s.context.ctx);

    expect(editorStanding(s.context)).toEqual({ name: 'A', loggedIn: false });
  });

  it('is, when the folder holds a login its Claude renewed since the saved one was refused', async () => {
    const s = await scene();
    await editorOn(s);
    rememberDeadLogin(credentialFileFingerprint(s.dirOf('A')), 'invalid_grant', s.context.ctx);
    writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(login('A', 2), MCP));

    expect(editorStanding(s.context)).toEqual({ name: 'A', loggedIn: true });
  });

  it("is not, when the folder's own login was refused", async () => {
    const s = await scene();
    await editorOn(s);
    rememberDeadLogin(sha256Fingerprint(folderLogin(s)!), 'invalid_grant', s.context.ctx);

    expect(editorStanding(s.context)).toEqual({ name: 'A', loggedIn: false });
  });
});

describe('the MCP logins in the editor folder', () => {
  const tokenResponse = (name: string, gen: number): Response =>
    new Response(
      JSON.stringify({
        access_token: `a-${name}-${gen}`,
        refresh_token: `r-${name}-${gen}`,
        expires_in: 8 * 3600,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('stay in the folder when it moves to the next account', async () => {
    const s = await scene();
    await editorOn(s);
    // Signed in to an MCP server in the editor's Claude, which keeps it beside the account's login.
    writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(login('A', 1)));

    await use(s, 'B', () => tokenOf(folderLogin(s)) === 'a-B-1');

    expect(tokenOf(folderLogin(s))).toBe('a-B-1');
    expect(mcpOf(folderLogin(s))).toEqual(MCP);
  });

  it("are the folder's own, not those the next account's saved login carries from a store that has ended", async () => {
    const s = await scene();
    await editorOn(s);
    writeFileSync(path.join(s.dirOf('B'), '.credentials.json'), withMcp(login('B', 1), PARKED));
    writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(login('A', 1)));

    await use(s, 'B', () => tokenOf(folderLogin(s)) === 'a-B-1');

    expect(mcpOf(folderLogin(s))).toEqual(MCP);
    // And the account's saved login is not written to.
    expect(mcpOf(profileLogin(s, 'B'))).toEqual(PARKED);
  });

  it('are none, in a folder that has none, whatever the next account was saved with', async () => {
    const s = await scene();
    await editorOn(s);
    writeFileSync(path.join(s.dirOf('B'), '.credentials.json'), withMcp(login('B', 1), PARKED));

    await use(s, 'B', () => tokenOf(folderLogin(s)) === 'a-B-1');

    expect(mcpOf(folderLogin(s))).toBeUndefined();
  });

  it('stay in the Keychain item its Claude saved the login in', async () => {
    const s = await scene();
    await editorOn(s);
    keychain.set(s.folder, withMcp(login('A', 1)));
    rmSync(path.join(s.folder, '.credentials.json'));

    await use(s, 'B', () => tokenOf(keychain.get(s.folder)) === 'a-B-1');

    expect(mcpOf(keychain.get(s.folder))).toEqual(MCP);
    // Nothing of it in the file, which holds only what makes Claude read the item again.
    expect(mcpOf(folderLogin(s))).toBeUndefined();
  });

  it('are each kept by the item of each way the editors spell the folder', async () => {
    const s = await scene();
    await editorOn(s);
    const spelled = `${s.folder}${path.sep}`;
    expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', spelled, s.context.ctx).ok).toBe(
      true,
    );
    expect(installEditorEnvVar('vscode', 'CLAUDE_CONFIG_DIR', s.folder, s.context.ctx).ok).toBe(
      true,
    );
    // Two Claudes on the folder, each with an item of its own and a sign-in of its own.
    keychain.set(spelled, withMcp(login('A', 1), mcpLogins(1)));
    keychain.set(s.folder, withMcp(login('A', 1), mcpLogins(2)));
    rmSync(path.join(s.folder, '.credentials.json'));

    await use(
      s,
      'B',
      () =>
        tokenOf(keychain.get(spelled)) === 'a-B-1' && tokenOf(keychain.get(s.folder)) === 'a-B-1',
    );

    expect(mcpOf(keychain.get(spelled))).toEqual(mcpLogins(1));
    expect(mcpOf(keychain.get(s.folder))).toEqual(mcpLogins(2));
  });

  it("leave the next account's login exactly as saved when neither holds any", async () => {
    const s = await scene();
    await editorOn(s);
    const saved = `${JSON.stringify(JSON.parse(login('B', 1)), null, 2)}\n`;
    writeFileSync(path.join(s.dirOf('B'), '.credentials.json'), saved);

    await use(s, 'B', () => tokenOf(folderLogin(s)) === 'a-B-1');

    expect(folderLogin(s)).toBe(saved);
  });

  it("start with those parked in the account's saved login, in the folder made for the editor", async () => {
    const s = await scene();
    writeFileSync(
      path.join(s.dirOf('A'), '.credentials.json'),
      withMcp(login('A', 1), mcpLogins(3)),
    );

    await editorOn(s);

    expect(mcpOf(folderLogin(s))).toEqual(mcpLogins(3));
  });

  it('stay in the folder when a renewal made elsewhere is carried into it', async () => {
    const s = await scene();
    await editorOn(s);
    writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(login('A', 1)));
    // Another ccx renewed A's login; the account's saved login carries older MCP logins.
    writeFileSync(path.join(s.dirOf('A'), '.credentials.json'), withMcp(login('A', 2), PARKED));

    await refreshEditor(s.context);

    expect(tokenOf(folderLogin(s))).toBe('a-A-2');
    expect(mcpOf(folderLogin(s))).toEqual(MCP);
  });

  it('stay in the folder when ccx renews the login it holds', async () => {
    const s = await scene();
    const due = (): number => Date.now() + 60_000;
    writeFileSync(
      path.join(s.dirOf('A'), '.credentials.json'),
      withMcp(login('A', 1, due()), PARKED),
    );
    await editorOn(s);
    writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(login('A', 1, due())));

    const outcome = await refreshCredentialIfExpired(s.dirOf('A'), {
      ctx: s.context.ctx,
      fetchImpl: () => Promise.resolve(tokenResponse('A', 2)),
    });

    expect(outcome.status).toBe('refreshed');
    expect(tokenOf(folderLogin(s))).toBe('a-A-2');
    expect(mcpOf(folderLogin(s))).toEqual(MCP);
    // The saved login keeps its own through its renewal.
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(mcpOf(profileLogin(s, 'A'))).toEqual(PARKED);
  });

  it("leave an account's saved login its own when a renewal the editor made is saved home", async () => {
    const s = await scene();
    await editorOn(s);
    // The saved login carries older MCP logins, parked by a store that has ended.
    writeFileSync(path.join(s.dirOf('A'), '.credentials.json'), withMcp(login('A', 1), PARKED));
    writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(login('A', 2)));

    const took = await takeUpEditorRenewal(s.context.ctx, {
      ...(s.context.lookupOwner ? { lookupOwner: s.context.lookupOwner } : {}),
    });

    expect(took).toBe('taken');
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(mcpOf(profileLogin(s, 'A'))).toEqual(PARKED);
    // The folder, which lives on, keeps its own.
    expect(mcpOf(folderLogin(s))).toEqual(MCP);
  });

  it("leave an account's saved login its own when the editor moves off it with a renewal", async () => {
    const s = await scene();
    await editorOn(s);
    writeFileSync(path.join(s.dirOf('A'), '.credentials.json'), withMcp(login('A', 1), PARKED));
    writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(login('A', 2)));
    // Whose it is cannot be asked, so the move saves it home by who the folder says it is.
    s.context.lookupOwner = () => Promise.resolve(null);

    await use(s, 'B', () => tokenOf(folderLogin(s)) === 'a-B-1');

    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
    expect(mcpOf(profileLogin(s, 'A'))).toEqual(PARKED);
    expect(mcpOf(folderLogin(s))).toEqual(MCP);
  });

  describe('when the folder is retired', () => {
    /** The editor on A, whose folder and saved login hold one Claude login; the saved one carries older MCP logins. */
    async function sameLoginOnA(): Promise<{ s: Scene; held: string }> {
      const s = await scene();
      await editorOn(s);
      const held = folderLogin(s)!;
      writeFileSync(path.join(s.dirOf('A'), '.credentials.json'), withMcp(held, PARKED));
      writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(held, MCP));
      return { s, held };
    }

    it("are parked in the account's saved login though the folder's Claude login is no newer, and its Claude login stays", async () => {
      const { s, held } = await sameLoginOnA();

      expect(await editorCommand(s.context, 'off')).toBe(0);

      expect(existsSync(s.folder)).toBe(false);
      expect(profileLogin(s, 'A')).toBe(withMcp(held, MCP));
    });

    it('are parked server by server, so the saved login keeps a server the folder does not hold', async () => {
      const { s, held } = await sameLoginOnA();
      writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(held, datadogLogins(2)));

      expect(await editorCommand(s.context, 'off')).toBe(0);

      expect(existsSync(s.folder)).toBe(false);
      expect(mcpOf(profileLogin(s, 'A'))).toEqual({ ...PARKED, ...datadogLogins(2) });
      expect(tokenOf(profileLogin(s, 'A'))).toBe(tokenOf(held));
    });

    it('are parked server by server too when the folder takes its newer Claude login home', async () => {
      const { s } = await sameLoginOnA();
      writeFileSync(
        path.join(s.folder, '.credentials.json'),
        withMcp(login('A', 2), datadogLogins(2)),
      );

      expect(await editorCommand(s.context, 'off')).toBe(0);

      expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
      expect(mcpOf(profileLogin(s, 'A'))).toEqual({ ...PARKED, ...datadogLogins(2) });
    });

    it('are none to park in an empty set, which leaves the saved login as it is', async () => {
      const { s, held } = await sameLoginOnA();
      writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(held, {}));

      expect(await editorCommand(s.context, 'off')).toBe(0);

      expect(existsSync(s.folder)).toBe(false);
      expect(profileLogin(s, 'A')).toBe(withMcp(held, PARKED));
    });

    it('are none to park in an empty set when the folder takes its newer Claude login home', async () => {
      const { s } = await sameLoginOnA();
      writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(login('A', 2), {}));

      expect(await editorCommand(s.context, 'off')).toBe(0);

      expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
      expect(mcpOf(profileLogin(s, 'A'))).toEqual(PARKED);
    });

    describe('held in more than one place', () => {
      /** Two editors set to the folder, spelled two ways, each Claude with a Keychain item of its own. */
      async function twoSpellings() {
        const { s, held } = await sameLoginOnA();
        const first = `${s.folder}${path.sep}`;
        const second = s.folder;
        expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', first, s.context.ctx).ok).toBe(
          true,
        );
        expect(installEditorEnvVar('vscode', 'CLAUDE_CONFIG_DIR', second, s.context.ctx).ok).toBe(
          true,
        );
        rmSync(path.join(s.folder, '.credentials.json'));
        return { s, held, first, second };
      }
      /** `ccx editor off` for both editors, the last of which retires the folder. */
      async function offForBoth(s: Scene): Promise<number> {
        expect(await editorCommand(s.context, 'off', { editor: 'cursor' })).toBe(0);
        return editorCommand(s.context, 'off', { editor: 'vscode' });
      }

      it('are parked from every Keychain item of the folder, whichever way an editor spells it', async () => {
        const { s, held, first, second } = await twoSpellings();
        keychain.set(first, withMcp(held, mcpLogins(1)));
        keychain.set(second, withMcp(held, datadogLogins(2)));

        expect(await offForBoth(s)).toBe(0);

        expect(existsSync(s.folder)).toBe(false);
        expect(keychain.has(first)).toBe(false);
        expect(keychain.has(second)).toBe(false);
        expect(mcpOf(profileLogin(s, 'A'))).toEqual({ ...mcpLogins(1), ...datadogLogins(2) });
      });

      it.each([
        ['the older first', 0],
        ['the newer first', 1],
      ])(
        'are the newest for a server that more than one item holds, with %s',
        async (_order, newerIs) => {
          const { s, held, first, second } = await twoSpellings();
          const older = notionExpiring(1_900_000_000_000, 'older');
          const newer = notionExpiring(1_900_003_600_000, 'newer');
          keychain.set(
            first,
            withMcp(held, newerIs === 1 ? { ...newer, ...datadogLogins(2) } : older),
          );
          keychain.set(
            second,
            withMcp(held, newerIs === 1 ? older : { ...newer, ...datadogLogins(2) }),
          );

          expect(retireEditor(s.context, [first, second])).toBe('retired');

          expect(mcpOf(profileLogin(s, 'A'))).toEqual({ ...newer, ...datadogLogins(2) });
        },
      );

      it('are those of the first item for a server whose sign-ins expire together', async () => {
        const { s, held, first, second } = await twoSpellings();
        keychain.set(first, withMcp(held, notionExpiring(1_900_000_000_000, 'first')));
        keychain.set(
          second,
          withMcp(held, { ...notionExpiring(1_900_000_000_000, 'second'), ...datadogLogins(2) }),
        );

        expect(retireEditor(s.context, [first, second])).toBe('retired');

        expect(mcpOf(profileLogin(s, 'A'))).toEqual({
          ...notionExpiring(1_900_000_000_000, 'first'),
          ...datadogLogins(2),
        });
      });

      it('are those of the first item for a server when either sign-in has no expiry', async () => {
        const { s, held, first, second } = await twoSpellings();
        const undated = {
          'notion|1': { serverName: 'notion', accessToken: 'mcp-access-fake-undated' },
        };
        keychain.set(first, withMcp(held, undated));
        keychain.set(second, withMcp(held, notionExpiring(1_900_000_000_000, 'dated')));

        expect(retireEditor(s.context, [first, second])).toBe('retired');

        expect(mcpOf(profileLogin(s, 'A'))).toEqual(undated);
      });

      it("are not read from the folder's file while every spelling holds an item", async () => {
        const { s, held } = await sameLoginOnA();
        // The file is left from when the folder was made with Notion. A Claude on the item holds Datadog.
        keychain.set(s.folder, withMcp(held, datadogLogins(2)));

        expect(await editorCommand(s.context, 'off')).toBe(0);

        expect(existsSync(s.folder)).toBe(false);
        expect(mcpOf(profileLogin(s, 'A'))).toEqual({ ...PARKED, ...datadogLogins(2) });
      });

      it("are read from the folder's file when a spelling has no item, as its Claude reads it", async () => {
        const { s, held, first } = await twoSpellings();
        keychain.set(first, withMcp(held, mcpLogins(1)));
        // The other spelling has no item, so a Claude given it reads the file.
        writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(held, datadogLogins(2)));

        expect(await offForBoth(s)).toBe(0);

        expect(existsSync(s.folder)).toBe(false);
        expect(mcpOf(profileLogin(s, 'A'))).toEqual({ ...mcpLogins(1), ...datadogLogins(2) });
      });

      it('are parked from every item too when the folder takes a newer Claude login home', async () => {
        const { s, first, second } = await twoSpellings();
        keychain.set(first, withMcp(login('A', 2), mcpLogins(1)));
        keychain.set(second, withMcp(login('A', 2), datadogLogins(2)));

        expect(await offForBoth(s)).toBe(0);

        expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
        expect(mcpOf(profileLogin(s, 'A'))).toEqual({ ...mcpLogins(1), ...datadogLogins(2) });
      });

      it('keep the folder while one of its items cannot be read, since it may hold sign-ins nothing else does', async () => {
        const { s, held, first, second } = await twoSpellings();
        keychain.set(first, withMcp(held, mcpLogins(1)));
        keychain.set(second, withMcp(held, datadogLogins(2)));

        // The item ccx reads second: what it holds is read all the same, or the folder is kept.
        expect(await whileUnreadable(s, () => offForBoth(s), first)).toBe(1);

        expect(isRealFolder(s.folder)).toBe(true);
        expect(keychain.has(first)).toBe(true);
        expect(mcpOf(profileLogin(s, 'A'))).toEqual(PARKED);
      });
    });

    it('start the folder made for the editor next, from the saved login', async () => {
      const { s } = await sameLoginOnA();
      expect(await editorCommand(s.context, 'off')).toBe(0);

      await editorOn(s);

      expect(mcpOf(folderLogin(s))).toEqual(MCP);
    });

    it("go with the rest of the folder's login home when that is newer", async () => {
      const { s } = await sameLoginOnA();
      writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(login('A', 2), MCP));

      expect(await editorCommand(s.context, 'off')).toBe(0);

      expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
      expect(mcpOf(profileLogin(s, 'A'))).toEqual(MCP);
    });

    it('leave the saved login exactly as it is when the folder holds none', async () => {
      const { s, held } = await sameLoginOnA();
      writeFileSync(path.join(s.folder, '.credentials.json'), held);

      expect(await editorCommand(s.context, 'off')).toBe(0);

      expect(profileLogin(s, 'A')).toBe(withMcp(held, PARKED));
    });

    it('are parked all the same when the folder is signed in as someone else, and the account keeps its Claude login', async () => {
      const { s, held } = await sameLoginOnA();
      // B was signed in to in the editor's Claude: a newer login than A's, and not A's to be given.
      writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(login('B', 2), MCP));
      const state = path.join(s.folder, '.claude.json');
      writeFileSync(
        state,
        JSON.stringify({
          ...json(state),
          oauthAccount: { emailAddress: emailOf('B'), accountUuid: 'uuid-B' },
        }),
      );

      expect(await editorCommand(s.context, 'off')).toBe(0);

      expect(existsSync(s.folder)).toBe(false);
      expect(tokenOf(profileLogin(s, 'A'))).toBe(tokenOf(held));
      expect(mcpOf(profileLogin(s, 'A'))).toEqual(MCP);
    });

    it('are parked all the same when the folder does not say who it is signed in as', async () => {
      const { s, held } = await sameLoginOnA();
      // A newer login that cannot be confirmed to be A's, so it is not saved home.
      writeFileSync(path.join(s.folder, '.credentials.json'), withMcp(login('A', 2), MCP));
      const state = path.join(s.folder, '.claude.json');
      const unsigned = json(state);
      delete unsigned.oauthAccount;
      writeFileSync(state, JSON.stringify(unsigned));

      expect(await editorCommand(s.context, 'off')).toBe(0);

      expect(existsSync(s.folder)).toBe(false);
      expect(tokenOf(profileLogin(s, 'A'))).toBe(tokenOf(held));
      expect(mcpOf(profileLogin(s, 'A'))).toEqual(MCP);
    });

    it('are not parked from a refused folder that holds none, which leaves the saved login as it is', async () => {
      const { s, held } = await sameLoginOnA();
      writeFileSync(path.join(s.folder, '.credentials.json'), login('B', 2));
      const state = path.join(s.folder, '.claude.json');
      writeFileSync(
        state,
        JSON.stringify({
          ...json(state),
          oauthAccount: { emailAddress: emailOf('B'), accountUuid: 'uuid-B' },
        }),
      );

      expect(await editorCommand(s.context, 'off')).toBe(0);

      expect(profileLogin(s, 'A')).toBe(withMcp(held, PARKED));
    });

    it('are left to the saved login that holds them when the folder, whose login is newer, holds none', async () => {
      const { s } = await sameLoginOnA();
      writeFileSync(path.join(s.folder, '.credentials.json'), login('A', 2));

      expect(await editorCommand(s.context, 'off')).toBe(0);

      expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
      expect(mcpOf(profileLogin(s, 'A'))).toEqual(PARKED);
    });

    it('are kept in a saved login of their own when the account has none, and it still reads as signed out', async () => {
      const { s, held } = await sameLoginOnA();
      // The folder's Claude signed out and kept its MCP logins, and the account's saved login is gone.
      writeFileSync(
        path.join(s.folder, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' }, mcpOAuth: MCP }),
      );
      rmSync(path.join(s.dirOf('A'), '.credentials.json'));

      expect(await editorCommand(s.context, 'off')).toBe(0);

      expect(existsSync(s.folder)).toBe(false);
      expect(mcpOf(profileLogin(s, 'A'))).toEqual(MCP);
      expect(tokenOf(profileLogin(s, 'A'))).toBeNull();
      expect(held).toBeTruthy();
    });

    it(
      "keep the folder, and its login, while the account's saved login cannot be written, and park them once it can",
      { timeout: 30_000 },
      async () => {
        const { s, held } = await sameLoginOnA();
        const lock = path.join(s.dirOf('A'), '.oauth_refresh.lock');
        mkdirSync(lock);

        expect(await editorCommand(s.context, 'off')).toBe(1);

        expect(mcpOf(folderLogin(s))).toEqual(MCP);
        expect(mcpOf(profileLogin(s, 'A'))).toEqual(PARKED);

        rmSync(lock, { recursive: true });
        expect(await editorCommand(s.context, 'off')).toBe(0);

        expect(existsSync(s.folder)).toBe(false);
        expect(profileLogin(s, 'A')).toBe(withMcp(held, MCP));
      },
    );
  });

  it('stay in the folder when a renewal waiting in the carry queue is made', async () => {
    const s = await scene();
    await editorOn(s);
    const held = withMcp(login('A', 1));
    writeFileSync(path.join(s.folder, '.credentials.json'), held);
    writeFileSync(path.join(s.dirOf('A'), '.credentials.json'), withMcp(login('A', 2), PARKED));
    queueEditorCarry(s.context.ctx, loginTextFingerprint(held)!, s.dirOf('A'));

    expect(await retryEditorCarries(s.context.ctx)).toBe(true);

    expect(tokenOf(folderLogin(s))).toBe('a-A-2');
    expect(mcpOf(folderLogin(s))).toEqual(MCP);
  });
});
