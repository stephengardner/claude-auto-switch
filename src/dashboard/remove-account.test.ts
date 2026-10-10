import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addAccount, getAccount, listAccounts } from '../accounts/registry.js';
import { credentialPath } from '../accounts/credential-vault.js';
import { removalStanding, type RemovalStanding } from '../accounts/removal.js';
import { getActive, setActive } from '../state/active.js';
import { setTarget } from '../daemon/junction.js';
import { loadConfig } from '../config/config.js';
import { removeCommand } from '../commands/remove.js';
import { promptKey, type PromptState } from './prompt.js';
import { openRemoval, readRemovalAnswer, removeQuestion, submitRemoval } from './remove-account.js';
import { renderDashboard } from './render.js';
import type { CliContext } from '../context.js';
import type { SessionLease } from '../session/lease.js';

// Never the machine's real Keychain: a login here is a file in a temp folder.
vi.mock('../accounts/keychain.js', () => ({
  readKeychainCredential: () => null,
  writeKeychainCredential: () => {
    throw new Error('no Keychain in tests');
  },
  deleteKeychainCredential: () => {},
}));

const lease = (pid: number, account: string, cwd: string): SessionLease => ({
  pid,
  account,
  configDir: path.join('sessions', String(pid)),
  cwd,
  at: 1,
});

const standing = (over: Partial<RemovalStanding> = {}): RemovalStanding => ({
  name: 'old',
  dir: path.join('profiles', 'old'),
  leases: [],
  active: false,
  last: false,
  editor: false,
  daemon: false,
  others: [],
  folderIsOurs: true,
  ...over,
});

const KEEP = 'Type y to remove it from ccx and keep its folder and login';
const EITHER =
  `${KEEP}, or purge old to delete its folder too: ` +
  'its login is deleted, and it must be signed in again to come back.';

describe('the question x asks', () => {
  it('names the account and both answers, the one that deletes its login said in full', () => {
    expect(removeQuestion(standing())).toBe(`remove "old"? ${EITHER}`);
  });

  it('says new sessions start elsewhere when it is the account they start on', () => {
    expect(removeQuestion(standing({ active: true }))).toBe(
      `remove "old"? New sessions start on it: they will start on the next pick instead. ${EITHER}`,
    );
  });

  it('says ccx is left with nothing to run on when it is the only account', () => {
    // Being the account new sessions start on adds nothing once there is none.
    expect(removeQuestion(standing({ last: true, active: true }))).toBe(
      `remove "old"? It is your only account: ccx cannot start claude until you add one. ${EITHER}`,
    );
  });

  it('says what a running session does, and offers no deleting of the folder it saves its login to', () => {
    expect(removeQuestion(standing({ leases: [lease(11, 'old', '/w/api')] }))).toBe(
      'remove "old"? 1 session is on it (api): it keeps going until it next moves, then uses another account. ' +
        `${KEEP}. Its folder cannot be deleted while 1 session is running on it.`,
    );
  });

  it('says the same of several sessions, each by its folder', () => {
    const running = [lease(11, 'old', '/w/api'), lease(12, 'old', '/w/web')];
    expect(removeQuestion(standing({ leases: running }))).toContain(
      '2 sessions are on it (api, web): they keep going until they next move, then use another account.',
    );
  });

  it('says a session on the only account ends, since it has nowhere to move', () => {
    expect(
      removeQuestion(standing({ last: true, leases: [lease(11, 'old', '/w/api')] })),
    ).toContain(
      '1 session is on it (api): it keeps going until its next limit or restart, then ends.',
    );
  });

  it('says the editor stays on it, and offers no deleting of the folder the editor reads', () => {
    expect(removeQuestion(standing({ editor: true }))).toBe(
      'remove "old"? Your editor is on it, and stays on it until the next switch. ' +
        `${KEEP}. Its folder cannot be deleted while your editor is on it.`,
    );
  });

  it("offers no deleting of the folder the daemon's link is on", () => {
    expect(removeQuestion(standing({ daemon: true }))).toBe(
      `remove "old"? ${KEEP}. Its folder cannot be deleted while the daemon's link is on it.`,
    );
  });

  it('offers no deleting of a folder another account keeps its login in', () => {
    expect(removeQuestion(standing({ others: ['work'] }))).toBe(
      `remove "old"? ${KEEP}. Its folder cannot be deleted while "work" keeps its login there.`,
    );
  });

  it('does not promise to delete a folder outside the profiles tree, only its login', () => {
    expect(removeQuestion(standing({ folderIsOurs: false }))).toBe(
      `remove "old"? ${KEEP}, or purge old to delete its login too: ` +
        'it must be signed in again to come back. Its folder is outside the profiles folder and is left.',
    );
  });

  it('is drawn whole, wrapped rather than cut, however narrow the window', () => {
    const question = removeQuestion(
      standing({ active: true, editor: true, leases: [lease(11, 'old', '/w/api')] }),
    );
    for (const width of [116, 80, 48]) {
      const frame = renderDashboard(
        { accounts: [], events: [], now: 0, refreshMs: 3000 },
        { color: false, interactive: true, width, prompt: { label: question, text: '' } },
      );
      const lines = frame.split('\n');
      for (const line of lines)
        expect(line.length, `at ${width}: ${line}`).toBeLessThanOrEqual(width);
      const drawn = lines.map((l) => l.trim()).join(' ');
      expect(drawn, `at ${width}`).toContain(question);
    }
  });
});

