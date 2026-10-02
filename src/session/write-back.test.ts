import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PathCtx } from '../config/paths.js';
import {
  forgetEarlierStart,
  handBackOrRescue,
  mergeInto,
  resyncSession,
  returnSettings,
  returnState,
  snapshotSettingsBase,
  snapshotStateBase,
} from './write-back.js';

/**
 * A ccx session runs Claude on a config folder of its own, and what Claude
 * writes there has to reach the user's own files, the way plain `claude` would
 * have written it. Three sides decide: what the session started with, what it
 * ended with, and what the user's own file says now.
 */

interface Sandbox {
  c: PathCtx;
  sessionDir: string;
  settings: string;
  state: string;
  ccxHome: string;
}

function setup(): Sandbox {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-wb-'));
  const ccxHome = path.join(home, '.claude-auto-switch');
  const sessionDir = path.join(ccxHome, 'sessions', '101');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  return {
    c: { env: { HOME: home, USERPROFILE: home, CLAUDE_AUTO_SWITCH_HOME: ccxHome } },
    sessionDir,
    settings: path.join(home, '.claude', 'settings.json'),
    state: path.join(home, '.claude.json'),
    ccxHome,
  };
}

const write = (file: string, value: unknown): void => writeFileSync(file, JSON.stringify(value), 'utf8');
const read = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

/** A session that started from `real`, after which Claude wrote `after`. */
function settingsSession(s: Sandbox, real: Record<string, unknown>, after: Record<string, unknown>): void {
  write(s.settings, real);
  write(path.join(s.sessionDir, 'settings.json'), real);
  snapshotSettingsBase(s.sessionDir);
  write(path.join(s.sessionDir, 'settings.json'), after);
}

/** The same for Claude's state, which a session starts as the user's plus its account. */
function stateSession(s: Sandbox, real: Record<string, unknown>, start: Record<string, unknown>, after: Record<string, unknown>): void {
  write(s.state, real);
  write(path.join(s.sessionDir, '.claude.json'), start);
  snapshotStateBase(s.sessionDir);
  write(path.join(s.sessionDir, '.claude.json'), after);
}

const CCX_LINE = { type: 'command', command: 'ccx statusline --wrap "ccstatusline"' };

