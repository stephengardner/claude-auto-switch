import { listAccounts, updateAccount } from '../accounts/registry.js';
import { getActive, setActive } from '../state/active.js';
import { writeSwitchRequest } from '../state/switch-request.js';
import { refreshUsage, readUsageSnapshot, type UsageSnapshot } from '../usage/usage-store.js';
import { probeAll, type ProbeResult } from '../health/prober.js';
import { loadLedger } from '../ledger/ledger.js';
import { renderDashboard, type DashboardAccount } from '../dashboard/render.js';
import { toSnapshot } from '../dashboard/snapshot.js';
import { dispatchKey, confirmKey } from '../dashboard/keys.js';
import { openPrompt, promptKey, rejectPrompt, type PromptState } from '../dashboard/prompt.js';
import path from 'node:path';
import { configHome, profilesDir } from '../config/paths.js';
import { addAccount, getAccount } from '../accounts/registry.js';
import { renameAccount } from '../accounts/rename.js';
import { assertProfileName } from '../util/names.js';
import { secureMkdir } from '../util/secret-file.js';
import { appendEvent, readEvents, formatEvent } from '../events/log.js';
import { syncEditorPointerIfEnabled } from '../editor/junction.js';
import { loginCommand } from './login.js';
import { getClaude, type CliContext } from '../context.js';
import { claimRawTerminal } from '../ui/raw-terminal.js';
import { signedInAndNotRejected } from '../health/signed-in.js';

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
    const loggedIn = signedInAndNotRejected(healths, accts, context.ctx);
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
        {
          fiveHour: u.fiveHour,
          sevenDay: u.sevenDay,
          fiveHourReset: u.fiveHourReset,
          sevenDayReset: u.sevenDayReset,
          ...(u.models ? { models: u.models } : {}),
        },
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
    onLogin: async (target) => {
      // Reuses the ordinary login command, so the dashboard gets the same
      // duplicate refusal and the same identity recording as `ccx login`. Its
      // output goes to the real screen, which the loop has handed back.
      const code = await loginCommand(context, target.name);
      pushEvent(code === 0 ? `signed in ${target.name}` : `sign-in for ${target.name} did not finish`);
      // Health is now stale for this account: re-probe so the row tells the truth.
      healths = await probeAll(listAccounts(context.ctx), { claude });
      return code === 0
        ? `signed "${target.name}" in again`
        : `"${target.name}" was not signed in; see the messages above`;
    },
    onRotate: () => {
      const active = getActive(context.ctx);
      const rotatable = listAccounts(context.ctx);
      const loggedIn = signedInAndNotRejected(healths, rotatable, context.ctx);
      const now = Date.now();
      const capped = new Set(
        loadLedger(context.ctx)
          .caps.filter((c) => c.capUntil && c.capUntil > now)
          .map((c) => c.account),
      );
      const next = rotatable
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
  /**
   * Sign an account in again, as itself or as a different account. Async and
   * INTERACTIVE: it hands the screen to a browser sign-in, so the dashboard steps
   * out of the way while it runs. Returns a line to show afterwards.
   */
  onLogin: (account: DashboardAccount) => Promise<string>;
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
  const ui: {
    notice: string | null;
    prompt: PromptState | null;
    /**
     * An interactive job the loop should run with the terminal handed back.
     * Set from the keypress handler, which cannot await, and picked up by the
     * loop, which can.
     */
    pendingLogin: DashboardAccount | null;
    /**
     * The account the open box was opened FOR.
     *
     * Captured rather than re-read on submit: the rows are rebuilt every tick and
     * reindexed, so another `ccx` adding or removing an account between opening
     * the box and pressing Enter would otherwise rename whatever now sits at that
     * position, which is not the account the box names.
     */
    promptTarget: DashboardAccount | null;
    /**
     * A yes/no question waiting for an answer. Signing in gives the screen away
     * to a browser, and its key sits next to the movement keys, so it asks first.
     */
    confirm: { question: string; account: DashboardAccount } | null;
  } = { notice: null, prompt: null, promptTarget: null, pendingLogin: null, confirm: null };

  /**
   * One keypress into the name box. Returns the box's next state, or null when it
   * is finished. Written as state-in/state-out so the flow stays readable.
   */
  const advancePrompt = (
    state: PromptState,
    text: string,
    byte0: number | undefined,
    target: DashboardAccount | null,
  ): PromptState | null => {
    const next = promptKey(state, text, byte0);
    if (next.status === 'cancel') return null;
    if (next.status !== 'submit') return next;
    const typed = next.text.trim();
    if (typed.length === 0) return null; // confirming an empty box just closes it
    try {
      ui.notice = deps.onName(next.kind, typed, target ?? undefined);
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
      // A pending question takes the next key, whatever it is, so the answer
      // cannot also trigger some other action.
      if (ui.confirm) {
        const asked = ui.confirm;
        ui.confirm = null;
        if (confirmKey(text, d[0]) === 'yes') {
          // Queued rather than run here: signing in is interactive and this
          // handler cannot wait. The loop runs it with the terminal handed back.
          ui.pendingLogin = asked.account;
          ui.notice = `signing in "${asked.account.name}"...`;
        }
        if (wake) wake();
        return;
      }
      if (ui.prompt) {
        ui.prompt = advancePrompt(ui.prompt, text, d[0], ui.promptTarget);
        if (!ui.prompt) ui.promptTarget = null;
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
      else if (r.action === 'login' && target) {
        ui.confirm = {
          question: `Sign in "${target.name}" again? The dashboard steps aside while you do.`,
          account: target,
        };
      }
      else if (r.action === 'add') {
        ui.prompt = openPrompt('add', 'name for the new account:');
        ui.promptTarget = null;
      } else if (r.action === 'rename') {
        if (!target) return;
        // Captured with the label, so the box acts on the account it names.
        ui.prompt = openPrompt('rename', `new name for "${target.name}":`, '');
        ui.promptTarget = target;
      } else if (r.action === 'none') return;
      ui.notice = null;
    } catch (err) {
      ui.notice = (err as Error).message;
    }
    if (wake) wake(); // re-render immediately on any handled key
  };

  // Claiming it this way registers the restore with the process, so every way out
  // (including a crash or Ctrl-C) hands the terminal back in one piece.
  const claimScreen = (): { restore: () => void } => {
    const handle = claimRawTerminal({
      epilogue: SHOW_CURSOR + EXIT_ALT,
      // A signal winds the loop down through its own exit path instead of
      // cutting the program off mid-frame, so the screen is always handed back
      // the same way whether you press q or the terminal sends a signal.
      onEnd: () => stop(),
    });
    stdin.on('data', onKey);
    out.write(ENTER_ALT + HIDE_CURSOR);
    return handle;
  };
  let terminal = claimScreen();

  /**
   * Hand the terminal back, run something interactive, then take it again.
   *
   * Signing in opens a browser and prints to the screen, which cannot happen
   * while the dashboard holds the terminal in raw mode on the alternate screen:
   * the output would be invisible and the keystrokes would be eaten by the key
   * handler. So the dashboard steps out entirely and comes back afterwards.
   */
  const withScreenHandedBack = async (lead: string, job: () => Promise<string>): Promise<string> => {
    stdin.off('data', onKey);
    terminal.restore();
    // Printed AFTER the screen is handed back, not as a dashboard notice: the
    // loop suspends before it would repaint, so a notice set here is never seen.
    // On the ordinary screen it also sits directly above the sign-in output,
    // which is where it makes sense.
    out.write(`\n${lead}\n`);
    try {
      return await job();
    } finally {
      terminal = claimScreen();
    }
  };

  let lastProbe = Date.now();
  try {
    while (running) {
      if (Date.now() - lastProbe > HEALTH_REPROBE_MS) {
        await deps.reprobe();
        lastProbe = Date.now();
      }
      if (ui.pendingLogin) {
        const target = ui.pendingLogin;
        ui.pendingLogin = null;
        ui.notice = await withScreenHandedBack(
          `Signing in "${target.name}". To use a DIFFERENT account, sign out at claude.ai first.\n` +
            'The dashboard comes back when the sign-in finishes; Ctrl-C gives up and returns to your shell.',
          () => deps.onLogin(target),
        );
      }
      snap = build();
      clamp();
      // Paint over the previous frame from the top: home, then each line clears
      // its own tail, then clear anything left below. No full-screen erase.
      const frame = renderDashboard(snap, {
        color: deps.color,
        interactive: true,
        selected,
        ...(ui.confirm ? { confirm: ui.confirm.question } : {}),
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
