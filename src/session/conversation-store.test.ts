import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rememberConversation, readConversation } from './conversation-store.js';

function sessionDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cas-conv-'));
}

describe('recording which conversation a session is in', () => {
  it('round-trips the id Claude reported', () => {
    const dir = sessionDir();
    expect(readConversation(dir)).toBeNull();
    rememberConversation(dir, 'abc-123');
    expect(readConversation(dir)).toBe('abc-123');
  });

  it('takes a NEW id when the conversation changes', () => {
    const dir = sessionDir();
    rememberConversation(dir, 'first');
    rememberConversation(dir, 'second');
    expect(readConversation(dir)).toBe('second');
  });

  it('does not rewrite the file when nothing changed', () => {
    // Written on every status line render, which happens constantly. Rewriting
    // an identical file each time would be pure disk churn.
    const dir = sessionDir();
    rememberConversation(dir, 'same');
    const file = path.join(dir, 'conversation.json');
    // Valid JSON holding the same id, spaced differently from what a write
    // produces. If the spacing survives, nothing rewrote it.
    writeFileSync(file, '{ "id" : "same" }\n', 'utf8');
    rememberConversation(dir, 'same');
    expect(readFileSync(file, 'utf8')).toBe('{ "id" : "same" }\n');
  });

  it('reads nothing rather than throwing on a damaged file', () => {
    // Anything can write a file. A status line that crashed the session over a
    // stray byte would be a much worse bug than not knowing the id.
    const dir = sessionDir();
    const file = path.join(dir, 'conversation.json');
    for (const contents of ['not json', '[]', '{}', '{"id":123}', '{"id":""}']) {
      writeFileSync(file, contents, 'utf8');
      expect(readConversation(dir)).toBeNull();
    }
  });

  it('survives a session directory that does not exist yet', () => {
    const dir = path.join(sessionDir(), 'not', 'created');
    expect(readConversation(dir)).toBeNull();
    rememberConversation(dir, 'made-on-demand');
    expect(readConversation(dir)).toBe('made-on-demand');
  });

  it('keeps one answer per session directory', () => {
    // Each terminal has its own directory, which is what makes this the right
    // place to record it: two sessions cannot overwrite each other's answer.
    const one = sessionDir();
    const two = sessionDir();
    mkdirSync(one, { recursive: true });
    rememberConversation(one, 'terminal-one');
    rememberConversation(two, 'terminal-two');
    expect(readConversation(one)).toBe('terminal-one');
    expect(readConversation(two)).toBe('terminal-two');
  });
});