describe('handing back settings', () => {
  it('saves a model picked with /model where plain claude would have', () => {
    const s = setup();
    settingsSession(s, { model: 'fable', hooks: { Stop: [] } }, { model: 'opus', hooks: { Stop: [] } });

    expect(returnSettings(s.sessionDir, s.c)).toBe(true);
    expect(read(s.settings)).toEqual({ model: 'opus', hooks: { Stop: [] } });
  });

  it("lets the user's own change to the same setting meanwhile win", () => {
    const s = setup();
    settingsSession(s, { model: 'fable' }, { model: 'opus' });
    write(s.settings, { model: 'sonnet' });

    returnSettings(s.sessionDir, s.c);
    expect(read(s.settings)).toEqual({ model: 'sonnet' });
  });

  it("merges permission lists as sets: the session's additions and removals beside the user's", () => {
    const s = setup();
    settingsSession(
      s,
      { permissions: { allow: ['A', 'B'], deny: [] } },
      { permissions: { allow: ['A', 'C'], deny: [] } },
    );
    // The user allowed something else in the meantime.
    write(s.settings, { permissions: { allow: ['A', 'B', 'U'], deny: [] } });

    returnSettings(s.sessionDir, s.c);
    expect(read(s.settings)).toEqual({ permissions: { allow: ['A', 'U', 'C'], deny: [] } });
  });

  it('hands nothing back twice', () => {
    const s = setup();
    settingsSession(s, { model: 'fable' }, { model: 'opus' });
    returnSettings(s.sessionDir, s.c);
    // Changed by hand after the hand-back: the session's old value stays out.
    write(s.settings, { model: 'haiku' });

    returnSettings(s.sessionDir, s.c);
    expect(read(s.settings)).toEqual({ model: 'haiku' });
  });

  it('never rewrites a real settings file that does not parse', () => {
    const s = setup();
    settingsSession(s, { model: 'fable' }, { model: 'opus' });
    writeFileSync(s.settings, '{ "hooks": ', 'utf8');

    expect(returnSettings(s.sessionDir, s.c)).toBe(false);
    expect(readFileSync(s.settings, 'utf8')).toBe('{ "hooks": ');
  });

  it('hands back everything from a session that started with no real settings', () => {
    const s = setup();
    snapshotSettingsBase(s.sessionDir); // nothing there to remember
    write(path.join(s.sessionDir, 'settings.json'), { model: 'opus' });

    returnSettings(s.sessionDir, s.c);
    expect(read(s.settings)).toEqual({ model: 'opus' });
  });

  it("puts a status line set in a session in wrapped by ccx's, and makes it the one ccx off gives back", () => {
    // Handed back bare, it would take ccx's line away from every later session.
    const s = setup();
    const mine = { type: 'command', command: 'my-line' };
    settingsSession(s, { statusLine: CCX_LINE }, { statusLine: mine });

    returnSettings(s.sessionDir, s.c);
    expect(read(s.settings).statusLine).toEqual({ type: 'command', command: 'ccx statusline --wrap "my-line"' });
    expect(read(path.join(s.ccxHome, 'statusline-backup.json'))).toEqual(mine);
  });

  it('writes nothing, and says so, when the status line restore point cannot be saved', () => {
    // Handed back bare, ccx's line would be lost; tried again later instead.
    const s = setup();
    mkdirSync(path.join(s.ccxHome, 'statusline-backup.json'), { recursive: true }); // unwritable as a file
    settingsSession(s, { statusLine: CCX_LINE, model: 'fable' }, { statusLine: { type: 'command', command: 'mine' }, model: 'opus' });

    expect(returnSettings(s.sessionDir, s.c)).toBe(false);
    expect(read(s.settings)).toEqual({ statusLine: CCX_LINE, model: 'fable' });
  });

  it('hands a status line back as it is when the real settings have no ccx line', () => {
    const s = setup();
    const mine = { type: 'command', command: 'my-line' };
    settingsSession(s, {}, { statusLine: mine });

    returnSettings(s.sessionDir, s.c);
    expect(read(s.settings).statusLine).toEqual(mine);
  });

  it('keeps a whole setting the user removed meanwhile removed, edits inside it and all', () => {
    const s = setup();
    settingsSession(s, { permissions: { allow: ['A'] } }, { permissions: { allow: ['A', 'B'] } });
    write(s.settings, {});

    returnSettings(s.sessionDir, s.c);
    expect(read(s.settings)).toEqual({});
  });

  it('merges into a setting the user created meanwhile instead of losing either side', () => {
    const s = setup();
    settingsSession(s, {}, { permissions: { allow: ['S'] } });
    write(s.settings, { permissions: { allow: ['U'] } });

    returnSettings(s.sessionDir, s.c);
    expect(read(s.settings)).toEqual({ permissions: { allow: ['U', 'S'] } });
  });

  it('removes a permission list the session removed, rather than leaving it empty', () => {
    const s = setup();
    settingsSession(s, { permissions: { allow: ['A'], deny: ['D'] } }, { permissions: { deny: ['D'] } });

    returnSettings(s.sessionDir, s.c);
    expect(read(s.settings)).toEqual({ permissions: { deny: ['D'] } });
  });

  it('lets two sessions both keep the hooks they added for one event', () => {
    const s = setup();
    const first = { matcher: 'Edit', hooks: [{ type: 'command', command: 'first' }] };
    const second = { matcher: 'Bash', hooks: [{ type: 'command', command: 'second' }] };
    settingsSession(s, { hooks: { PreToolUse: [] } }, { hooks: { PreToolUse: [second] } });
    write(s.settings, { hooks: { PreToolUse: [first] } });

    returnSettings(s.sessionDir, s.c);
    expect(read(s.settings)).toEqual({ hooks: { PreToolUse: [first, second] } });
  });

  it("leaves ccx's own line when a session removed its status line, and nothing to restore", () => {
    // With ccx on there is always ccx's line; the user's own, removed, is gone
    // from the restore point too, so `ccx off` cannot bring it back unasked.
    const s = setup();
    write(path.join(s.ccxHome, 'statusline-backup.json'), { type: 'command', command: 'ccstatusline' });
    settingsSession(s, { statusLine: CCX_LINE }, {});

    returnSettings(s.sessionDir, s.c);
    expect(read(s.settings).statusLine).toEqual({ type: 'command', command: 'ccx statusline' });
    expect(existsSync(path.join(s.ccxHome, 'statusline-backup.json'))).toBe(false);
  });

  it('leaves the real settings untouched when the session changed nothing', () => {
    const s = setup();
    settingsSession(s, { model: 'fable' }, { model: 'fable' });
    writeFileSync(s.settings, '{"model":"fable"}', 'utf8'); // as the user wrote it

    returnSettings(s.sessionDir, s.c);
    expect(readFileSync(s.settings, 'utf8')).toBe('{"model":"fable"}');
  });
});

