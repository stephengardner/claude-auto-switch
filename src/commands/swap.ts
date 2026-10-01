import path from 'node:path';
import { dashboardCommand } from './dashboard.js';
import type { StateAccount, StatePayload } from '../dashboard/state-payload.js';
import { effectiveUtilization } from '../usage/window-open.js';
import { normalizeModel } from '../usage/model-preference.js';
import { bar, humanWait } from '../usage/report.js';
import { codes, paint, shadeForUsed } from '../ui/style.js';
import { isSessionDir, pidOfSessionDir } from '../session/session-dir.js';
import { liveLeases } from '../session/lease.js';
import { writeSwitchRequest } from '../state/switch-request.js';
import { setActive } from '../state/active.js';
import { syncEditorPointerIfEnabled } from '../editor/junction.js';
import { listAccounts } from '../accounts/registry.js';
import { liveDesktopConversations, type DesktopConversation } from '../desktop/desktop-sessions.js';
import { desktopAccount } from '../desktop/desktop-app.js';
import { handOff, readProcessFlags, type HandoffDeps, type ProcessFlags } from '../desktop/handoff.js';
import { appendEvent } from '../events/log.js';
import { configHome } from '../config/paths.js';
import type { CliContext } from '../context.js';

/**
 * `ccx swap`: every account, how much room it has left, and a move to the one
 * you pick, from wherever you are.
 *
 * Read by the `/ccx` skill inside Claude as well as by people at a terminal,
 * so the board is drawn here, once, the same way every time: the model laying
 * it out never has to compute a bar or decide an order.
 */

/** Where the command is being run from. */
export interface Here {
  /** A ccx terminal session, a Claude Desktop conversation, or neither. */
  kind: 'ccx' | 'desktop' | 'none';
  account: string | null;
  /** The ccx session's pid, or the Desktop Claude process's. */
  pid?: number;
  /** Desktop's title for the conversation. */
  conversation?: string;
}

export interface SwapDeps extends HandoffDeps {
  /** What `ccx state` says. Injected in tests. */
  state?: () => Promise<StatePayload>;
  conversations?: () => DesktopConversation[];
  flagsOf?: (pid: number) => ProcessFlags;
  handOff?: typeof handOff;
}

/** The state `ccx state` prints, taken from the same code path. */
async function readState(context: CliContext): Promise<StatePayload> {
  let text = '';
  await dashboardCommand({ ...context, out: (line: string) => (text += `${line}\n`) }, { json: true });
  return JSON.parse(text) as StatePayload;
}

export function whereAmI(context: CliContext, conversations: () => DesktopConversation[]): Here {
  const env = context.ctx.env ?? process.env;
  // A ccx session runs Claude on a config folder of its own, named for the pid.
  const own = env.CLAUDE_CONFIG_DIR;
  if (own && isSessionDir(own, context.ctx)) {
    const pid = pidOfSessionDir(path.basename(path.resolve(own)));
    if (pid !== null) {
      const lease = liveLeases(context.ctx).find((l) => l.pid === pid);
      return { kind: 'ccx', account: lease?.account ?? null, pid };
    }
  }
  if (env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') {
    const pid = Number(env.CLAUDE_PID);
    const conv = Number.isInteger(pid) ? conversations().find((c) => c.pid === pid) : undefined;
    return {
      kind: 'desktop',
      account: desktopAccount(listAccounts(context.ctx), context.ctx),
      ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
      ...(conv?.name ? { conversation: conv.name } : {}),
    };
  }
  return { kind: 'none', account: null };
}

/* ------------------------------------------------------------------ */
/* The board                                                           */
/* ------------------------------------------------------------------ */

interface Window {
  used: number | null;
  resetsAt: number | null;
}

interface Row {
  account: StateAccount;
  fiveHour: Window;
  week: Window;
  model: Window | null;
  /** Share of the tightest window that matters still left, 0..1. */
  room: number;
  eligible: boolean;
  here: boolean;
  recommended: boolean;
  status: string;
}

function windowOf(used: number | null | undefined, resetsAt: number | null | undefined, now: number): Window {
  return { used: effectiveUtilization(used ?? null, resetsAt ?? null, now), resetsAt: resetsAt ?? null };
}

function modelWindowOf(a: StateAccount, model: string | null, now: number): Window | null {
  if (!model) return null;
  const key = normalizeModel(model);
  const found = (a.usage?.models ?? []).find((m) => normalizeModel(m.name) === key);
  return found ? windowOf(found.utilization, found.resetsAt, now) : { used: null, resetsAt: null };
}

