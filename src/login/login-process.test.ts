import { describe, it, expect } from 'vitest';
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

  it('CANCELLING RETURNS IMMEDIATELY, rather than waiting on the kill', async () => {
    // The caller of cancel() is waiting to return, and on the dashboard it is
    // also the loop that relays the screen. A synchronous kill held all of that
    // up until the killer exited.
    const proc = spawnAuthLogin(nodeInvoker, longRunning, {});
    await proc.urlHint();

    const startedAt = Date.now();
    proc.cancel?.();
    const took = Date.now() - startedAt;

    expect(took).toBeLessThan(150);
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
});
