import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { daemonCommand } from './daemon.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';
import type { NewerInstall } from '../update/newer-install.js';

/**
 * `ccx daemon run` looks every minute for as long as it is left running, so a
 * fix installed meanwhile did not reach it (issue #186). It now moves to a
 * newer ccx at its next look. Its once-a-minute clock is the test's.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ok: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await sleep(25);
  }
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
  const home = mkdtempSync(path.join(tmpdir(), 'cas-daemon-follow-'));
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

const said = (home: string): string[] => {
  const file = path.join(home, 'events.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '')
        .map((l) => (JSON.parse(l) as { msg: string }).msg)
    : [];
};

describe('ccx daemon run when a newer ccx is installed', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves to it at its next look, in this terminal, with the same command', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const s = sandbox();
    let outcome: number | 'running' = 'running';
    void daemonCommand(s.context, 'run').then((code) => {
      outcome = code;
    });
    expect(await until(() => s.lines.some((line) => line.startsWith('watching usage')))).toBe(true);

    s.install();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await until(() => outcome !== 'running')).toBe(true);
    expect(s.started()).toEqual(['daemon', 'run']);
    expect(outcome).toBe(0);
    expect(s.ended).toEqual([0]);
    expect(said(s.home)).toContain('the daemon moved to ccx 9.9.9, installed while it ran');
  });

  it('started by `ccx daemon start`, starts the newer one the same way, so `ccx daemon stop` stops that one', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const s = sandbox();
    const pidFile = path.join(s.home, 'daemon.pid');
    writeFileSync(pidFile, String(process.pid), 'utf8');
    s.install();
    let outcome: number | 'running' = 'running';
    void daemonCommand(s.context, 'run').then((code) => {
      outcome = code;
    });

    expect(await until(() => s.started() !== null)).toBe(true);
    expect(s.started()).toEqual(['daemon', 'run']);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(process.pid);
    expect(await until(() => outcome !== 'running')).toBe(true);
    expect(outcome).toBe(0);
    expect(s.ended).toEqual([0]);
  });
});
