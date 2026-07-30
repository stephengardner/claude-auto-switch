/**
 * Turning a pseudo-terminal's exit report into a real exit code.
 *
 * node-pty's types promise a number, and on Windows it sometimes delivers
 * nothing at all: both the code and the signal come back undefined. That value
 * used to travel straight through to `process.exitCode`, so a session could end
 * with the shell being told `undefined`, which reads as success. TypeScript
 * cannot catch it, because the declared type says it cannot happen.
 *
 * The rules follow the shell convention, and keep whatever information we were
 * actually given:
 *   a reported code wins, whatever it is;
 *   otherwise a signal means an abnormal end, reported as 128 + signal;
 *   otherwise the child ended with nothing to report, which is success.
 *
 * Defaulting the last case to a failure was rejected deliberately: on Windows the
 * missing code is a reporting gap rather than evidence of one, so it would make
 * ordinary sessions look broken.
 */

export interface PtyExitReport {
  exitCode?: number | null;
  signal?: number | null;
}

export function normalizeExitCode(report: PtyExitReport | null | undefined): number {
  const code = report?.exitCode;
  if (typeof code === 'number' && Number.isFinite(code)) return Math.trunc(code);
  const signal = report?.signal;
  if (typeof signal === 'number' && Number.isFinite(signal) && signal > 0) {
    return 128 + Math.trunc(signal);
  }
  return 0;
}
