import { listAccounts, updateAccount } from '../accounts/registry.js';
import { getActive, setActive } from '../state/active.js';
import { probeAll, type ProbeResult } from '../health/prober.js';
import { loadLedger } from '../ledger/ledger.js';
import { renderDashboard, type DashboardAccount } from '../dashboard/render.js';
import { toSnapshot } from '../dashboard/snapshot.js';
import { dispatchKey } from '../dashboard/keys.js';
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
  const initial = listAccounts(context.ctx);
  if (initial.length === 0) {
    context.out('no accounts registered (run: ccx add <name>)');
    return 0;
  }

  const claude = getClaude(context);
  const refreshMs = Math.max(1000, (Number(options.interval) || 3) * 1000);
  const color = process.stdout.isTTY === true;
  let healths: ProbeResult[] = await probeAll(initial, { claude });
  const events: string[] = [];
  const pushEvent = (m: string): void => {
    events.push(m);
    if (events.length > 20) events.shift();
  };

  // Re-read accounts + ledger + active every tick so interactive edits show live.
  const build = () => {
    const accts = listAccounts(context.ctx);
    const loggedIn = new Set(healths.filter((h) => h.loggedIn).map((h) => h.name));
    const liveEmail = new Map(healths.filter((h) => h.email).map((h) => [h.name, h.email!]));
    const livePlan = new Map(healths.filter((h) => h.plan).map((h) => [h.name, h.plan!]));
    const now = Date.now();
    const cappedUntil = new Map<string, number>();
    for (const c of loadLedger(context.ctx).caps) {
      if (c.capUntil && c.capUntil > now) cappedUntil.set(c.account, c.capUntil);
    }
    return toSnapshot({
      accounts: accts.map((a) => ({
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
      events: events.slice(-5),
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
      healths = await probeAll(listAccounts(context.ctx), { claude });
    },
    onPin: (a) => {
      setActive(a.name, context.ctx);
      pushEvent(`pinned ${a.name}`);
    },
    onToggle: (a) => {
      updateAccount(a.name, { enabled: !a.enabled }, context.ctx);
      pushEvent(`${a.enabled ? 'disabled' : 'enabled'} ${a.name}`);
    },
    onRotate: () => {
      const active = getActive(context.ctx);
      const loggedIn = new Set(healths.filter((h) => h.loggedIn).map((h) => h.name));
      const now = Date.now();
      const capped = new Set(
        loadLedger(context.ctx)
          .caps.filter((c) => c.capUntil && c.capUntil > now)
          .map((c) => c.account),
      );
      const next = listAccounts(context.ctx)
        .filter((a) => a.enabled && loggedIn.has(a.name) && !capped.has(a.name) && a.name !== active)
        .sort((x, y) => x.priority - y.priority)[0];
      if (next) {
        setActive(next.name, context.ctx);
        pushEvent(`rotated to ${next.name}`);
      } else {
        pushEvent('no other healthy account to rotate to');
      }
    },
  });
  return 0;
}

interface LoopDeps {
  refreshMs: number;
  color: boolean;
  reprobe: () => Promise<void>;
  onPin: (a: DashboardAccount) => void;
  onToggle: (a: DashboardAccount) => void;
  onRotate: () => void;
}

/** Clear-screen refresh loop with a selection cursor; quits on q / Ctrl-C / Ctrl-D. */
async function runLiveLoop(build: () => ReturnType<typeof toSnapshot>, deps: LoopDeps): Promise<void> {
  const out = process.stdout;
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (v: boolean) => void };

  let running = true;
  let selected = 0;
  let snap = build();
  let wake: (() => void) | null = null;

  const clamp = (): void => {
    selected = Math.max(0, Math.min(selected, snap.accounts.length - 1));
  };
  const stop = (): void => {
    running = false;
    if (wake) wake();
  };
  const onKey = (d: Buffer): void => {
    const r = dispatchKey(d.toString('utf8'), d[0], selected, snap.accounts.length);
    selected = r.selected;
    if (r.action === 'quit') return stop();
    const target = snap.accounts[selected];
    if (r.action === 'pin' && target) deps.onPin(target);
    else if (r.action === 'toggle' && target) deps.onToggle(target);
    else if (r.action === 'rotate') deps.onRotate();
    else if (r.action === 'none') return;
    if (wake) wake(); // re-render immediately on any handled key
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
      snap = build();
      clamp();
      out.write(CLEAR_HOME);
      out.write(renderDashboard(snap, { color: deps.color, interactive: true, selected }));
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
