import { describe, it, expect } from 'vitest';
import { runCapture } from './exec.js';

describe('runCapture', () => {
  it('captures full stdout without truncation and preserves the exit code', async () => {
    // Use process.exitCode (not process.exit) so stdout fully drains before the
    // child exits; process.exit can truncate un-flushed output on macOS/Linux.
    const script = "process.stdout.write('x'.repeat(100000)); process.exitCode = 3;";
    const result = await runCapture(process.execPath, ['-e', script]);
    expect(result.stdout.length).toBe(100000);
    expect(result.exitCode).toBe(3);
  });

  it('captures stderr and does not throw on non-zero exit', async () => {
    const script = "process.stderr.write('boom'); process.exitCode = 1;";
    const result = await runCapture(process.execPath, ['-e', script]);
    expect(result.stderr).toContain('boom');
    expect(result.exitCode).toBe(1);
  });

  it('merges extra env into the child', async () => {
    const script = "process.stdout.write(process.env.CAS_TEST_VAR ?? 'missing');";
    const result = await runCapture(process.execPath, ['-e', script], {
      env: { CAS_TEST_VAR: 'hello' },
    });
    expect(result.stdout).toBe('hello');
  });
});
