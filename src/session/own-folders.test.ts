import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { returnOwnFolders } from './shared-root.js';

describe('returnOwnFolders', () => {
  it('says the folder must stay when there is no ~/.claude to bring its own folders into', () => {
    // With no home, nothing in the folder was ever linked: its chats are in it alone.
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-own-folders-'));
    mkdirSync(path.join(dir, 'projects', '-work'), { recursive: true });
    writeFileSync(path.join(dir, 'projects', '-work', 'chat.jsonl'), 'a chat\n');

    expect(returnOwnFolders(dir, 'editor', { env: {} })).toBe(false);
  });
});
