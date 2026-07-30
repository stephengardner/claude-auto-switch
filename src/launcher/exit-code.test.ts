import { describe, it, expect } from 'vitest';
import { normalizeExitCode } from './exit-code.js';

describe('normalizeExitCode', () => {
  it('keeps a reported code, success or failure', () => {
    expect(normalizeExitCode({ exitCode: 0 })).toBe(0);
    expect(normalizeExitCode({ exitCode: 1 })).toBe(1);
    expect(normalizeExitCode({ exitCode: 137 })).toBe(137);
  });

  it('reports a signal the way a shell does', () => {
    expect(normalizeExitCode({ signal: 2 })).toBe(130); // Ctrl-C
    expect(normalizeExitCode({ signal: 15 })).toBe(143); // terminated
  });

  it('prefers a reported code over a signal', () => {
    expect(normalizeExitCode({ exitCode: 3, signal: 9 })).toBe(3);
  });

  it('NEVER returns undefined, whatever the pty reports', () => {
    // This is the whole point. On Windows node-pty can report an exit with
    // neither a code nor a signal, and that value used to become
    // `process.exitCode` directly, telling the shell "undefined" (read as
    // success) after a session that may well have failed. It also made a real
    // integration test fail with "expected undefined to be 0".
    for (const report of [
      {},
      null,
      undefined,
      { exitCode: null },
      { exitCode: undefined, signal: undefined },
      { exitCode: null, signal: null },
      { exitCode: NaN },
      { exitCode: NaN, signal: 0 },
    ]) {
      const code = normalizeExitCode(report as never);
      expect(typeof code).toBe('number');
      expect(Number.isFinite(code)).toBe(true);
    }
  });

  it('treats "nothing reported" as success, not as a failure', () => {
    // Deliberate: on Windows the missing code is a reporting gap, not evidence
    // of a failure, so defaulting to non-zero would make ordinary sessions look
    // broken every time it happened.
    expect(normalizeExitCode({})).toBe(0);
    expect(normalizeExitCode({ signal: 0 })).toBe(0);
  });

  it('rounds a fractional code rather than passing it through', () => {
    expect(normalizeExitCode({ exitCode: 2.9 })).toBe(2);
  });
});
