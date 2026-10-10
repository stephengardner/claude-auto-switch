import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRefusalFollower, findTranscript, refusalIn } from './transcript.js';

const ID = '11111111-2222-4333-8444-555555555555';

/** A refused turn as Claude 2.1.284 writes it (measured), with neutral wording. */
const refused = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'assistant',
  isSidechain: false,
  isApiErrorMessage: true,
  error: 'rate_limit',
  apiError: 'model_requires_usage_credits',
  apiErrorStatus: 429,
  message: { model: '<synthetic>', content: [{ type: 'text', text: 'Out of room for now.' }] },
  ...extra,
});
const answered = { type: 'assistant', message: { model: 'claude-opus-5-5', content: [] } };
const line = (entry: unknown): string => `${JSON.stringify(entry)}\n`;

function config(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-transcript-'));
  const file = path.join(dir, 'projects', 'C--work', `${ID}.jsonl`);
  return { dir, file };
}

describe('what counts as a refused turn', () => {
  it('reads Claude own codes for it, and the wording it showed', () => {
    expect(refusalIn(refused())).toEqual({
      error: 'rate_limit',
      apiError: 'model_requires_usage_credits',
      status: 429,
      text: 'Out of room for now.',
      sidechain: false,
    });
    expect(refusalIn(refused({ error: 'billing_error', apiErrorStatus: 400 }))?.error).toBe(
      'billing_error',
    );
  });

  it('is not a real answer or another kind of failure', () => {
    expect(refusalIn(answered)).toBeNull();
    expect(refusalIn(refused({ error: 'overloaded', apiErrorStatus: 529 }))).toBeNull();
    expect(refusalIn('nope')).toBeNull();
  });

  it('says when a subagent was the one refused', () => {
    expect(refusalIn(refused({ isSidechain: true }))?.sidechain).toBe(true);
    expect(refusalIn(refused())?.sidechain).toBe(false);
  });
});

describe('following a conversation record', () => {
  it('finds it under the config folder, in whichever project folder it is', () => {
    const { dir, file } = config();
    expect(findTranscript(dir, ID)).toBeNull();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, line(answered));
    expect(findTranscript(dir, ID)).toBe(file);
  });

  it('starts at the end of a record that exists: its old refusals are not news', () => {
    const { dir, file } = config();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, line(refused()) + line(answered));
    const follow = createRefusalFollower(dir);
    expect(follow.poll(ID)).toEqual({
      readable: true,
      refusals: [],
      promptAt: null,
      subagentsWrote: false,
    });
    expect(follow.poll(ID).refusals).toHaveLength(0);
    appendFileSync(file, line(refused()));
    expect(follow.poll(ID).refusals).toHaveLength(1);
    // Each once.
    expect(follow.poll(ID).refusals).toHaveLength(0);
  });

  it('reads a record that appears later from its start', () => {
    const { dir, file } = config();
    const follow = createRefusalFollower(dir);
    expect(follow.poll(ID).readable).toBe(false);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, line(answered) + line(refused()));
    expect(follow.poll(ID)).toMatchObject({ readable: true, refusals: [{ error: 'rate_limit' }] });
  });

  it('only reads a line once it is whole, even when a character is cut in two', () => {
    const { dir, file } = config();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    const follow = createRefusalFollower(dir);
    follow.poll(ID);
    const whole = Buffer.from(
      line(
        refused({
          message: { model: '<synthetic>', content: [{ type: 'text', text: 'plein … ✓' }] },
        }),
      ),
    );
    const cut = whole.indexOf(Buffer.from('…')) + 1; // inside the three bytes of one character
    appendFileSync(file, whole.subarray(0, cut));
    expect(follow.poll(ID).refusals).toHaveLength(0);
    appendFileSync(file, whole.subarray(cut));
    expect(follow.poll(ID).refusals[0]?.text).toBe('plein … ✓');
  });

  it('follows the conversation the session moves to, from that one end', () => {
    const { dir, file } = config();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, line(answered));
    const other = path.join(path.dirname(file), '99999999-8888-4777-8666-555555555555.jsonl');
    writeFileSync(other, line(refused()));
    const follow = createRefusalFollower(dir);
    follow.poll(ID);
    expect(follow.poll('99999999-8888-4777-8666-555555555555').refusals).toHaveLength(0);
    appendFileSync(other, line(refused()));
    expect(follow.poll('99999999-8888-4777-8666-555555555555').refusals).toHaveLength(1);
  });

  it('reads a new conversation whole, even when its record was written before the first look', () => {
    const { dir, file } = config();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, line(answered) + line(refused()));
    const follow = createRefusalFollower(dir, true);
    expect(follow.poll(ID)).toMatchObject({ readable: true, refusals: [{ error: 'rate_limit' }] });
    // Only the first conversation: one moved to later brings its history along.
    const other = path.join(path.dirname(file), '99999999-8888-4777-8666-555555555555.jsonl');
    writeFileSync(other, line(refused()));
    expect(follow.poll('99999999-8888-4777-8666-555555555555').refusals).toHaveLength(0);
  });

  it('says it cannot read anything without a conversation to follow', () => {
    expect(createRefusalFollower(config().dir).poll(null)).toEqual({
      readable: false,
      refusals: [],
      promptAt: null,
      subagentsWrote: false,
    });
  });
});

