import { describe, it, expect } from 'vitest';
import { openPrompt, promptKey, rejectPrompt } from './prompt.js';

const type = (text: string) => {
  let state = openPrompt('add', 'name:');
  for (const ch of text) state = promptKey(state, ch, ch.charCodeAt(0));
  return state;
};

describe('the dashboard name box', () => {
  it('collects what is typed', () => {
    expect(type('work').text).toBe('work');
  });

  it('confirms on Enter', () => {
    const s = promptKey(type('work'), '\r', 13);
    expect(s.status).toBe('submit');
    expect(s.text).toBe('work');
  });

  it('cancels on Escape and on Ctrl-C', () => {
    expect(promptKey(type('work'), '\x1b', 27).status).toBe('cancel');
    expect(promptKey(type('work'), '\x03', 3).status).toBe('cancel');
  });

  it('does NOT cancel on an arrow key, and does not type it either', () => {
    // Arrow keys arrive as Escape followed by more bytes. Treating that as a
    // cancel makes the box impossible to use; typing it inserts junk.
    const s = promptKey(type('work'), '\x1b[A', 27);
    expect(s.status).toBe('editing');
    expect(s.text).toBe('work');
  });

  it('deletes with Backspace and with Delete', () => {
    expect(promptKey(type('work'), '\b', 8).text).toBe('wor');
    expect(promptKey(type('work'), '\x7f', 127).text).toBe('wor');
  });

  it('clears the line with Ctrl-U', () => {
    expect(promptKey(type('work'), '\x15', 21).text).toBe('');
  });

  it('ignores control characters instead of inserting them', () => {
    const s = promptKey(type('work'), '\x00', 0);
    expect(s.text).toBe('work');
  });

  it('keeps a rejected value so it can be corrected, and clears the complaint on the next key', () => {
    const rejected = rejectPrompt(promptKey(type('work'), '\r', 13), 'already exists');
    expect(rejected.status).toBe('editing');
    expect(rejected.text).toBe('work'); // not thrown away
    expect(rejected.error).toBe('already exists');
    const s = promptKey(rejected, '2', '2'.charCodeAt(0));
    expect(s.text).toBe('work2');
    expect(s.error).toBeUndefined();
  });

  it('confirms when Enter arrives in the SAME chunk as the text', () => {
    // How a terminal actually delivers fast typing and pastes. Stripping the
    // Enter as an unprintable byte made the box impossible to confirm.
    const s = promptKey(openPrompt('add', 'name:'), 'gamma\r', 'g'.charCodeAt(0));
    expect(s.status).toBe('submit');
    expect(s.text).toBe('gamma');
  });

  it('keeps only what came before the Enter', () => {
    const s = promptKey(openPrompt('add', 'name:'), 'one\rtwo', 'o'.charCodeAt(0));
    expect(s.status).toBe('submit');
    expect(s.text).toBe('one');
  });

  it('handles a newline as well as a carriage return', () => {
    expect(promptKey(openPrompt('add', 'name:'), 'x\n', 120).status).toBe('submit');
  });

  it('ignores everything once it is finished', () => {
    const done = promptKey(type('work'), '\r', 13);
    expect(promptKey(done, 'x', 120)).toBe(done);
  });
});
