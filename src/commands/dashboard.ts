import { listAccounts, updateAccount } from '../accounts/registry.js';
import { getActive, setActive } from '../state/active.js';
import { writeSwitchRequest } from '../state/switch-request.js';
import { refreshUsage, readUsageSnapshot, type UsageSnapshot } from '../usage/usage-store.js';
import { probeAll, type ProbeResult } from '../health/prober.js';
import { loadLedger } from '../ledger/ledger.js';
import { renderDashboard, type DashboardAccount } from '../dashboard/render.js';
import { toSnapshot } from '../dashboard/snapshot.js';
import { dispatchKey } from '../dashboard/keys.js';
import { openPrompt, promptKey, rejectPrompt, type PromptState } from '../dashboard/prompt.js';
import path from 'node:path';
import { configHome, profilesDir } from '../config/paths.js';
import { addAccount, getAccount } from '../accounts/registry.js';
import { renameAccount } from '../accounts/rename.js';
import { assertProfileName } from '../util/names.js';
import { secureMkdir } from '../util/secret-file.js';
import { appendEvent, readEvents, formatEvent } from '../events/log.js';
import { syncEditorPointerIfEnabled } from '../editor/junction.js';
import { getClaude, type CliContext } from '../context.js';
import { claimRawTerminal } from '../ui/raw-terminal.js';

export interface DashboardOptions {
  /** Print a single frame and exit (no live loop). */
  once?: boolean;
  /** Refresh interval in seconds. */
  interval?: string;
}

