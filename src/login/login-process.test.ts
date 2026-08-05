import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnAuthLogin } from './login-process.js';

/**
 * Drives the REAL adapter against a stand-in for the claude binary, because the
 * things worth checking here are about process handling and cannot be seen in a
 * fake: does cancelling return promptly, and does the process actually die.
 */

const nodeInvoker = { bin: process.execPath };
/** A child that runs long enough to be cancelled, and prints a URL first. */
const longRunning = ['-e', "console.log('https://claude.ai/oauth?x=1'); setTimeout(() => {}, 60000);"];

describe('spawnAuthLogin', () => {
  it('reports the auth URL it printed', async () => {
    const proc = spawnAuthLogin(nodeInvoker, longRunning, {});
    expect(await proc.urlHint()).toContain('https://claude.ai/oauth');
    proc.cancel?.();
  });

  it('does not cancel with a BLOCKING kill', () => {
    // The caller of cancel() is waiting to return, and on the dashboard it is
    // also the loop that relays the screen, so a synchronous kill holds all of
    // that up until the killer exits.
    //
    // Checked by reading the source rather than by timing, deliberately. The
    // first version of this test measured how long cancel() took and failed on
    // 2 runs in 4: starting a process on Windows can take most of a second even
    // when the call itself does not block, so wall clock cannot separate the two
    // cases. A test that flakes is worse than no test, because it teaches people
    // that red means nothing.
    const source = readFileSync(new URL('./login-process.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/execFileSync|spawnSync|execSync/);
    // Scoped to the KILLER specifically. A bare /unref/ also matched the URL
    // timer in the same file, so the assertion passed with killer.unref removed.
    expect(source).toMatch(/const killer\s*=\s*execFile\(\s*['"]taskkill['"]/);
    expect(source).toMatch(/killer\.unref\?\.\(\)/);
  });

  it('actually ends the process, so a give-up does not leave it running', async () => {
    const proc = spawnAuthLogin(nodeInvoker, longRunning, {});
    await proc.urlHint();
    proc.cancel?.();
    // done() resolves when the child closes; without a working cancel this waits
    // the full minute and the test times out.
    const exitCode = await proc.done();
    expect(typeof exitCode).toBe('number');
  }, 20000);

  it('resolves the URL hint even when nothing prints one', async () => {
    const quiet = ['-e', 'setTimeout(() => {}, 30000);'];
    const proc = spawnAuthLogin(nodeInvoker, quiet, {});
    expect(await proc.urlHint()).toBeUndefined();
    proc.cancel?.();
  }, 20000);

  it('survives being cancelled twice', async () => {
    const proc = spawnAuthLogin(nodeInvoker, longRunning, {});
    await proc.urlHint();
    proc.cancel?.();
    expect(() => proc.cancel?.()).not.toThrow();
  });

  it('reports a failure instead of taking the whole program down when it cannot start', async () => {
    // A child that fails to START emits 'error' and never emits 'close'. Node
    // re-throws an 'error' with no listener as an uncaught exception, so this
    // ended the entire process rather than this one sign-in: from the dashboard
    // it read as "pressing l crashed my terminal". A try/catch at the caller
    // cannot see it either, because it arrives as an event on a later tick
    // rather than as a rejected promise.
    const missing = { bin: 'ccx-no-such-binary-anywhere-on-this-machine' };
    const proc = spawnAuthLogin(missing, ['/login'], {});

    expect(await proc.done()).toBeGreaterThan(0);
    // The URL wait has to give up too. Otherwise a caller that asks for the URL
    // first waits out the full timeout on a process that never existed.
    expect(await proc.urlHint()).toBeUndefined();
  }, 20000);
});
