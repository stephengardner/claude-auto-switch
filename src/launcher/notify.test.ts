import { describe, it, expect, beforeEach } from 'vitest';
import {
  notifyTerminal,
  setTerminalTitle,
  notifyAccountSwitch,
  setTerminalOwnedElsewhere,
} from './notify.js';

/**
 * The rule: while another program owns the terminal, ccx writes NOTHING to it.
 *
 * An escape sequence renders nothing, which is why these were once thought safe
 * to send mid-session. They are not. They are bytes pushed into a terminal that
 * is mid-draw, and landing them inside a sequence the other program is writing
 * leaves its parser half-way through one: the display garbles, and the terminal
 * can be left in a mode that program is not expecting, so mouse reports turn up
 * as ordinary typed text.
 */

function sink() {
  const written: string[] = [];
  return { written, stream: { write: (s: string) => (written.push(s), true) } };
}

describe('writing to the terminal', () => {
  beforeEach(() => setTerminalOwnedElsewhere(false));

  it('writes when the terminal is ccx own', () => {
    const s = sink();
    notifyTerminal('hello', { stream: s.stream });
    expect(s.written).toHaveLength(1);
  });

  it('writes NOTHING while another program owns the terminal', () => {
    const s = sink();
    setTerminalOwnedElsewhere(true);
    notifyTerminal('hello', { stream: s.stream });
    setTerminalTitle('title', { stream: s.stream });
    notifyAccountSwitch('work', 'switched', { stream: s.stream });
    expect(s.written).toEqual([]);
  });

  it('writes again once the terminal is handed back', () => {
    const s = sink();
    setTerminalOwnedElsewhere(true);
    notifyTerminal('during', { stream: s.stream });
    setTerminalOwnedElsewhere(false);
    notifyTerminal('after', { stream: s.stream });
    expect(s.written).toHaveLength(1);
    expect(s.written[0]).toContain('after');
  });
});