const HEALTH_REPROBE_MS = 20_000;
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// Alternate screen + home-repaint = flicker-free. Repainting over the old frame
// (instead of clearing the whole screen each tick) is what removes the blink.
const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';
const HOME = '\x1b[H';
const CLEAR_LINE_END = '\x1b[K';
const CLEAR_BELOW = '\x1b[J';

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
  const home = configHome(context.ctx);
  const refreshMs = Math.max(1000, (Number(options.interval) || 3) * 1000);
  const color = process.stdout.isTTY === true;
  let healths: ProbeResult[] = await probeAll(initial, { claude });
  // Real per-account usage from the unified rate-limit signal, TTL-cached so the
  // network is touched at most once per account per window (about a token each).
  let usageSnap: UsageSnapshot = readUsageSnapshot(context.ctx);
  try {
    usageSnap = await refreshUsage(initial, context.ctx);
  } catch {
    /* cached (possibly empty) usage is fine */
  }
  // Dashboard actions go to the same shared log that `ccx run` writes to.
  const pushEvent = (m: string): void => appendEvent(home, m, Date.now());

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
    const usage = new Map(
      Object.entries(usageSnap.accounts).map(([name, u]) => [
        name,
        { fiveHour: u.fiveHour, sevenDay: u.sevenDay, ...(u.models ? { models: u.models } : {}) },
      ]),
    );
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
      usage,
      active: getActive(context.ctx),
      events: readEvents(home, 5).map(formatEvent),
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
      try {
        // TTL-guarded internally: refetches only entries older than the window.
        usageSnap = await refreshUsage(listAccounts(context.ctx), context.ctx);
      } catch {
        /* keep showing the cached usage */
      }
    },
    onUse: (a) => {
      setActive(a.name, context.ctx);
      syncEditorPointerIfEnabled(context);
      writeSwitchRequest(a.name, Date.now(), 'seamless', context.ctx); // in-place, no restart
      pushEvent(`switched to ${a.name}`);
    },
    onForce: (a) => {
      setActive(a.name, context.ctx);
      syncEditorPointerIfEnabled(context);
      writeSwitchRequest(a.name, Date.now(), 'restart', context.ctx); // instant, restarts session
      pushEvent(`switching to ${a.name} now`);
    },
    onToggle: (a) => {
      updateAccount(a.name, { enabled: !a.enabled }, context.ctx);
      pushEvent(`${a.enabled ? 'disabled' : 'enabled'} ${a.name}`);
    },
    onName: (kind, text, target) => {
      if (kind === 'add') {
        assertProfileName(text);
        // Checked before anything is created, so a name that is already taken
        // reports that plainly instead of failing on the folder underneath it.
        if (getAccount(text, context.ctx)) {
          throw new Error(`an account called "${text}" already exists`);
        }
        const dir = path.join(profilesDir(context.config, context.ctx), text);
        secureMkdir(dir);
        addAccount({ name: text, dir }, context.ctx);
        pushEvent(`added ${text}`);
        // The browser sign-in is deliberately not run from in here: it wants the
        // screen, and this screen is already taken. One command finishes it.
        return `added "${text}" - finish it with: ccx login ${text}`;
      }
      if (!target) return 'nothing selected to rename';
      const result = renameAccount(target.name, text, context.config, context.ctx);
      pushEvent(`renamed ${result.from} to ${result.to}`);
      return result.folderNote
        ? `renamed to "${result.to}" (${result.folderNote})`
        : `renamed "${result.from}" to "${result.to}"`;
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
        syncEditorPointerIfEnabled(context);
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
  onUse: (a: DashboardAccount) => void;
  onForce: (a: DashboardAccount) => void;
  onToggle: (a: DashboardAccount) => void;
  onRotate: () => void;
  /**
   * Apply a typed name. Returns a message to show, or throws to reject the value
   * and keep the box open so it can be corrected without retyping everything.
   */
  onName: (kind: 'add' | 'rename', text: string, selected: DashboardAccount | undefined) => string;
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
  // Shown in the footer instead of crashing the program. This handler runs on its
  // own stack, outside the loop below, so an exception escaping it would end the
  // process without restoring the terminal, which on Windows kills the shell.
  // Held in an object rather than as two plain variables: both are only ever
  // assigned inside the keypress handler, and the compiler treats a variable it
  // never sees change as still holding its initial value.
  const ui: { notice: string | null; prompt: PromptState | null } = { notice: null, prompt: null };

  /**
   * One keypress into the name box. Returns the box's next state, or null when it
   * is finished. Written as state-in/state-out so the flow stays readable.
   */
  const advancePrompt = (state: PromptState, text: string, byte0?: number): PromptState | null => {
    const next = promptKey(state, text, byte0);
    if (next.status === 'cancel') return null;
    if (next.status !== 'submit') return next;
    const typed = next.text.trim();
    if (typed.length === 0) return null; // confirming an empty box just closes it
    try {
      ui.notice = deps.onName(next.kind as 'add' | 'rename', typed, snap.accounts[selected]);
      return null;
    } catch (err) {
      // Kept open with the reason, so a clash or a bad name can be fixed without
      // retyping the whole thing.
      return rejectPrompt(next, (err as Error).message);
    }
  };

  const onKey = (d: Buffer): void => {
    try {
      const text = d.toString('utf8');
      if (ui.prompt) {
        ui.prompt = advancePrompt(ui.prompt, text, d[0]);
        if (wake) wake();
        return;
      }
      const r = dispatchKey(text, d[0], selected, snap.accounts.length);
      selected = r.selected;
      if (r.action === 'quit') return stop();
      const target = snap.accounts[selected];
      if (r.action === 'use' && target) deps.onUse(target);
      else if (r.action === 'force' && target) deps.onForce(target);
      else if (r.action === 'toggle' && target) deps.onToggle(target);
      else if (r.action === 'rotate') deps.onRotate();
      else if (r.action === 'add') ui.prompt = openPrompt('add', 'name for the new account:');
      else if (r.action === 'rename') {
        if (!target) return;
        ui.prompt = openPrompt('rename', `new name for "${target.name}":`, '');
      } else if (r.action === 'none') return;
      ui.notice = null;
    } catch (err) {
      ui.notice = (err as Error).message;
    }
    if (wake) wake(); // re-render immediately on any handled key
  };

  // Claiming it this way registers the restore with the process, so every way out
  // (including a crash or Ctrl-C) hands the terminal back in one piece.
  const terminal = claimRawTerminal({ epilogue: SHOW_CURSOR + EXIT_ALT });
  stdin.on('data', onKey);
  out.write(ENTER_ALT + HIDE_CURSOR);

  let lastProbe = Date.now();
  try {
    while (running) {
      if (Date.now() - lastProbe > HEALTH_REPROBE_MS) {
        await deps.reprobe();
        lastProbe = Date.now();
      }
      snap = build();
      clamp();
      // Paint over the previous frame from the top: home, then each line clears
      // its own tail, then clear anything left below. No full-screen erase.
      const frame = renderDashboard(snap, {
        color: deps.color,
        interactive: true,
        selected,
        ...(ui.notice ? { notice: ui.notice } : {}),
        ...(ui.prompt
          ? {
              prompt: {
                label: ui.prompt.label,
                text: ui.prompt.text,
                ...(ui.prompt.error ? { error: ui.prompt.error } : {}),
              },
            }
          : {}),
      });
      const painted = frame.split('\n').map((l) => l + CLEAR_LINE_END).join('\r\n');
      out.write(HOME + painted + '\r\n' + CLEAR_BELOW);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, deps.refreshMs);
        // Waking early (a keypress / quit) clears the pending refresh timer, so
        // quitting exits immediately instead of leaving a dangling timer that
        // keeps the process (and the terminal) hung for up to refreshMs.
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  } finally {
    stdin.off('data', onKey);
    terminal.restore();
  }
}
