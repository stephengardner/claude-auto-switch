import { nodePty } from '../../src/util/native-pty.js';

/**
 * Whether a pseudo-terminal opens on this machine, through the loader every
 * part of ccx uses, and why not when it does not. Not a test file itself.
 *
 * The probe ends by itself and is never killed. On Windows node-pty's kill()
 * starts a helper that attaches to the terminal to list its processes; once
 * the probe has ended it cannot attach, and five seconds later node-pty kills
 * the probe's pid, whichever process Windows has given it to by then: in the
 * next test, perhaps, its Claude. A probe killed straight after it is spawned
 * has ended by the time the helper looks (9 of 9 on windows-latest, #152).
 */
export function probeTerminal(): { open: boolean; problem: string } {
  try {
    nodePty().spawn(process.execPath, ['-e', 'process.exit(0)'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
    return { open: true, problem: '' };
  } catch (err) {
    return { open: false, problem: (err as Error).message };
  }
}