describe('reading the answer', () => {
  it('takes y or yes as remove and keep the folder', () => {
    for (const typed of ['y', 'Y', ' yes ']) {
      expect(readRemovalAnswer(typed, standing())).toEqual({ kind: 'remove', purge: false });
    }
  });

  it('takes n, no or nothing as leave it', () => {
    for (const typed of ['n', 'No', '', '  ']) {
      expect(readRemovalAnswer(typed, standing())).toEqual({ kind: 'leave' });
    }
  });

  it('deletes the folder only for purge and the name of this account, typed out', () => {
    expect(readRemovalAnswer('purge old', standing())).toEqual({ kind: 'remove', purge: true });
    expect(readRemovalAnswer('  PURGE   old ', standing())).toEqual({
      kind: 'remove',
      purge: true,
    });
  });

  it('refuses purge alone, purge of another name, or of this name in another case, saying what to type', () => {
    for (const typed of ['purge', 'purge work', 'purge Old', 'purge old now']) {
      expect(readRemovalAnswer(typed, standing())).toEqual({
        kind: 'refuse',
        error: 'to delete its folder too, type: purge old',
      });
    }
  });

  it('refuses purge while something is using the folder, and says what still works', () => {
    expect(readRemovalAnswer('purge old', standing({ editor: true }))).toEqual({
      kind: 'refuse',
      error:
        'its folder cannot be deleted while your editor is on it; y removes it and keeps its folder',
    });
  });

  it('refuses anything else rather than guess, so a stray key removes nothing', () => {
    for (const typed of ['old', 'x', 'jk', 'remove', 'yy']) {
      expect(readRemovalAnswer(typed, standing())).toEqual({
        kind: 'refuse',
        error: 'type y to remove "old", or esc to leave it',
      });
    }
  });
});

/** A throwaway ccx home with real accounts, and the real command doing the removing. */
function home(names: string[] = ['work', 'old']) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccx-dash-remove-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: root, HOME: root, USERPROFILE: root } };
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
  const dirOf = (name: string): string => path.join(root, 'profiles', name);
  for (const name of names) {
    mkdirSync(dirOf(name), { recursive: true });
    writeFileSync(credentialPath(dirOf(name)), '{}', 'utf8');
    addAccount({ name, dir: dirOf(name) }, ctx);
  }
  const running: SessionLease[] = [];
  const deps = (name: string) => ({
    standing: () => removalStanding(name, context.config, ctx, () => running),
    remove: (purge: boolean) => {
      const said: string[] = [];
      const code = removeCommand(
        { ...context, out: (m) => said.push(m) },
        name,
        { purge },
        () => running,
      );
      return { ok: code === 0, text: said.join(' ') };
    },
  });
  /** Press x on `name`, type `answer`, press enter. */
  const answer = (name: string, typed: string, box?: PromptState) => {
    let state = box ?? openRemoval(deps(name).standing()!);
    for (const ch of `${typed}\r`) state = promptKey(state, ch, ch.charCodeAt(0));
    return submitRemoval(state, name, deps(name));
  };
  return { root, ctx, dirOf, running, deps, answer, editorLink: path.join(root, 'editor-active') };
}