/**
 * Claude 2.1.296 keeps each subagent's record in a file of its own, beside the
 * conversation's: <id>/subagents/agent-<agent>.jsonl, and one folder deeper
 * for the agents a workflow starts (measured on a live session's folder).
 */
describe('following the subagents of a conversation', () => {
  const subagent = (file: string, agent: string, ...under: string[]): string =>
    path.join(path.dirname(file), ID, 'subagents', ...under, `agent-${agent}.jsonl`);
  const subRefused = (): Record<string, unknown> => refused({ isSidechain: true, agentId: 'a1' });

  it('reports a refusal a subagent met, marked as a subagent one', () => {
    const { dir, file } = config();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, line(answered));
    const follow = createRefusalFollower(dir);
    follow.poll(ID);

    const record = subagent(file, 'a1');
    mkdirSync(path.dirname(record), { recursive: true });
    writeFileSync(record, line(answered) + line(subRefused()));
    expect(follow.poll(ID).refusals).toEqual([
      expect.objectContaining({ error: 'rate_limit', sidechain: true }),
    ]);
    // Each once.
    expect(follow.poll(ID).refusals).toHaveLength(0);
    appendFileSync(record, line(subRefused()));
    expect(follow.poll(ID).refusals).toHaveLength(1);
  });

  it('reads the agents a workflow starts, one folder deeper', () => {
    const { dir, file } = config();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, line(answered));
    const follow = createRefusalFollower(dir);
    follow.poll(ID);

    const record = subagent(file, 'w1', 'workflows', 'wf_1');
    mkdirSync(path.dirname(record), { recursive: true });
    writeFileSync(record, line(subRefused()));
    expect(follow.poll(ID).refusals).toHaveLength(1);
  });

  it("reads only the agents' own records, not the other files a workflow keeps there", () => {
    // A workflow writes its journal of results beside its agents' records.
    // That is not a subagent at work, and nothing in it is a refused turn.
    const { dir, file } = config();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, line(answered));
    const follow = createRefusalFollower(dir);
    follow.poll(ID);

    const journal = path.join(
      path.dirname(subagent(file, 'w1', 'workflows', 'wf_1')),
      'journal.jsonl',
    );
    mkdirSync(path.dirname(journal), { recursive: true });
    writeFileSync(journal, line(subRefused()));
    expect(follow.poll(ID)).toMatchObject({ refusals: [], subagentsWrote: false });
  });

  it('leaves alone what the subagents of a resumed conversation met before', () => {
    const { dir, file } = config();
    const record = subagent(file, 'old');
    mkdirSync(path.dirname(record), { recursive: true });
    writeFileSync(file, line(answered));
    writeFileSync(record, line(subRefused()));
    const follow = createRefusalFollower(dir);
    expect(follow.poll(ID).refusals).toHaveLength(0);
    expect(follow.poll(ID).refusals).toHaveLength(0);
    // What that subagent meets from now on is news.
    appendFileSync(record, line(subRefused()));
    expect(follow.poll(ID).refusals).toHaveLength(1);
  });

  it('reads the subagents of a new conversation whole', () => {
    const { dir, file } = config();
    const record = subagent(file, 'a1');
    mkdirSync(path.dirname(record), { recursive: true });
    writeFileSync(file, line(answered));
    writeFileSync(record, line(subRefused()));
    expect(createRefusalFollower(dir, true).poll(ID).refusals).toEqual([
      expect.objectContaining({ sidechain: true }),
    ]);
  });

  it('counts whatever a subagent file holds as a subagent refusal', () => {
    // Whatever the entry says of itself: the file is the subagent's.
    const { dir, file } = config();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, line(answered));
    const follow = createRefusalFollower(dir);
    follow.poll(ID);
    const record = subagent(file, 'a1');
    mkdirSync(path.dirname(record), { recursive: true });
    writeFileSync(record, line(refused({ isSidechain: false })));
    expect(follow.poll(ID).refusals[0]?.sidechain).toBe(true);
  });

  it('says when a subagent wrote anything at all: one that is writing is running', () => {
    const { dir, file } = config();
    const record = subagent(file, 'old');
    mkdirSync(path.dirname(record), { recursive: true });
    writeFileSync(file, line(answered));
    writeFileSync(record, line(answered));
    const follow = createRefusalFollower(dir);
    // What it wrote before this look is its past, not a sign of life.
    expect(follow.poll(ID).subagentsWrote).toBe(false);
    expect(follow.poll(ID).subagentsWrote).toBe(false);
    appendFileSync(record, line(answered));
    expect(follow.poll(ID).subagentsWrote).toBe(true);
    expect(follow.poll(ID).subagentsWrote).toBe(false);
    // One that starts now counts too, and the main thread writing does not.
    writeFileSync(subagent(file, 'new'), line(answered));
    expect(follow.poll(ID).subagentsWrote).toBe(true);
    appendFileSync(file, line(answered));
    expect(follow.poll(ID).subagentsWrote).toBe(false);
  });

  it('does not follow the subagents of another conversation', () => {
    const { dir, file } = config();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, line(answered));
    const follow = createRefusalFollower(dir);
    follow.poll(ID);
    const other = path.join(
      path.dirname(file),
      '99999999-8888-4777-8666-555555555555',
      'subagents',
      'agent-x.jsonl',
    );
    mkdirSync(path.dirname(other), { recursive: true });
    writeFileSync(other, line(subRefused()));
    expect(follow.poll(ID).refusals).toHaveLength(0);
  });
});

