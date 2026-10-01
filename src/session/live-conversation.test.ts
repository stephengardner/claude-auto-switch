import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLiveConversation } from './live-conversation.js';

const ID = '11111111-2222-4333-8444-555555555555';

/** A config folder holding the record Claude writes for `pid`. */
function withRecord(pid: number, record: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-live-conv-'));
  mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  writeFileSync(
    path.join(dir, 'sessions', `${pid}.json`),
    typeof record === 'string' ? record : JSON.stringify(record),
    'utf8',
  );
  return dir;
}

describe('which conversation a running Claude says it is in', () => {
  it('reads the conversation from the record Claude keeps for the process', () => {
    // The shape Claude 2.1.280 writes, trimmed to what matters here.
    const dir = withRecord(4242, {
      pid: 4242,
      sessionId: ID,
      cwd: 'C:\\work',
      startedAt: 5_000,
      kind: 'interactive',
    });
    expect(readLiveConversation(dir, 4242, 5_000)).toBe(ID);
  });

  it('knows nothing before the record is written, or after Claude deletes it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-live-conv-'));
    expect(readLiveConversation(dir, 4242)).toBeNull();
  });

  it('ignores a dead process record that happens to share the pid', () => {
    // A killed Claude never deletes its record, and pids are reused. Until this
    // child writes its own, the file there can belong to one long gone.
    const dir = withRecord(4242, { pid: 4242, sessionId: ID, startedAt: 1_000 });
    expect(readLiveConversation(dir, 4242, 60_000)).toBeNull();
    // A second of slack, for timer granularity, and no more.
    expect(readLiveConversation(dir, 4242, 1_900)).toBe(ID);
  });

  it('ignores a record about another process', () => {
    expect(
      readLiveConversation(withRecord(4242, { pid: 7, sessionId: ID, startedAt: 1 }), 4242),
    ).toBeNull();
  });

  it('ignores anything that is not a conversation id Claude could resume', () => {
    for (const sessionId of ['', 'not-an-id', 42, null]) {
      expect(
        readLiveConversation(withRecord(4242, { pid: 4242, sessionId, startedAt: 1 }), 4242),
      ).toBeNull();
    }
  });

  it('survives a record caught mid-write', () => {
    expect(readLiveConversation(withRecord(4242, '{"pid":4242,"sessi'), 4242)).toBeNull();
    expect(readLiveConversation(withRecord(4242, 'null'), 4242)).toBeNull();
  });

  it('does not trust a record with no time on it', () => {
    expect(readLiveConversation(withRecord(4242, { pid: 4242, sessionId: ID }), 4242)).toBeNull();
  });
});