describe('removing an account from the dashboard', () => {
  it('opens a box that asks the question and waits for a typed answer', () => {
    const { deps } = home();
    const box = openRemoval(deps('old').standing()!);
    expect(box).toMatchObject({ kind: 'remove', text: '', status: 'editing' });
    expect(box.label).toContain('remove "old"?');
  });

  it('removes it on y and says what the command said, folder kept', () => {
    const { ctx, dirOf, answer } = home();
    const done = answer('old', 'y');
    expect(done).toEqual({
      box: null,
      notice: `removed "old" (profile folder kept at ${dirOf('old')})`,
    });
    expect(getAccount('old', ctx)).toBeUndefined();
    expect(existsSync(credentialPath(dirOf('old')))).toBe(true);
  });

  it('deletes the folder and its login only on purge and the name', () => {
    const { ctx, dirOf, answer } = home();
    const done = answer('old', 'purge old');
    expect(done).toEqual({ box: null, notice: `removed "old" and purged ${dirOf('old')}` });
    expect(getAccount('old', ctx)).toBeUndefined();
    expect(existsSync(dirOf('old'))).toBe(false);
  });

  it('removes nothing on a stray answer, and keeps the box open to say what to type', () => {
    const { ctx, answer } = home();
    for (const typed of ['jk', 'purge', 'purge work']) {
      const done = answer('old', typed);
      expect(done.box).toMatchObject({ status: 'editing', text: typed });
      expect(done.box?.error).toBeTruthy();
      expect(getAccount('old', ctx)).toBeDefined();
    }
  });

  it('closes without removing on n', () => {
    const { ctx, answer } = home();
    expect(answer('old', 'n')).toEqual({ box: null });
    expect(getAccount('old', ctx)).toBeDefined();
  });

  it('removes the active account: says where new sessions start, then clears the pin', () => {
    const { ctx, deps, answer } = home();
    setActive('old', ctx);
    expect(openRemoval(deps('old').standing()!).label).toContain(
      'New sessions start on it: they will start on the next pick instead.',
    );
    expect(answer('old', 'y').box).toBeNull();
    expect(getActive(ctx)).toBeNull();
    expect(listAccounts(ctx).map((a) => a.name)).toEqual(['work']);
  });

  it('removes the last account: says ccx has nothing left, then leaves an empty list', () => {
    const { ctx, deps, answer } = home(['only']);
    expect(openRemoval(deps('only').standing()!).label).toContain(
      'It is your only account: ccx cannot start claude until you add one.',
    );
    expect(answer('only', 'y').box).toBeNull();
    expect(listAccounts(ctx)).toEqual([]);
  });

  it("removes the editor's account: says the editor stays on it, keeps the folder it reads, and will not delete it", () => {
    const { ctx, dirOf, deps, answer, editorLink } = home();
    setTarget(editorLink, dirOf('old'));
    const box = openRemoval(deps('old').standing()!);
    expect(box.label).toContain('Your editor is on it, and stays on it until the next switch.');
    expect(box.label).not.toContain('purge old');

    const refused = answer('old', 'purge old');
    expect(refused.box?.error).toBe(
      'its folder cannot be deleted while your editor is on it; y removes it and keeps its folder',
    );
    expect(getAccount('old', ctx)).toBeDefined();

    expect(answer('old', 'y').box).toBeNull();
    expect(getAccount('old', ctx)).toBeUndefined();
    expect(existsSync(path.join(editorLink, path.basename(credentialPath(dirOf('old')))))).toBe(
      true,
    );
  });

  it('removes an account a session is on: says what the session does, and will not delete its folder', () => {
    const { ctx, dirOf, running, deps, answer } = home();
    running.push(lease(11, 'old', '/w/api'));
    const box = openRemoval(deps('old').standing()!);
    expect(box.label).toContain('1 session is on it (api): it keeps going until it next moves');
    expect(box.label).not.toContain('purge old');

    expect(answer('old', 'purge old').box?.error).toContain('while 1 session is running on it');
    expect(existsSync(dirOf('old'))).toBe(true);

    expect(answer('old', 'y').box).toBeNull();
    expect(getAccount('old', ctx)).toBeUndefined();
    expect(existsSync(credentialPath(dirOf('old')))).toBe(true);
  });

  it('asks again, removing nothing, when a session started on it after the question was drawn', () => {
    const { ctx, running, deps, answer } = home();
    const asked = openRemoval(deps('old').standing()!);
    running.push(lease(11, 'old', '/w/api'));
    const done = answer('old', 'y', asked);
    expect(getAccount('old', ctx)).toBeDefined();
    expect(done.box).toMatchObject({
      status: 'editing',
      text: '',
      error: 'this changed while you were answering; read it again',
    });
    expect(done.box?.label).toContain('1 session is on it (api)');
    // The answer to the question as it now stands is taken.
    expect(answer('old', 'y', done.box!).box).toBeNull();
    expect(getAccount('old', ctx)).toBeUndefined();
  });

  it('still leaves it on n when the question has changed', () => {
    const { ctx, running, deps, answer } = home();
    const asked = openRemoval(deps('old').standing()!);
    running.push(lease(11, 'old', '/w/api'));
    expect(answer('old', 'n', asked)).toEqual({ box: null });
    expect(getAccount('old', ctx)).toBeDefined();
  });

  it('says so and closes when the account went while the box was open', () => {
    const { deps, answer } = home();
    const asked = openRemoval(deps('old').standing()!);
    deps('old').remove(false);
    expect(answer('old', 'y', asked)).toEqual({
      box: null,
      notice: '"old" is no longer an account',
    });
  });

  it('keeps the box open with the reason when the command refuses', () => {
    const { deps } = home();
    let state = openRemoval(deps('old').standing()!);
    for (const ch of 'y\r') state = promptKey(state, ch, ch.charCodeAt(0));
    const done = submitRemoval(state, 'old', {
      standing: deps('old').standing,
      remove: () => ({ ok: false, text: 'could not fully purge "old"' }),
    });
    expect(done.box).toMatchObject({
      status: 'editing',
      text: 'y',
      error: 'could not fully purge "old"',
    });
    expect(done.notice).toBeUndefined();
  });
});