function statusWords(a: StateAccount, here: boolean, now: number): string {
  if (!a.enabled) return 'turned off';
  if (!a.loggedIn || a.status.state === 'logged-out') return `signed out (ccx login ${a.name})`;
  if (a.status.state === 'blocked') {
    const what =
      a.status.label === '5h' ? '5-hour limit' : a.status.label === 'week' ? 'week' : `${a.status.label ?? 'limit'}`;
    const back = a.status.until ? humanWait(a.status.until, now) : '';
    return back ? `${what} spent, back in ${back}` : `${what} spent`;
  }
  return here ? 'ready, you are here' : 'ready';
}

export function rankAccounts(state: StatePayload, here: Here): Row[] {
  const now = state.now;
  const rows: Row[] = state.accounts.map((a) => {
    const fiveHour = windowOf(a.usage?.fiveHour, a.usage?.fiveHourReset, now);
    const week = windowOf(a.usage?.sevenDay, a.usage?.sevenDayReset, now);
    const model = modelWindowOf(a, state.preferredModel, now);
    const left = [fiveHour, week, ...(model ? [model] : [])].map((w) => 1 - (w.used ?? 0));
    const isHere = here.account === a.name;
    const eligible = a.enabled && a.loggedIn && a.status.state === 'ready';
    return {
      account: a,
      fiveHour,
      week,
      model,
      room: eligible ? Math.max(0, Math.min(...left)) : 0,
      eligible,
      here: isHere,
      recommended: false,
      status: statusWords(a, isHere, now),
    };
  });
  const order = (r: Row): number =>
    r.eligible ? 0 : r.account.status.state === 'blocked' ? 1 : r.account.enabled ? 2 : 3;
  rows.sort(
    (a, b) =>
      order(a) - order(b) ||
      b.room - a.room ||
      (a.account.status.until ?? 0) - (b.account.status.until ?? 0) ||
      a.account.name.localeCompare(b.account.name),
  );
  const best = rows.find((r) => r.eligible && !r.here);
  if (best) best.recommended = true;
  return rows;
}

function gauge(w: Window, color: boolean, size = 10): string {
  const pct = w.used === null ? '?' : `${Math.round(w.used * 100)}%`;
  return `${paint(bar(w.used, size), shadeForUsed(w.used), color)} ${pct.padStart(4)}`;
}

function hereWords(here: Here): string {
  if (here.kind === 'ccx') return `this ccx session is on ${here.account ?? 'an unknown account'}`;
  if (here.kind === 'desktop') {
    const what = here.conversation ? `"${here.conversation}" in Claude Desktop` : 'this Claude Desktop conversation';
    return `${what} is on ${here.account ?? 'an account ccx does not have'}`;
  }
  return 'not inside a session';
}

export function swapEffect(here: Here): string {
  if (here.kind === 'ccx') return 'This session moves to it in place, within about 30 seconds; nothing restarts.';
  if (here.kind === 'desktop') {
    return 'Desktop cannot switch accounts, so this conversation continues in a terminal window on it, with all its history, once this reply ends.';
  }
  return 'New sessions start on it; running sessions stay where they are.';
}

export function renderBoard(rows: Row[], state: StatePayload, here: Here, color: boolean): string {
  const nameW = Math.max(7, ...rows.map((r) => r.account.name.length));
  const modelName = (state.preferredModel ?? 'model').toUpperCase();
  const col = (text: string): string => text.padEnd(15);
  const lines = [
    paint(`ccx swap: ${hereWords(here)}`, codes.bold, color),
    '',
    `     ${'ACCOUNT'.padEnd(nameW)}   ${col('5-HOUR')}   ${col('WEEK')}   ${state.preferredModel ? col(modelName) : ''}`.trimEnd(),
  ];
  for (const r of rows) {
    const mark = r.recommended ? paint('  ★ ', codes.brightYellow, color) : r.here ? paint('  ▶ ', codes.cyan, color) : '    ';
    const name = paint(r.account.name.padEnd(nameW), r.eligible ? codes.bold : codes.dim, color);
    const status = paint(r.status, r.eligible ? (r.here ? codes.cyan : codes.green) : codes.dim, color);
    lines.push(
      `${mark} ${name}   ${gauge(r.fiveHour, color)}   ${gauge(r.week, color)}   ${r.model ? `${gauge(r.model, color)}   ` : ''}${status}`,
    );
  }
  const best = rows.find((r) => r.recommended);
  lines.push('');
  lines.push(best ? `★ most room: ${best.account.name}` : 'No account has room right now.');
  lines.push(`ccx swap <name>: ${swapEffect(here)}`);
  return lines.join('\n');
}

