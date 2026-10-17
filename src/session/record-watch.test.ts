import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRecordWatch } from './record-watch.js';

const FIRST = '11111111-2222-4333-8444-555555555555';
const SECOND = '99999999-2222-4333-8444-555555555555';
const PID = 4242;

const line = (entry: unknown): string => `${JSON.stringify(entry)}\n`;
/** A spent five-hour limit, as Claude 2.1.302 records one. */
const refusal = (at: number): Record<string, unknown> => ({
  type: 'assistant',
  isSidechain: false,
  isApiErrorMessage: true,
  error: 'rate_limit',
  apiError: 'usage_limit_reached',
  apiErrorStatus: 429,
  apiErrorParams: { rate_limit_info: { rateLimitType: 'five_hour', resetsAt: Math.floor(at / 1000) + 3600 } },
  timestamp: new Date(at).toISOString(),
  message: { content: [{ type: 'text', text: 'Out of room for now.' }] },
});
/** A prompt somebody typed, as Claude marks one. */
const prompt = (at: number): Record<string, unknown> => ({
  type: 'user',
  isSidechain: false,
  origin: { kind: 'human' },
  timestamp: new Date(at).toISOString(),
  message: { content: 'hello' },
});

function folder(): { dir: string; record: (id: string) => string; inConversation: (id: string, startedAt: number) => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-record-watch-'));
  const record = (id: string): string => {
    const file = path.join(dir, 'projects', 'C--work', `${id}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    return file;
  };
  // Claude's own per-process record, which it rewrites when the process moves to another conversation.
  const inConversation = (id: string, startedAt: number): void => {
    mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    writeFileSync(path.join(dir, 'sessions', `${PID}.json`), JSON.stringify({ pid: PID, sessionId: id, startedAt }));
  };
  return { dir, record, inConversation };
}

describe('following a running Claude by its own records', () => {
  it('follows the conversation Claude says the process is in, and its move to another', () => {
    const { dir, record, inConversation } = folder();
    const launchedAt = Date.now();
    const watch = createRecordWatch({ configDir: dir, startsNew: true, launchedAt });
    inConversation(FIRST, launchedAt);
    writeFileSync(record(FIRST), line(refusal(launchedAt + 10)));
    expect(watch.noteConversation(PID)).toBe(FIRST);
    expect(watch.conversation()).toBe(FIRST);
    // A new conversation's record is all this launch's: read whole.
    expect(watch.poll().refusals).toHaveLength(1);
    expect(watch.noteConversation(PID)).toBeNull();

    // A /clear: the process is in a new conversation, whose record comes with its first turn.
    inConversation(SECOND, launchedAt);
    expect(watch.noteConversation(PID)).toBe(SECOND);
    expect(watch.poll().refusals).toEqual([]);
    appendFileSync(record(FIRST), line(refusal(launchedAt + 20)));
    writeFileSync(record(SECOND), line(refusal(launchedAt + 30)));
    expect(watch.poll().refusals.map((r) => r.at)).toEqual([launchedAt + 30]);
  });

  it("takes no word from a per-process record older than this Claude's launch", () => {
    const { dir, inConversation } = folder();
    const launchedAt = Date.now();
    const watch = createRecordWatch({ configDir: dir, startsNew: true, launchedAt });
    inConversation(FIRST, launchedAt - 60_000);
    expect(watch.noteConversation(PID)).toBeNull();
    expect(watch.conversation()).toBeNull();
  });

  it('reads a resumed conversation from where its record ended at launch', () => {
    const { dir, record, inConversation } = folder();
    const launchedAt = Date.now();
    writeFileSync(record(FIRST), line(refusal(launchedAt - 60_000)));
    const watch = createRecordWatch({ configDir: dir, startsNew: false, launchedAt, resumes: FIRST });
    expect(watch.conversation()).toBe(FIRST);
    // Refused before the per-process record was first read: still news.
    appendFileSync(record(FIRST), line(refusal(launchedAt + 10)));
    inConversation(FIRST, launchedAt);
    expect(watch.noteConversation(PID)).toBeNull();
    expect(watch.poll().refusals.map((r) => r.at)).toEqual([launchedAt + 10]);

    // Without knowing it at launch, the first look takes the end as it is then.
    const late = createRecordWatch({ configDir: dir, startsNew: false, launchedAt });
    appendFileSync(record(FIRST), line(refusal(launchedAt + 20)));
    expect(late.noteConversation(PID)).toBe(FIRST);
    expect(late.poll().refusals).toEqual([]);
  });

  it('hands a refusal to the check with when a prompt was last typed, which only moves forward', () => {
    const { dir, record, inConversation } = folder();
    const launchedAt = Date.now();
    const watch = createRecordWatch({ configDir: dir, startsNew: true, launchedAt });
    inConversation(FIRST, launchedAt);
    writeFileSync(record(FIRST), line(prompt(launchedAt + 10)) + line(refusal(launchedAt + 20)));
    watch.noteConversation(PID);
    const [seen] = watch.poll().refusals;
    expect(watch.promptAt()).toBe(launchedAt + 10);
    expect(watch.recorded(seen!, PID)).toEqual({
      refusal: seen,
      launchedAt,
      promptAt: launchedAt + 10,
      conversation: FIRST,
      claudePid: PID,
    });
    // A refusal and a prompt typed after it, read together: the prompt is kept first.
    appendFileSync(record(FIRST), line(refusal(launchedAt + 30)) + line(prompt(launchedAt + 40)));
    const [later] = watch.poll().refusals;
    expect(watch.recorded(later!, PID).promptAt).toBe(launchedAt + 40);
    appendFileSync(record(FIRST), line(prompt(launchedAt + 5)));
    watch.poll();
    expect(watch.promptAt()).toBe(launchedAt + 40);
  });
});