describe('prompts a person submitted', () => {
  /** A prompt as Claude 2.1.296 records one typed at its terminal (measured). */
  const typed = (at: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'user',
    isSidechain: false,
    origin: { kind: 'human' },
    timestamp: at,
    message: { role: 'user', content: 'carry on' },
    ...extra,
  });

  it('says when the newest one was recorded', () => {
    const { dir, file } = config();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, line(answered));
    const follow = createRefusalFollower(dir);
    expect(follow.poll(ID).promptAt).toBeNull();
    appendFileSync(
      file,
      line(typed('2026-10-10T02:05:31.987Z')) +
        line(answered) +
        line(typed('2026-10-10T02:06:00.000Z')),
    );
    expect(follow.poll(ID).promptAt).toBe(Date.parse('2026-10-10T02:06:00.000Z'));
    expect(follow.poll(ID).promptAt).toBeNull();
  });

  it('is not a notice from a background task, a tool result or a subagent prompt', () => {
    const { dir, file } = config();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, line(answered));
    const follow = createRefusalFollower(dir);
    follow.poll(ID);
    appendFileSync(
      file,
      line(typed('2026-10-10T02:05:31.987Z', { origin: { kind: 'task-notification' } })) +
        // The same words elsewhere in the entry do not make it one.
        line(
          typed('2026-10-10T02:05:31.990Z', {
            origin: { kind: 'task-notification' },
            sentBy: { kind: 'human' },
          }),
        ) +
        line(typed('2026-10-10T02:05:32.000Z', { origin: undefined })) +
        line(typed('2026-10-10T02:05:33.000Z', { isSidechain: true })) +
        // A tool result that quotes the words is still a tool result.
        line({
          type: 'user',
          timestamp: '2026-10-10T02:05:34.000Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: '"origin":{"kind":"human"}' }],
          },
        }),
    );
    expect(follow.poll(ID).promptAt).toBeNull();
  });
});