/** The card shown beside an option in Claude's picker. Plain text, fixed width. */
export function card(r: Row, state: StatePayload): string {
  const now = state.now;
  const line = (label: string, w: Window): string => {
    const reset = w.resetsAt && w.resetsAt > now ? `  resets in ${humanWait(w.resetsAt, now)}` : '';
    return `${label.padEnd(7)}${gauge(w, false, 16)}${reset}`;
  };
  const rule = '─'.repeat(36);
  return [
    r.account.email ? `${r.account.name} · ${r.account.email}` : r.account.name,
    rule,
    line('5-hour', r.fiveHour),
    line('week', r.week),
    ...(r.model ? [line(normalizeModel(state.preferredModel ?? '') || 'model', r.model)] : []),
    rule,
    r.recommended ? `${r.status} · most room of any account` : r.status,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* The command                                                         */
/* ------------------------------------------------------------------ */

export interface SwapOptions {
  json?: boolean;
}

export async function swapCommand(
  context: CliContext,
  name: string | undefined,
  opts: SwapOptions = {},
  deps: SwapDeps = {},
): Promise<number> {
  const conversations = deps.conversations ?? (() => liveDesktopConversations(context.ctx));
  const here = whereAmI(context, conversations);
  const state = await (deps.state ?? (() => readState(context)))();
  const rows = rankAccounts(state, here);

  if (!name) {
    if (opts.json) {
      const best = rows.find((r) => r.recommended);
      context.out(
        JSON.stringify(
          {
            here,
            model: state.preferredModel,
            recommended: best ? best.account.name : null,
            board: renderBoard(rows, state, here, false),
            accounts: rows.map((r) => ({
              name: r.account.name,
              email: r.account.email ?? null,
              eligible: r.eligible,
              here: r.here,
              recommended: r.recommended,
              room: Math.round(r.room * 100) / 100,
              status: r.status,
              card: card(r, state),
            })),
            swap: { command: 'ccx swap <name>', effect: swapEffect(here) },
          },
          null,
          2,
        ),
      );
      return 0;
    }
    context.out(renderBoard(rows, state, here, process.stdout.isTTY === true));
    return 0;
  }

  const row = rows.find((r) => r.account.name === name);
  if (!row) {
    context.out(`no account named "${name}" (see: ccx swap)`);
    return 1;
  }
  if (row.here) {
    context.out(`Already on ${name}.`);
    return 0;
  }
  if (!row.eligible) {
    const best = rows.find((r) => r.recommended);
    context.out(`${name} cannot take it: ${row.status}.${best ? ` ${best.account.name} has the most room.` : ''}`);
    return 1;
  }

  const home = configHome(context.ctx);
  if (here.kind === 'ccx' && here.pid !== undefined) {
    writeSwitchRequest(name, Date.now(), 'seamless', context.ctx, here.pid);
    appendEvent(home, `swap: session ${here.pid} asked to move to ${name}`, Date.now());
    context.out(`This session moves to ${name} in place, within about 30 seconds. Nothing restarts.`);
    return 0;
  }

  if (here.kind === 'desktop') {
    const conv = here.pid !== undefined ? conversations().find((c) => c.pid === here.pid) : undefined;
    if (!conv) {
      context.out('Could not find this Desktop conversation to move. Try: ccx desktop move');
      return 1;
    }
    const flags = (deps.flagsOf ?? readProcessFlags)(conv.pid);
    const result = (deps.handOff ?? handOff)(
      {
        sessionId: conv.sessionId,
        cwd: conv.cwd,
        name: conv.name,
        model: flags.model,
        effort: flags.effort,
        permissionMode: flags.permissionMode,
      },
      { mode: context.config.desktop.mode, prompt: context.config.desktop.prompt, account: name },
      context.ctx,
      deps,
      // This reply is still being written: the window waits for it to finish.
      conv.pid,
    );
    if (!result.ok) {
      context.out(`Could not open a terminal: ${result.reason}`);
      return 1;
    }
    appendEvent(home, `swap: Desktop conversation "${conv.name}" continues on ${name} in a terminal`, Date.now(), {
      kind: 'desktop-handoff',
      data: { why: 'swap', to: name },
    });
    context.out(
      `"${conv.name || 'This conversation'}" continues in a ${result.via} window on ${name} as soon as this reply ends. Carry on there, and send nothing more here.`,
    );
    return 0;
  }

  setActive(name, context.ctx);
  syncEditorPointerIfEnabled(context);
  context.out(`New sessions start on ${name}. Running ones stay where they are (ccx use ${name} moves them too).`);
  return 0;
}
