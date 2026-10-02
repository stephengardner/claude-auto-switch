import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PathCtx } from '../config/paths.js';
import {
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

  it('hands a status line back as it is when the real settings have no ccx line', () => {
    const s = setup();
    const mine = { type: 'command', command: 'my-line' };
    settingsSession(s, {}, { statusLine: mine });

    returnSettings(s.sessionDir, s.c);
    expect(read(s.settings).statusLine).toEqual(mine);
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

  it("keeps a folder's field the user's own Claude changed meanwhile", () => {
    const s = setup();
    const start = { projects: { '/a': { lastSessionId: '1' } } };
    stateSession(s, start, start, { projects: { '/a': { lastSessionId: '2', lastCost: 1 } } });
    write(s.state, { projects: { '/a': { lastSessionId: '9' } } });

    returnState(s.sessionDir, s.c);
    expect(read(s.state)).toEqual({ projects: { '/a': { lastSessionId: '9', lastCost: 1 } } });
  });

  it('saves an MCP server added in the session beside the ones the user has', () => {
    const s = setup();
    stateSession(s, { mcpServers: { theirs: { command: 't' } } }, { mcpServers: {} }, { mcpServers: { srv: { command: 'x' } } });

    returnState(s.sessionDir, s.c);
    expect(read(s.state)).toEqual({ mcpServers: { theirs: { command: 't' }, srv: { command: 'x' } } });
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
