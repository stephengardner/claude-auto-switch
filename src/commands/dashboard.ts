import { listAccounts } from '../accounts/registry.js';
import { getActive } from '../state/active.js';
import { probeAll, type ProbeResult } from '../health/prober.js';
import { loadLedger } from '../ledger/ledger.js';
import { renderDashboard } from '../dashboard/render.js';
import { toSnapshot } from '../dashboard/snapshot.js';
import { getClaude, type CliContext } from '../context.js';

export interface DashboardOptions {
  /** Print a single frame and exit (no live loop). */
  once?: boolean;
  /** Refresh interval in seconds. */
  interval?: string;
}

const HEALTH_REPROBE_MS = 20_000;
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_HOME = '\x1b[2J\x1b[H';

/** Live account dashboard. `--once` prints a single frame (script/CI friendly). */
export async function dashboardCommand(
  context: CliContext,
  options: DashboardOptions = {},
): Promise<number> {
  const accounts = listAccounts(context.ctx);
  if (accounts.length === 0) {
    context.out('no accounts registered (run: ccx add <name>)');
    return 0;
  }

  const claude = getClaude(context);
  const refreshMs = Math.max(1000, (Number(options.interval) || 3) * 1000);
  const color = process.stdout.isTTY === true;
  let healths: ProbeResult[] = await probeAll(accounts, { claude });

  const build = () => {
    const loggedIn = new Set(healths.filter((h) => h.loggedIn).map((h) => h.name));
    const liveEmail = new Map(healths.filter((h) => h.email).map((h) => [h.name, h.email!]));
    const livePlan = new Map(healths.filter((h) => h.plan).map((h) => [h.name, h.plan!]));
    const now = Date.now();
    const cappedUntil = new Map<string, number>();
    for (const c of loadLedger(context.ctx).caps) {
      if (c.capUntil && c.capUntil > now) cappedUntil.set(c.account, c.capUntil);
    }
    return toSnapshot({
      accounts: accounts.map((a) => ({
        name: a.name,
        ...(a.email !== undefined ? { email: a.email } : {}),
        ...(a.plan !== undefined ? { plan: a.plan } : {}),
        enabled: a.enabled,
        priority: a.priority,
      })),
      loggedIn,
      liveEmail,
      livePlan,
      cappedUntil,
      active: getActive(context.ctx),
      events: [],
      now,
      refreshMs,
    });
  };

  if (options.once) {
    context.out(renderDashboard(build(), { color }));
    return 0;
  }

  await runLiveLoop(build, {
    refreshMs,
    color,
    reprobe: async () => {
      healths = await probeAll(accounts, { claude });
    },
  });
  return 0;
}

interface LoopDeps {
  refreshMs: number;
  color: boolean;
  reprobe: () => Promise<void>;
}

/** Clear-screen refresh loop; quits on q / Ctrl-C / Ctrl-D. */
async function runLiveLoop(build: () => ReturnType<typeof toSnapshot>, deps: LoopDeps): Promise<void> {
  const out = process.stdout;
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (v: boolean) => void };

  let running = true;
  let wake: (() => void) | null = null;
  const stop = (): void => {
    running = false;
    if (wake) wake();
  };
  const onKey = (d: Buffer): void => {
    const first = d[0];
    if (d.toString('utf8') === 'q' || first === 3 || first === 4) stop();
  };

  try {
    stdin.setRawMode?.(true);
  } catch {
    /* not raw-capable */
  }
  stdin.resume();
  stdin.on('data', onKey);
  out.write(HIDE_CURSOR);

  let lastProbe = Date.now();
  try {
    while (running) {
      if (Date.now() - lastProbe > HEALTH_REPROBE_MS) {
        await deps.reprobe();
        lastProbe = Date.now();
      }
      out.write(CLEAR_HOME);
      out.write(renderDashboard(build(), { color: deps.color, interactive: true }));
      out.write('\n');
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, deps.refreshMs);
      });
      wake = null;
    }
  } finally {
    stdin.off('data', onKey);
    try {
      stdin.setRawMode?.(false);
    } catch {
      /* ignore */
    }
    stdin.pause();
    out.write(`${SHOW_CURSOR}\n`);
  }
}
