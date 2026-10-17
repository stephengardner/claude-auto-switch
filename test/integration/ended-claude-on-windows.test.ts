import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPtySession } from '../../src/launcher/pty-session.js';
import { nodePty } from '../../src/util/native-pty.js';
import { fakeClaude, ID } from './typeable-claude.js';

/**
 * Ending a Claude that has already ended, on Windows. node-pty reports an
 * exit a second or more after it happens, so ccx can set out to end a Claude
 * that is gone. Handed to node-pty's own kill() then, node-pty starts a helper
 * that cannot attach to the ended terminal, and five seconds later kills the
 * old pid, whichever process has it by then (issue #152).
 */

describe.runIf(process.platform === 'win32')('a Claude that has already ended, on Windows', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FAKE_CLAUDE_NOTHING_TO_RESUME;
  });

  it("is never handed to node-pty's own kill", { timeout: 30_000 }, async () => {
    // Claude says there is nothing to resume and exits at once; ccx ends it
    // 100 ms after reading that, well before node-pty reports the exit.
    process.env.FAKE_CLAUDE_NOTHING_TO_RESUME = '1';
    const pty = nodePty();
    const open = pty.spawn.bind(pty);
    const killed: number[] = [];
    vi.spyOn(pty, 'spawn').mockImplementation((file, args, options) => {
      const terminal = open(file, args, options);
      const kill = terminal.kill.bind(terminal);
      terminal.kill = (signal?: string): void => {
        killed.push(terminal.pid);
        kill(signal);
      };
      return terminal;
    });

    const outcome = await runPtySession({
      claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
      args: ['--resume', ID],
      configDir: mkdtempSync(path.join(tmpdir(), 'cas-ended-claude-')),
      input: { attach: () => () => {}, observeChildOutput: () => {}, close: () => {} },
    });

    expect(outcome.kind).toBe('no-conversation');
    expect(killed).toEqual([]);
  });
});
