import { describe, it, expect } from 'vitest';
import { createTerminalWriter, type TerminalWriterDeps } from './terminal-writer.js';

function writer(overrides: Partial<TerminalWriterDeps> = {}) {
  const said: string[] = [];
  const resets: number[] = [];
  const exitHooks: Array<() => void> = [];
  const w = createTerminalWriter({
    line: (t) => said.push(t),
    resetModes: () => {
      resets.push(Date.now());
    },
    onProcessExit: (fn) => exitHooks.push(fn),
    ...overrides,
  });
  return { w, said, resets, exitHooks, crash: () => exitHooks.forEach((fn) => fn()) };
}

describe('saying things around a child that owns the screen', () => {
  it('says a line immediately while nothing owns the screen', () => {
    const { w, said } = writer();
    w.say('between sessions');
    expect(said).toEqual(['between sessions']);
  });

  it('holds a line while the child owns the screen, and says it when it ends', () => {
    // Writing it live paints into Claude's interface; dropping it leaves the
    // operator at a blank prompt with no idea why nothing ran.
    const { w, said } = writer();
    w.childStarted();
    w.say('every account has hit its limit');
    expect(said).toEqual([]);
    expect(w.held()).toBe('every account has hit its limit');
    w.childEnded();
    expect(said).toEqual(['every account has hit its limit']);
    expect(w.held()).toBeNull();
  });

  it('keeps only the LAST held line: an ending replaces the one before it', () => {
    const { w, said } = writer();
    w.childStarted();
    w.say('first ending');
    w.say('second ending');
    w.childEnded();
    expect(said).toEqual(['second ending']);
  });
});

describe('putting the terminal modes back', () => {
  it('resets at the end of a run that ran a child', () => {
    // The per-session reset can be undone by a flush that lands after it, so
    // the run's last act is to put the modes back once more.
    const { w, resets } = writer();
    w.childStarted();
    w.childEnded();
    expect(resets).toHaveLength(0);
    w.runEnding();
    expect(resets).toHaveLength(1);
  });

  it('does not touch the terminal when no child ever ran', () => {
    // `ccx` exiting from a help screen must not write escape sequences.
    const { w, resets } = writer();
    w.runEnding();
    expect(resets).toHaveLength(0);
  });

  it('stays dirty across swaps, so one final reset covers the whole run', () => {
    const { w, resets } = writer();
    w.childStarted();
    w.childEnded();
    w.childStarted(); // the swap: a second session in the same run
    w.childEnded();
    w.runEnding();
    expect(resets).toHaveLength(1);
  });

  it('flushes what was held even when the run ends mid-session', () => {
    const { w, said } = writer();
    w.childStarted();
    w.say('the ending');
    w.runEnding();
    expect(said).toEqual(['the ending']);
  });
});

describe('the crash guard', () => {
  it('puts the modes back when the process dies with them dirty', () => {
    // A killed wrapper skips every finally; without this the operator's shell
    // keeps receiving mouse reports as typed text.
    const { w, resets, crash } = writer();
    w.childStarted();
    crash();
    expect(resets).toHaveLength(1);
  });

  it('does nothing when the run already cleaned up', () => {
    // A double reset from an exit handler writes into whatever the shell is
    // doing by then.
    const { w, resets, crash } = writer();
    w.childStarted();
    w.runEnding();
    crash();
    expect(resets).toHaveLength(1); // the runEnding one, and no more
  });

  it('fires at most once however many exit hooks run', () => {
    const { w, resets, exitHooks, crash } = writer();
    w.childStarted();
    w.childStarted(); // a second session must not install a second guard
    expect(exitHooks).toHaveLength(1);
    crash();
    crash();
    expect(resets).toHaveLength(1);
  });

  it('survives a reset that throws', () => {
    const { w, crash } = writer({
      resetModes: () => {
        throw new Error('terminal is gone');
      },
    });
    w.childStarted();
    expect(() => crash()).not.toThrow();
  });

  it('retries at exit when the run-ending reset reported failure', () => {
    // resetChildTerminalModes returns false when the write did not happen.
    // Clearing the dirty flag on that answer would make this exit hook skip
    // its retry, and the shell would keep receiving mouse reports.
    const attempts: boolean[] = [];
    let succeed = false;
    const { w, crash } = writer({
      resetModes: () => {
        attempts.push(succeed);
        return succeed;
      },
    });
    w.childStarted();
    w.runEnding(); // fails: returns false, so the modes stay dirty
    succeed = true;
    crash(); // the guard gets its one retry, and this time it lands
    expect(attempts).toEqual([false, true]);
  });
});
