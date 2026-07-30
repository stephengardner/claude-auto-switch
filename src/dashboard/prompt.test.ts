import { describe, it, expect } from 'vitest';
import { openPrompt, promptKey, rejectPrompt } from './prompt.js';

/** Type `text` one key at a time, the slow-typing case. */
const type = (text: string) => {
  let state = openPrompt('add', 'name:');
  for (const ch of text) state = promptKey(state, ch, ch.charCodeAt(0));
  return state;
};

/** Deliver `chunk` as ONE blob, which is what fast typing and pasting look like. */
const chunk = (text: string) => promptKey(openPrompt('add', 'name:'), text, text.charCodeAt(0));

const CR = '\r';
const LF = '\n';
const ESC = '\x1b';
const BACKSPACE = '\b';
const DEL = '\x7f';
const CTRL_C = '\x03';
const CTRL_U = '\x15';

describe('the dashboard name box', () => {
  it('collects what is typed', () => {
    expect(type('work').text).toBe('work');
  });

  it('confirms on Enter', () => {
    const s = promptKey(type('work'), CR, 13);
    expect(s.status).toBe('submit');
    expect(s.text).toBe('work');
  });

  it('cancels on Escape and on Ctrl-C', () => {
    expect(promptKey(type('work'), ESC, 27).status).toBe('cancel');
    expect(promptKey(type('work'), CTRL_C, 3).status).toBe('cancel');
  });

  it('does NOT cancel on an arrow key, and does not type it either', () => {
    // Arrow keys arrive as Escape followed by more bytes. Treating that as a
    // cancel makes the box impossible to use; typing it inserts junk.
    const s = promptKey(type('work'), `${ESC}[A`, 27);
    expect(s.status).toBe('editing');
    expect(s.text).toBe('work');
  });

  it('deletes with Backspace and with Delete', () => {
    expect(promptKey(type('work'), BACKSPACE, 8).text).toBe('wor');
    expect(promptKey(type('work'), DEL, 127).text).toBe('wor');
  });

  it('clears the line with Ctrl-U', () => {
    expect(promptKey(type('work'), CTRL_U, 21).text).toBe('');
  });

  it('ignores control characters instead of inserting them', () => {
    expect(promptKey(type('work'), '\x00', 0).text).toBe('work');
  });

  it('keeps a rejected value so it can be corrected, and clears the complaint on the next key', () => {
    const rejected = rejectPrompt(promptKey(type('work'), CR, 13), 'already exists');
    expect(rejected.status).toBe('editing');
    expect(rejected.text).toBe('work'); // not thrown away
    expect(rejected.error).toBe('already exists');
    const s = promptKey(rejected, '2', '2'.charCodeAt(0));
    expect(s.text).toBe('work2');
    expect(s.error).toBeUndefined();
  });

  describe('a whole chunk at once, which is what a terminal actually delivers', () => {
    it('confirms when Enter arrives in the SAME chunk as the text', () => {
      // Stripping the Enter as an unprintable byte made the box impossible to
      // confirm at typing speed. Found by driving the real dashboard.
      const s = chunk(`gamma${CR}`);
      expect(s.status).toBe('submit');
      expect(s.text).toBe('gamma');
    });

    it('keeps only what came before the Enter', () => {
      const s = chunk(`one${CR}two`);
      expect(s.status).toBe('submit');
      expect(s.text).toBe('one');
    });

    it('handles a newline as well as a carriage return', () => {
      expect(chunk(`x${LF}`).status).toBe('submit');
    });

    it('applies an edit key without throwing the rest of the chunk away', () => {
      // This used to delete one character and discard both the text and the
      // Enter, because the edit key returned before the rest was read.
      const s = chunk(`${DEL}work${CR}`);
      expect(s.status).toBe('submit');
      expect(s.text).toBe('work');
    });

    it('applies a mid-chunk backspace in order', () => {
      const s = chunk(`wonk${BACKSPACE}k`);
      expect(s.text).toBe('wonk'); // w-o-n-k, backspace, k
      expect(s.status).toBe('editing');
    });

    it('clears the line mid-chunk and keeps what is typed after it', () => {
      expect(chunk(`junk${CTRL_U}good`).text).toBe('good');
    });

    it('skips an arrow key pressed in the middle of a chunk', () => {
      // Without skipping the whole sequence, the bracket and letter land in the name.
      expect(chunk(`wo${ESC}[Ark`).text).toBe('work');
    });

    it('skips a longer escape sequence too', () => {
      expect(chunk(`a${ESC}[1;2Cb`).text).toBe('ab');
      expect(chunk(`a${ESC}[3~b`).text).toBe('ab');
    });

    it('drops an unterminated escape sequence rather than typing it', () => {
      expect(chunk(`ab${ESC}[`).text).toBe('ab');
    });

    it('cancels on a Ctrl-C anywhere in the chunk', () => {
      expect(chunk(`ab${CTRL_C}cd`).status).toBe('cancel');
    });
  });

  it('ignores everything once it is finished', () => {
    const done = promptKey(type('work'), CR, 13);
    expect(promptKey(done, 'x', 120)).toBe(done);
  });
});