describe("handing back Claude's state", () => {
  it('saves a theme and a trusted folder from the session, never the account it was signed in as', () => {
    const s = setup();
    const real = { theme: 'dark', projects: { '/a': { allowedTools: [] } }, oauthAccount: { emailAddress: 'me@x' } };
    const start = { ...real, oauthAccount: { emailAddress: 'other@x' }, userID: 'u2' };
    stateSession(s, real, start, {
      ...start,
      theme: 'light',
      projects: {
        '/a': { allowedTools: [], hasTrustDialogAccepted: true },
        '/b': { hasTrustDialogAccepted: true },
      },
    });

    expect(returnState(s.sessionDir, s.c)).toBe(true);
    expect(read(s.state)).toEqual({
      theme: 'light',
      projects: {
        '/a': { allowedTools: [], hasTrustDialogAccepted: true },
        '/b': { hasTrustDialogAccepted: true },
      },
      oauthAccount: { emailAddress: 'me@x' },
    });
  });

  it("keeps what the user's own Claude set for a folder meanwhile, beside the session's", () => {
    const s = setup();
    const start = { projects: { '/a': { allowedTools: ['A'], mcpServers: {} } } };
    stateSession(s, start, start, {
      projects: { '/a': { allowedTools: ['A', 'S'], mcpServers: { srv: { command: 'session' } } } },
    });
    write(s.state, { projects: { '/a': { allowedTools: ['A', 'U'], mcpServers: { srv: { command: 'user' } } } } });

    returnState(s.sessionDir, s.c);
    expect(read(s.state)).toEqual({
      projects: { '/a': { allowedTools: ['A', 'U', 'S'], mcpServers: { srv: { command: 'user' } } } },
    });
  });

  it('lets two sessions in one folder both keep the MCP servers they added', () => {
    // Several terminals in one repository is the normal way to use ccx.
    const s = setup();
    const start = { projects: { '/p': { mcpServers: {} } } };
    stateSession(s, start, start, { projects: { '/p': { mcpServers: { second: { command: 'b' } } } } });
    // The first session already handed its own back.
    write(s.state, { projects: { '/p': { mcpServers: { first: { command: 'a' } } } } });

    returnState(s.sessionDir, s.c);
    expect(read(s.state)).toEqual({
      projects: { '/p': { mcpServers: { first: { command: 'a' }, second: { command: 'b' } } } },
    });
  });

  it("leaves the user's state file alone when only Claude's bookkeeping changed", () => {
    // Costs, durations and the last conversation change on every run and are
    // nobody's choice: carrying them rewrote the user's file at every relaunch.
    const s = setup();
    const start = { projects: { '/a': { allowedTools: [], lastCost: 1 } } };
    stateSession(s, start, start, { projects: { '/a': { allowedTools: [], lastCost: 9, lastSessionId: 'x' } } });
    writeFileSync(s.state, '{"projects":{"/a":{"allowedTools":[],"lastCost":1}}}', 'utf8');

    returnState(s.sessionDir, s.c);
    expect(readFileSync(s.state, 'utf8')).toBe('{"projects":{"/a":{"allowedTools":[],"lastCost":1}}}');
  });

  it('saves only the choices of a folder first opened in the session', () => {
    const s = setup();
    stateSession(s, { projects: {} }, { projects: {} }, {
      projects: { '/new': { allowedTools: ['T'], hasTrustDialogAccepted: true, lastCost: 2 } },
    });

    returnState(s.sessionDir, s.c);
    expect(read(s.state)).toEqual({ projects: { '/new': { allowedTools: ['T'], hasTrustDialogAccepted: true } } });
  });

  it("never brings back a folder the user's own file no longer has", () => {
    // A field the session added to it would otherwise rebuild it as a stub.
    const s = setup();
    const start = { projects: { '/a': { lastSessionId: '1' } } };
    stateSession(s, start, start, { projects: { '/a': { lastSessionId: '1', lastCost: 3 } } });
    write(s.state, { projects: {} });

    returnState(s.sessionDir, s.c);
    expect(read(s.state)).toEqual({ projects: {} });
  });

  it('saves an MCP server added in the session beside the ones the user has', () => {
    const s = setup();
    stateSession(s, { mcpServers: { theirs: { command: 't' } } }, { mcpServers: {} }, { mcpServers: { srv: { command: 'x' } } });

    returnState(s.sessionDir, s.c);
    expect(read(s.state)).toEqual({ mcpServers: { theirs: { command: 't' }, srv: { command: 'x' } } });
  });
});

