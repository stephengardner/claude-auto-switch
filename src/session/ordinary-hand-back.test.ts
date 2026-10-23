import { describe, it, expect, vi } from 'vitest';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PathCtx } from '../config/paths.js';
import { openHops } from '../artifacts/hop-files.js';
import { buildClaudeFolder } from './claude-folder.js';
import { returnSharedUserFiles } from './shared-root.js';

/**
 * Sessions end many times a day, and nearly every one has all its folders
 * linked into ~/.claude. Its hand-back must then cost nothing: no folder
 * looked into through a link, nothing linked, copied or written.
 */

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readdirSync: vi.fn(fs.readdirSync),
    linkSync: vi.fn(fs.linkSync),
    copyFileSync: vi.fn(fs.copyFileSync),
    appendFileSync: vi.fn(fs.appendFileSync),
    writeFileSync: vi.fn(fs.writeFileSync),
    renameSync: vi.fn(fs.renameSync),
    mkdirSync: vi.fn(fs.mkdirSync),
    rmSync: vi.fn(fs.rmSync),
    unlinkSync: vi.fn(fs.unlinkSync),
  };
});

/** The first argument of each call to a spied fs function: the path it acted on. */
const pathsOf = (fn: unknown): string[] =>
  (fn as { mock: { calls: unknown[][] } }).mock.calls.map((call) => path.resolve(String(call[0])));

const put = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};

/** Every entry under `dir`, with what would change if it were written to. */
function tree(dir: string, at = ''): string[] {
  return readdirSync(path.join(dir, at))
    .sort()
    .flatMap((name) => {
      const rel = path.join(at, name);
      const st = lstatSync(path.join(dir, rel), { bigint: true });
      if (st.isDirectory()) return [`${rel}/`, ...tree(dir, rel)];
      return [`${rel} ${st.size} ${st.ino} ${st.mtimeNs}`];
    });
}

describe('the hand-back of an ordinary session', () => {
  it('hands back nothing, walks no linked folder, and keeps nothing in rescued/', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-ordinary-'));
    const ccx = path.join(home, '.claude-auto-switch');
    const c: PathCtx = { env: { CLAUDE_AUTO_SWITCH_HOME: ccx, HOME: home, USERPROFILE: home } };
    const claude = path.join(home, '.claude');
    put(path.join(claude, 'projects', '-work', 'old.jsonl'), '{"said":"before"}\n');
    put(path.join(claude, 'todos', 'agent.json'), '[]');
    put(path.join(claude, 'CLAUDE.md'), '# memory\n');
    put(path.join(claude, 'history.jsonl'), '{"display":"a"}\n');
    put(path.join(claude, 'settings.json'), '{"model":"opus"}');

    const sessionDir = path.join(ccx, 'sessions', '4242');
    buildClaudeFolder(sessionDir, c);
    openHops(sessionDir, 4242);
    // What its Claude does: a chat and a prompt, through the links, and a backup and a lock of its own.
    put(path.join(sessionDir, 'projects', '-work', 'new.jsonl'), '{"said":"in the session"}\n');
    appendFileSync(path.join(sessionDir, 'history.jsonl'), '{"display":"b"}\n');
    put(path.join(sessionDir, 'backups', '.claude.json.backup.1'), '{}');
    mkdirSync(path.join(sessionDir, '.claude.json.lock'));
    expect(lstatSync(path.join(sessionDir, 'projects')).isSymbolicLink()).toBe(true);
    const before = tree(claude);
    vi.clearAllMocks();

    expect(returnSharedUserFiles(sessionDir, c)).toBe(true);
    const listed = pathsOf(readdirSync);
    const written = [linkSync, copyFileSync, appendFileSync, writeFileSync, renameSync, mkdirSync, rmSync, unlinkSync]
      .flatMap(pathsOf);

    expect(written).toEqual([]);
    // The session folder, or ~/.claude itself, and nothing in either.
    expect(listed.filter((p) => p !== path.resolve(sessionDir) && p !== path.resolve(claude))).toEqual([]);
    expect(tree(claude)).toEqual(before);
    expect(existsSync(path.join(ccx, 'rescued'))).toBe(false);
  });
});
