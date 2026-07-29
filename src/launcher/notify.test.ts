import { describe, it, expect } from 'vitest';
import { notifyTerminal, setTerminalTitle, notifyAccountSwitch } from './notify.js';

function capture(): { stream: { write(c: string): boolean }; written: string[] } {
  const written: string[] = [];
  return {
    written,
    stream: {
      write(c: string) {
        written.push(c);
        return true;
      },
    },
  };
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('notifyTerminal', () => {
  it('asks the terminal to notify, drawing nothing itself', () => {
    const { stream, written } = capture();
    notifyTerminal('switched to work', { stream });
    expect(written).toEqual([`${ESC}]9;switched to work${BEL}`]);
  });

  it('neutralises control characters that would break out of the sequence', () => {
    const { stream, written } = capture();
    notifyTerminal(`bad${BEL}${ESC}]0;hijack`, { stream });
    const out = written.join('');
    // Exactly one terminator, at the end: nothing can escape into the screen.
    expect(out.split(BEL)).toHaveLength(2);
    expect(out.endsWith(BEL)).toBe(true);
    expect(out.slice(0, -1)).not.toContain(ESC + ']0;');
  });

  it('stays silent when disabled, and never throws on a failing stream', () => {
    const { stream, written } = capture();
    notifyTerminal('quiet', { stream, enabled: false });
    expect(written).toEqual([]);

    const broken = {
      write() {
        throw new Error('closed');
      },
    };
    expect(() => notifyTerminal('boom', { stream: broken })).not.toThrow();
  });
});

describe('setTerminalTitle', () => {
  it('sets the window title', () => {
    const { stream, written } = capture();
    setTerminalTitle('claude - work', { stream });
    expect(written).toEqual([`${ESC}]0;claude - work${BEL}`]);
  });
});

describe('notifyAccountSwitch', () => {
  it('names the account in both the notification and the title', () => {
    const { stream, written } = capture();
    notifyAccountSwitch('personal', 'hit its limit', { stream });
    const out = written.join('');
    expect(out).toContain('ccx: now on personal (hit its limit)');
    expect(out).toContain('claude - personal');
  });
});
