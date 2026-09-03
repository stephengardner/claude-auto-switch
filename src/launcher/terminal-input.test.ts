import { describe, it, expect } from 'vitest';
import { openTerminalInput } from './terminal-input.js';

/**
 * The run path claims the operator's keyboard once and hands it back when the
 * last session ends. Its teardown carries the same Windows hazard as the
 * dashboard's: dropping raw mode while stdin is still being read restarts the
 * read in line mode, and cancelling that read (screen-buffer juggling, an
 * injected carriage return) next to a child leaving the alternate screen races
 * ConPTY's teardown and can kill the parent shell. So close() must pause BEFORE
 * it drops raw mode. This pins that order.
 */

function orderRecordingStdin() {
  const order: string[] = [];
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode: (v: boolean) => {
      stdin.isRaw = v;
      order.push(v ? 'raw-on' : 'raw-off');
    },
    resume: () => void order.push('resume'),
    pause: () => void order.push('pause'),
    on: () => stdin,
    off: () => stdin,
    unref: () => void order.push('unref'),
  } as unknown as NodeJS.ReadStream & { isRaw: boolean };
  return { stdin, order: () => order };
}

describe('openTerminalInput teardown', () => {
  it('pauses before it drops raw mode, so the swap has no read to collide with', () => {
    const { stdin, order } = orderRecordingStdin();
    const input = openTerminalInput(stdin, { out: () => {} });
    input.close();
    const seq = order();
    expect(seq.indexOf('pause')).toBeLessThan(seq.indexOf('raw-off'));
    // And raw mode is actually handed back.
    expect(seq).toContain('raw-off');
  });

  it('is safe to close more than once', () => {
    const { stdin, order } = orderRecordingStdin();
    const input = openTerminalInput(stdin, { out: () => {} });
    input.close();
    input.close();
    // Exactly one hand-back, however many times close is called.
    expect(order().filter((s) => s === 'raw-off')).toHaveLength(1);
  });
});