describe('two writers at once', () => {
  it('merges again from what is there when something wrote the file meanwhile', () => {
    // Plain `claude`, or an edit by hand, landing between the read and the write.
    const s = setup();
    write(s.settings, { a: 1 });
    let calls = 0;
    const undo = vi.fn();
    const outcome = mergeInto(s.settings, s.c, (theirs) => {
      calls += 1;
      if (calls === 1) write(s.settings, { a: 1, theirs: 'meanwhile' });
      return { changed: true, theirs: { ...theirs, ours: true }, undo };
    });

    expect(outcome).toBe('written');
    expect(calls).toBe(2);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(read(s.settings)).toEqual({ a: 1, theirs: 'meanwhile', ours: true });
  });

  it('waits for another session handing back, rather than race it', { timeout: 20_000 }, () => {
    const s = setup();
    settingsSession(s, { model: 'fable' }, { model: 'opus' });
    mkdirSync(path.join(s.ccxHome, 'write-back.lock')); // held, and fresh

    expect(returnSettings(s.sessionDir, s.c)).toBe(false);
    expect(read(s.settings)).toEqual({ model: 'fable' });
  });
});

describe('a folder an earlier session could not clear', () => {
  it("forgets that session's start, so this one is judged against its own", () => {
    const s = setup();
    for (const name of ['.ccx-base.settings.json', '.ccx-base.claude.json', '.ccx-base.CLAUDE.md']) {
      writeFileSync(path.join(s.sessionDir, name), '{}', 'utf8');
    }
    writeFileSync(path.join(s.sessionDir, 'resume-prompt.txt'), 'kept', 'utf8');

    forgetEarlierStart(s.sessionDir);
    expect(readdirSync(s.sessionDir)).toEqual(['resume-prompt.txt']);
  });
});

describe('before a session folder is removed', () => {
  it('keeps the session files aside when its changes cannot go back', () => {
    const s = setup();
    settingsSession(s, { model: 'fable' }, { model: 'opus' });
    writeFileSync(s.settings, '{ "hooks": ', 'utf8');

    expect(handBackOrRescue(s.sessionDir, s.c)).toBe(true);
    const rescued = readdirSync(path.join(s.ccxHome, 'rescued'));
    expect(rescued.some((name) => name.endsWith('-101-settings.json'))).toBe(true);
    expect(readFileSync(s.settings, 'utf8')).toBe('{ "hooks": ');
  });

  it('keeps nothing aside when the changes went back', () => {
    const s = setup();
    settingsSession(s, { model: 'fable' }, { model: 'opus' });

    expect(handBackOrRescue(s.sessionDir, s.c)).toBe(true);
    expect(existsSync(path.join(s.ccxHome, 'rescued'))).toBe(false);
  });
});

describe('between two runs of Claude', () => {
  it('hands back, then starts the next run from the real settings as they are now', () => {
    // A change made elsewhere meanwhile (another session, plain claude, by
    // hand) reaches this session too, as it would reach a fresh `claude`.
    const s = setup();
    settingsSession(s, { model: 'fable', tui: 'default' }, { model: 'opus', tui: 'default' });
    write(s.settings, { model: 'fable', tui: 'fullscreen' });

    resyncSession(s.sessionDir, s.c);
    expect(read(s.settings)).toEqual({ model: 'opus', tui: 'fullscreen' });
    expect(read(path.join(s.sessionDir, 'settings.json'))).toEqual({ model: 'opus', tui: 'fullscreen' });
    // And it starts counting changes from there.
    returnSettings(s.sessionDir, s.c);
    expect(read(s.settings)).toEqual({ model: 'opus', tui: 'fullscreen' });
  });

  it('never copies over a change that could not go back', () => {
    const s = setup();
    settingsSession(s, { model: 'fable' }, { model: 'opus' });
    writeFileSync(s.settings, '{ "hooks": ', 'utf8');

    resyncSession(s.sessionDir, s.c);
    expect(read(path.join(s.sessionDir, 'settings.json'))).toEqual({ model: 'opus' });
    expect(existsSync(s.settings)).toBe(true);
  });
});
