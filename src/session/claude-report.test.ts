import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  rememberReport,
  readReport,
  readConversation,
  readRunningModel,
} from './claude-report.js';

function sessionDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cas-report-'));
}

describe('what Claude says about a running session', () => {
  it('round-trips the conversation and the model', () => {
    const dir = sessionDir();
    expect(readReport(dir)).toEqual({});
    rememberReport(dir, { id: 'abc-123', model: 'claude-opus-5' });
    expect(readConversation(dir)).toBe('abc-123');
    expect(readRunningModel(dir)).toBe('claude-opus-5');
  });

  it('MERGES, so one render cannot erase the other fact', () => {
    // The two arrive in the same payload today, but a Claude that reported one
    // without the other would otherwise wipe the field it left out, and losing
    // the conversation id costs the operator their thread on the next swap.
    const dir = sessionDir();
    rememberReport(dir, { id: 'abc-123', model: 'claude-fable-5' });
    rememberReport(dir, { model: 'claude-opus-5' });
    expect(readConversation(dir)).toBe('abc-123');
    expect(readRunningModel(dir)).toBe('claude-opus-5');
  });

  it('follows the model when the operator changes it mid-session', () => {
    // The whole reason the model is recorded. ccx remembered what it asked for
    // at launch, so after `/model` the two disagreed and a real limit on the
    // model actually running was dismissed as somebody else's.
    const dir = sessionDir();
    rememberReport(dir, { id: 'x', model: 'claude-opus-5' });
    rememberReport(dir, { id: 'x', model: 'claude-fable-5' });
    expect(readRunningModel(dir)).toBe('claude-fable-5');
  });

  it('does not rewrite the file when nothing changed', () => {
    // Written on every status line render, which is constant.
    const dir = sessionDir();
    rememberReport(dir, { id: 'same', model: 'm' });
    const file = path.join(dir, 'claude-report.json');
    writeFileSync(file, '{ "id" : "same", "model" : "m" }\n', 'utf8');
    rememberReport(dir, { id: 'same', model: 'm' });
    expect(readFileSync(file, 'utf8')).toBe('{ "id" : "same", "model" : "m" }\n');
  });

  it('reads nothing rather than throwing on a damaged file', () => {
    const dir = sessionDir();
    const file = path.join(dir, 'claude-report.json');
    for (const contents of ['not json', '[]', '{"id":123}', '{"id":""}', 'null']) {
      writeFileSync(file, contents, 'utf8');
      expect(readConversation(dir)).toBeNull();
      expect(readRunningModel(dir)).toBeNull();
    }
  });

  it('keeps one answer per session directory', () => {
    const one = sessionDir();
    const two = sessionDir();
    rememberReport(one, { id: 'terminal-one' });
    rememberReport(two, { id: 'terminal-two' });
    expect(readConversation(one)).toBe('terminal-one');
    expect(readConversation(two)).toBe('terminal-two');
  });
});
