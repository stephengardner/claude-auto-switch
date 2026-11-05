import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { EOL, tmpdir } from 'node:os';
import path from 'node:path';
import { dashboardCommand, type DashboardTerminal } from './dashboard.js';
import { addAccount } from '../accounts/registry.js';
import { loadConfig, saveConfig } from '../config/config.js';
import type { CliContext } from '../context.js';
import type { NewerInstall } from '../update/newer-install.js';

/**
 * A dashboard left open ran the ccx it was started with for 13 days, renewing
 * logins through a save already fixed, which cut eight of them short (issue
 * #186). It now moves to a newer ccx at its next refresh, and renews nothing
 * while it cannot. These run the live screen on a stand-in terminal, with a
 * stand-in for the newer ccx that notes how it was started.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ok: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await sleep(25);
  }
  return ok();
}

interface Screen {
  terminal: DashboardTerminal;
  frames: string[];
  press: (key: string) => void;
}

function screen(): Screen {
  const stdin = new PassThrough() as unknown as DashboardTerminal['stdin'] & { isRaw?: boolean };
  Object.assign(stdin, {
    isTTY: true,
    isRaw: false,
    setRawMode(on: boolean) {
      stdin.isRaw = on;
      return stdin;
    },
  });
  const frames: string[] = [];
  const stdout = {
    columns: 140,
    rows: 50,
    write: (text: string) => {
      frames.push(text);
      return true;
    },
  };
  // The process hooks a real terminal registers, which a test has no use for.
  const hooks: { on: () => unknown; off: () => unknown } = { on: () => hooks, off: () => hooks };
  const proc = hooks as unknown as DashboardTerminal['proc'];
  return { terminal: { stdin, stdout, proc }, frames, press: (key) => void stdin.write(key) };
}

interface Sandbox {
  home: string;
  context: CliContext;
  /** How many times the screen read its accounts' logins (`claude auth status`). */
  probes: () => number;
  /** Make a newer ccx ready to take over, as an install finishing does. */
  install: () => void;
  /** How the newer ccx was started, or null when it was not. */
  started: () => string[] | null;
  ended: number[];
}

function sandbox(): Sandbox {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-dashboard-follow-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const probeLog = path.join(home, 'probes.log');
  const probe = path.join(home, 'claude.js');
  writeFileSync(
    probe,
    [
      `require('fs').appendFileSync(process.argv[2], 'probe' + require('os').EOL);`,
      `console.log(JSON.stringify({ loggedIn: false }));`,
    ].join(EOL),
  );
  const record = path.join(home, 'newer-started.json');
  const cli = path.join(home, 'newer-cli.js');
  writeFileSync(cli, `require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`);
  let newer: NewerInstall | null = null;
  const ended: number[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [probe, probeLog] },
    newerInstall: () => newer,
    endAfterHandover: (code) => void ended.push(code),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
  const dir = path.join(home, 'profiles', 'one');
  mkdirSync(dir, { recursive: true });
  addAccount({ name: 'one', dir, enabled: true }, ctx);
  return {
    home,
    context,
    probes: () =>
      existsSync(probeLog) ? readFileSync(probeLog, 'utf8').split(/\r?\n/).filter((l) => l !== '').length : 0,
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

/** Run the live dashboard; `stop` quits it however it reads its keys, should a test end with it still up. */
function open(s: Sandbox, view: Screen): { run: Promise<number>; stop: () => Promise<void> } {
  const run = dashboardCommand(s.context, { interval: '1' }, { terminal: view.terminal, reprobeMs: 200 });
  return {
    run,
    stop: async () => {
      view.press('q');
      process.stdin.emit('data', Buffer.from('q'));
      await Promise.race([run, sleep(5_000)]);
    },
  };
}

describe('a dashboard running when a newer ccx is installed', () => {
  it('is on the newer ccx by its next refresh, started with the same command', { timeout: 40_000 }, async () => {
    const s = sandbox();
    const view = screen();
    const { run, stop } = open(s, view);
    try {
      expect(await until(() => view.frames.length > 0, 10_000)).toBe(true);

      s.install();
      const outcome = await Promise.race([run, sleep(6_000).then(() => 'still running' as const)]);

      expect(s.started()).toEqual(['dashboard', '--interval', '1']);
      expect(outcome).toBe(0);
      expect(s.ended).toEqual([0]);
      expect(said(s.home)).toContain('the dashboard moved to ccx 9.9.9, installed while it ran');
    } finally {
      await stop();
    }
  });

  it('renews nothing while a box is open on it, and moves once it is closed and the keys are still', { timeout: 40_000 }, async () => {
    const s = sandbox();
    const view = screen();
    const { run, stop } = open(s, view);
    try {
      // It reads its accounts' logins again as it runs.
      expect(await until(() => s.probes() >= 2, 10_000)).toBe(true);
      view.press('a');
      expect(await until(() => (view.frames.at(-1) ?? '').includes('name for the new account'), 5_000)).toBe(true);

      s.install();
      expect(await until(() => view.frames.some((f) => f.includes('ccx 9.9.9 is installed')), 5_000)).toBe(true);
      const probes = s.probes();
      await sleep(1_500);
      expect(s.probes()).toBe(probes);
      expect(s.started()).toBeNull();

      view.press('\x1b');
      // A key was just pressed, and one pressed as it moved would land in the newer screen.
      await sleep(2_500);
      expect(s.started()).toBeNull();
      const outcome = await Promise.race([run, sleep(10_000).then(() => 'still running' as const)]);
      expect(s.started()).toEqual(['dashboard', '--interval', '1']);
      expect(outcome).toBe(0);
      expect(s.probes()).toBe(probes);
    } finally {
      await stop();
    }
  });

  it('started from an older copy than the one installed, moves before it reads or renews anything', { timeout: 40_000 }, async () => {
    const s = sandbox();
    s.install();
    const view = screen();
    const { run, stop } = open(s, view);
    try {
      const outcome = await Promise.race([run, sleep(6_000).then(() => 'still running' as const)]);

      expect(s.started()).toEqual(['dashboard', '--interval', '1']);
      expect(outcome).toBe(0);
      expect(s.probes()).toBe(0);
      expect(view.frames).toEqual([]);
    } finally {
      await stop();
    }
  });

  it('stays, and goes on reading its logins, with update.follow off', { timeout: 40_000 }, async () => {
    const s = sandbox();
    saveConfig({ update: { follow: false } }, s.context.ctx);
    const view = screen();
    const { run, stop } = open(s, view);
    try {
      expect(await until(() => view.frames.length > 0, 10_000)).toBe(true);
      s.install();
      const probes = s.probes();
      const outcome = await Promise.race([run, sleep(3_000).then(() => 'still running' as const)]);
      expect(outcome).toBe('still running');
      expect(s.started()).toBeNull();
      expect(s.probes()).toBeGreaterThan(probes);
    } finally {
      await stop();
    }
  });
});
