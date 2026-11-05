import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { autoCommand } from './auto.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';
import type { NewerInstall } from '../update/newer-install.js';

/**
 * `ccx auto` loops for as long as it is left running, renewing logins as it
 * reads usage, so a fix installed meanwhile did not reach it (issue #186). It
 * now moves to a newer ccx before its next check. Its clock is the test's, so
 * a check 45 seconds on comes at once.
 */

/** One turn of the event loop, which the faked clock leaves alone. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function within(ok: () => boolean, turns = 2_000): Promise<boolean> {
  for (let i = 0; i < turns && !ok(); i++) await turn();
  return ok();
}

function sandbox(): {
  context: CliContext;
  home: string;
  lines: string[];
  install: () => void;
  started: () => string[] | null;
  ended: number[];
} {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-auto-follow-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const record = path.join(home, 'newer-started.json');
  const cli = path.join(home, 'newer-cli.js');
  writeFileSync(cli, `require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`);
  let newer: NewerInstall | null = null;
  const lines: string[] = [];
  const ended: number[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    newerInstall: () => newer,
    endAfterHandover: (code) => void ended.push(code),
    out: (m) => void lines.push(m),
    err: () => {},
    json: false,
    quiet: false,
  };
  return {
    context,
    home,
    lines,
    install: () => {
      newer = { version: '9.9.9', cli };
    },
    started: () => (existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as string[]) : null),
    ended,
  };
}

describe('ccx auto running when a newer ccx is installed', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves to it before its next check, started with the same command', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = sandbox();
    let outcome: number | 'running' = 'running';
    void autoCommand(s.context, { interval: '45', dryRun: true }).then((code) => {
      outcome = code;
    });
    // Its first check: with no account in use there is nothing to move, and it says so.
    expect(await within(() => s.lines.includes('no current account'))).toBe(true);

    s.install();
    await vi.advanceTimersByTimeAsync(45_000);

    expect(await within(() => outcome !== 'running')).toBe(true);
    expect(s.started()).toEqual(['auto', '--interval', '45', '--dry-run']);
    expect(outcome).toBe(0);
    expect(s.ended).toEqual([0]);
    // No second check ran on this ccx.
    expect(s.lines.filter((line) => line === 'no current account')).toHaveLength(1);
    expect(s.lines).toContain('ccx 9.9.9 is installed; carrying on in it');
  });
});
