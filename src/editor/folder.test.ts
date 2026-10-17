import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
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
import { addCommand } from '../commands/add.js';
import { useCommand } from '../commands/use.js';
import { editorCommand } from '../commands/editor.js';
import { setActive } from '../state/active.js';
import { loadConfig } from '../config/config.js';
import { installEditorEnvVar, readEditorEnvVar } from './install.js';
import { readTarget, setTarget } from '../daemon/junction.js';
import { refreshCredentialIfExpired } from '../usage/oauth-refresh.js';
import { renewIdleLogin } from '../usage/usage-store.js';
import { listAccounts } from '../accounts/registry.js';
import type { CliContext } from '../context.js';

/**
 * The editor's Claude folder, end to end through the commands that set it up
 * and switch it: `ccx editor on|off` and `ccx use`, and the renewals that touch
 * the login it holds. The Keychain is a map here, never the real one; it is
 * keyed by the folder exactly as Claude names its item, by the text it was
 * given.
 */

const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock('../accounts/keychain.js', () => ({
  keychainService: (dir: string) => `Claude Code-credentials-${dir}`,
  readKeychainCredential: vi.fn((dir: string) => keychain.get(dir) ?? null),
  writeKeychainCredential: vi.fn((dir: string, text: string) => {
    keychain.set(dir, text);
  }),
  deleteKeychainCredential: vi.fn((dir: string) => {
    keychain.delete(dir);
  }),
}));

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
  expect(editorCommand(s.context, 'on')).toBe(0);
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

    expect(editorCommand(s.context, 'on')).toBe(0);
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

  it("cuts the request off well inside the time Claude waits for that lock", { timeout: 20_000 }, async () => {
    const s = await dueOnA();
    const started = Date.now();
    const outcome = await refreshCredentialIfExpired(s.dirOf('A'), {
      ctx: s.context.ctx,
      requestTimeoutMs: 10_000,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });

    expect(isRealFolder(s.folder)).toBe(true);
    expect(outcome.status).toBe('unavailable');
    // Claude 2.1.302 gives up on the lock after at least 4 s.
    expect(Date.now() - started).toBeLessThan(4_000);
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
});

describe('an install on the old link, moved into the folder', () => {
  /** An install from before: the editor set to the link, which leads to `name`'s folder. */
  async function onTheLink(name: string): Promise<Scene> {
    const s = await scene();
    setTarget(s.folder, s.dirOf(name));
    expect(installEditorEnvVar('cursor', 'CLAUDE_CONFIG_DIR', s.folder, s.context.ctx).ok).toBe(true);
    return s;
  }

  it("moves at the first switch, at the same path, with the account folders' chats merged and their own files kept aside", async () => {
    const s = await onTheLink('A');
    const put = (file: string, text: string): void => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    };
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

    expect(editorCommand(s.context, 'off')).toBe(0);

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

    expect(editorCommand(s.context, 'off')).toBe(0);

    expect(keychain.has(spelled)).toBe(false);
    expect(keychain.has(s.folder)).toBe(false);
    expect(tokenOf(profileLogin(s, 'A'))).toBe('a-A-2');
  });

  it('keeps the folder while another editor is still set to it', async () => {
    const s = await scene();
    await editorOn(s);
    expect(editorCommand(s.context, 'on', { editor: 'vscode' })).toBe(0);
    await settle(150);

    expect(editorCommand(s.context, 'off', { editor: 'cursor' })).toBe(0);

    expect(isRealFolder(s.folder)).toBe(true);
    expect(readEditorEnvVar('vscode', 'CLAUDE_CONFIG_DIR', s.context.ctx)).toBe(s.folder);
    expect(tokenOf(folderLogin(s))).toBe('a-A-1');
  });
});
