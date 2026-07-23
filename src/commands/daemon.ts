import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';
import { listAccounts } from '../accounts/registry.js';
import { getActive, setActive } from '../state/active.js';
import { configHome } from '../config/paths.js';
import {
  installDaemon,
  uninstallDaemon,
  activeLinkPath,
  type DaemonInstallDeps,
} from '../daemon/install.js';
import { setTarget, removeTarget } from '../daemon/junction.js';
import { setUserEnvVar, unsetUserEnvVar } from '../daemon/user-env.js';
import { readUsageForDir } from '../daemon/usage.js';
import { runDaemon, type DaemonDeps } from '../daemon/daemon.js';
import { startBackground, stopBackground, runningPid } from '../daemon/process.js';
import type { CliContext } from '../context.js';

/** Dispatch `ccx daemon <install|uninstall|status|start|stop|run>`. */
export async function daemonCommand(context: CliContext, action?: string): Promise<number> {
  const home = configHome(context.ctx);
  const link = activeLinkPath(home);

  const installDeps: DaemonInstallDeps = {
    configHome: home,
    accounts: () =>
      listAccounts(context.ctx).map((a) => ({ name: a.name, dir: a.dir, priority: a.priority })),
    getActive: () => getActive(context.ctx),
    setActive: (n) => setActive(n, context.ctx),
    setJunction: (l, t) => setTarget(l, t, { platform: context.ctx.platform }),
    setUserEnvVar: (n, v) => setUserEnvVar(n, v, context.ctx.platform),
    unsetUserEnvVar: (n) => unsetUserEnvVar(n, context.ctx.platform),
    removeJunction: (l) => removeTarget(l),
    log: context.out,
  };

  switch (action) {
    case 'install':
      return installDaemon(installDeps).ok ? 0 : 1;
    case 'uninstall':
      uninstallDaemon(installDeps);
      return 0;
    case 'status':
      return daemonStatus(context, home, link);
    case 'start': {
      const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
      context.out(`daemon started (pid ${startBackground(home, cliPath)})`);
      return 0;
    }
    case 'stop':
      context.out(stopBackground(home) ? 'daemon stopped' : 'no daemon running');
      return 0;
    case 'run':
      await runForeground(context, home, link);
      return 0;
    default:
      context.out('usage: ccx daemon <install|uninstall|status|start|stop|run>');
      return 1;
  }
}

function daemonStatus(context: CliContext, home: string, link: string): number {
  const pid = runningPid(home);
  context.out(`active account: ${getActive(context.ctx) ?? '(none)'}`);
  context.out(`junction:       ${link}`);
  context.out(`watcher:        ${pid ? `running (pid ${pid})` : 'stopped'}`);
  for (const a of listAccounts(context.ctx)) {
    const u = readUsageForDir(a.dir);
    const detail = u
      ? `5h ${u.fiveHourPct ?? '?'}%, 7d ${u.sevenDayPct ?? '?'}%${u.retryAfter ? ', RATE-LIMITED' : ''}`
      : 'no usage data';
    context.out(`  ${a.name}: ${detail}`);
  }
  return 0;
}

async function runForeground(context: CliContext, home: string, link: string): Promise<void> {
  const logFile = path.join(home, 'auto-switch-daemon.log');
  const deps: DaemonDeps = {
    profiles: () => listAccounts(context.ctx).map((a) => ({ name: a.name, dir: a.dir })),
    getActive: () => getActive(context.ctx) ?? listAccounts(context.ctx)[0]?.name ?? '',
    setActive: (n) => setActive(n, context.ctx),
    readUsage: (dir) => readUsageForDir(dir),
    flip: (targetDir) => setTarget(link, targetDir, { platform: context.ctx.platform }),
    threshold: context.config.rotation.capThresholdPercent,
    log: (m) => {
      try {
        appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`);
      } catch {
        /* ignore log write failure */
      }
      context.out(m);
    },
    now: () => Date.now(),
  };

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  context.out(`watching usage; rotating at >=${deps.threshold}% (Ctrl-C to stop)`);
  await runDaemon(deps, { watchDir: link, intervalMs: 60_000, signal: controller.signal });
}
