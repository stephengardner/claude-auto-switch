import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ONE relay between the operator's keyboard and a child process.
 *
 * The stray-characters bug lived in the gap between a terminal's state and
 * what a program asked for, and the defences against it (reassembling split
 * sequences, refusing reports nobody requested, never forwarding a fragment)
 * all live in `terminal-input.ts`. Any second path that reads stdin and writes
 * it to a child has none of them, and will show the same stray characters
 * while the first path is provably clean.
 *
 * That was not hypothetical: `ccx token` hand-rolled its own loop and passed
 * raw bytes straight through, so the fix covered a session and missed the
 * token flow entirely. This test is what stops the next copy.
 */

const src = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [full] : [];
  });
}

describe('how the keyboard reaches a child', () => {
  it('is relayed in ONE place, so the protections cannot be bypassed', () => {
    // BOTH halves, deliberately. Reading stdin alone is ordinary: the
    // dashboard reads its own keypresses and the status line reads a payload
    // piped to it, and neither drives a child. Writing to a child alone is
    // ordinary too. Doing both in one file is a second relay, and a second
    // relay is a path the protections do not cover.
    const offenders = sourceFiles(src)
      .filter((file) => {
        const body = readFileSync(file, 'utf8');
        const readsKeyboard =
          /stdin\.on\(\s*['"]data['"]/.test(body) || /setRawMode\?\.\(true\)/.test(body);
        return readsKeyboard && /\bchild\.write\(/.test(body);
      })
      .map((file) => path.relative(src, file));

    expect(offenders).toEqual([]);
  });

  it('routes the token flow through that one relay', () => {
    // Named specifically because this is the path that was missed: it ran a
    // real pseudo-terminal and relayed keystrokes with none of the handling.
    const body = readFileSync(path.join(src, 'commands', 'token.ts'), 'utf8');
    expect(body).toContain('openTerminalInput');
    expect(body).toContain('input.observeChildOutput(data)');
    expect(body).not.toMatch(/child\.write\(d\.toString/);
  });
});
