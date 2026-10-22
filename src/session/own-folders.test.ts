import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adoptFolderHistory, returnOwnFolders, returnSharedUserFiles } from './shared-root.js';

/**
 * With no home to find ~/.claude by, nothing in a Claude folder was ever
 * linked, so what its Claude wrote is in it alone: each step that would bring
 * it into ~/.claude says it has not, so its caller keeps the folder, or its
 * note to try again.
 */

/** A folder holding a chat of its own, as a Claude on it with no ~/.claude leaves it. */
function folderWithAChat(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-own-folders-'));
  mkdirSync(path.join(dir, 'projects', '-work'), { recursive: true });
  writeFileSync(path.join(dir, 'projects', '-work', 'chat.jsonl'), 'a chat\n');
  writeFileSync(path.join(dir, 'history.jsonl'), '{"display":"typed there"}\n');
  return dir;
}

describe('with no ~/.claude to bring a folder into', () => {
  it("says the editor's folder must stay at editor off", () => {
    expect(returnOwnFolders(folderWithAChat(), 'editor', { env: {} })).toBe(false);
  });

  it("says an account folder's history is not merged yet, so the move's note to try again stays", () => {
    expect(adoptFolderHistory(folderWithAChat(), 'A', { env: {} }, () => 'unchanged', false)).toBe(false);
  });

  it("says a session's folder must stay at its clean-up", () => {
    expect(returnSharedUserFiles(folderWithAChat(), { env: {} })).toBe(false);
  });
});
