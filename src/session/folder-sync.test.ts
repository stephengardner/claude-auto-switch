import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildClaudeFolder } from './claude-folder.js';
import { syncSettings, type SettingsPassage } from './write-back.js';

/**
 * A folder that never ends keeps ccx's own entries in its settings (the
 * editor's hooks) and out of the user's file: taken out on the way to it and
 * put back on the way in.
 */

const OURS = { type: 'command', command: 'node', args: ['ccx-hook-entry.js', 'limit'] };
type Settings = Record<string, unknown>;
/** The passage a caller with entries of its own gives: here, one StopFailure hook. */
const passage: SettingsPassage = {
  outgoing: (settings: Settings) => {
    const rest = { ...settings };
    delete rest.hooks;
    return rest;
  },
  incoming: (settings: Settings) => ({ ...settings, hooks: { StopFailure: [{ hooks: [OURS] }] } }),
};

function folder(): { dir: string; user: string; ctx: { env: NodeJS.ProcessEnv } } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-folder-sync-'));
  const ctx = { env: { HOME: home, USERPROFILE: home, CLAUDE_AUTO_SWITCH_HOME: path.join(home, 'ccx') } };
  const user = path.join(home, '.claude', 'settings.json');
  mkdirSync(path.dirname(user), { recursive: true });
  writeFileSync(user, JSON.stringify({ model: 'opus' }, null, 2));
  const dir = path.join(home, 'ccx', 'editor-active');
  buildClaudeFolder(dir, ctx);
  return { dir, user, ctx };
}
const json = (file: string): Settings => JSON.parse(readFileSync(file, 'utf8')) as Settings;

describe("a long-lived folder's own settings entries", () => {
  it('are put in on the way into the folder and never reach your settings.json', () => {
    const { dir, user, ctx } = folder();
    expect(syncSettings(dir, ctx, passage)).toBe('synced');
    expect(json(path.join(dir, 'settings.json'))).toEqual({ model: 'opus', hooks: { StopFailure: [{ hooks: [OURS] }] } });
    expect(json(user)).toEqual({ model: 'opus' });

    // The folder's Claude changes a setting; what goes out is that, not the hook.
    const theirs = path.join(dir, 'settings.json');
    writeFileSync(theirs, JSON.stringify({ ...json(theirs), model: 'sonnet' }, null, 2));
    expect(syncSettings(dir, ctx, passage)).toBe('synced');
    expect(json(user)).toEqual({ model: 'sonnet' });
    expect(json(theirs)).toEqual({ model: 'sonnet', hooks: { StopFailure: [{ hooks: [OURS] }] } });
  });
});
