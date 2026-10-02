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
    });
    expect(refusalIn(refused({ error: 'billing_error', apiErrorStatus: 400 }))?.error).toBe(
      'billing_error',
    );
  });

  it('is not a real answer, another kind of failure, or a subagent refusal', () => {
    expect(refusalIn(answered)).toBeNull();
    expect(refusalIn(refused({ error: 'overloaded', apiErrorStatus: 529 }))).toBeNull();
    expect(refusalIn(refused({ isSidechain: true }))).toBeNull();
    expect(refusalIn('nope')).toBeNull();
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
    expect(follow.poll(ID)).toEqual({ readable: true, refusals: [] });
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

  it('says it cannot read anything without a conversation to follow', () => {
    expect(createRefusalFollower(config().dir).poll(null)).toEqual({
      readable: false,
      refusals: [],
    });
  });
});
