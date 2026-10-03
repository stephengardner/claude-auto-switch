import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { listAccounts } from '../accounts/registry.js';
import { loadConfigFile, saveConfig } from '../config/config.js';
import { configHome } from '../config/paths.js';
import { appendEvent } from '../events/log.js';
import { usageConstraints, type Constraint } from '../dashboard/account-status.js';
import { readUsageSnapshot, refreshUsage, type UsageEntry } from '../usage/usage-store.js';
import { humanWait } from '../usage/report.js';
import { checkResumePrompt, checkStartPrompt } from '../session/resume-prompt.js';
import { defaultClaudeRoot } from '../session/shared-root.js';
import { hasLogin } from '../accounts/account-login.js';
import { cappedNames, loadLedger } from '../ledger/ledger.js';
import { preferredModel, roomOfFromSnapshot } from '../usage/account-room.js';
import { standingOf } from '../usage/runway.js';
import { runCommand } from './run.js';
import {
  called,
  isClaudeProcess,
  liveDesktopConversations,
  pickConversation,
  type DesktopConversation,
} from '../desktop/desktop-sessions.js';
import { desktopAccount } from '../desktop/desktop-app.js';
import {
  continuationArgs,
  handOff,
  handedOffRecently,
  lastModelIn,
  readLaunchSpec,
  readProcessFlags,
  runHandoffJob,
  scheduleHandoff,
  type HandoffDeps,
  type HandoffJob,
  type HandoffResult,
  type HandoffSettings,
  type HandoffTarget,
  type ProcessFlags,
} from '../desktop/handoff.js';
import type { PathCtx } from '../config/paths.js';
import { installDesktopHooks, readInstalledHandoff, type HandoffWhen } from '../desktop/hooks.js';
import { canOpenTerminal, pasteable } from '../desktop/terminal.js';
import type { CliContext } from '../context.js';

/**
 * `ccx desktop`: Claude Desktop, as far as ccx can reach it.
 *
 * Desktop's chat sessions run on the account Desktop itself is signed into and
 * cannot switch, so ccx works with what it can: it says which account Desktop
 * is spending and how much of it is left, and it moves a Desktop conversation
 * to a terminal where ccx does switch accounts, by hand or by itself.
 */

export interface DesktopDeps extends HandoffDeps {
  conversations?: () => DesktopConversation[];
  flagsOf?: (pid: number) => ProcessFlags;
  handOff?: typeof handOff;
  /** Where a hook leaves the handover to a detached ccx. Injected in tests. */
  schedule?: (job: HandoffJob, c: PathCtx) => boolean;
  /** Whether a terminal window can be opened here. Injected in tests. */
  canOpen?: () => boolean;
  /** Which account a conversation leaving Desktop goes to. Injected in tests. */
  destination?: (context: CliContext, leaving: string | null, model?: string | null) => string | null;
  /** What a launcher's `desktop-run` runs. Injected in tests. */
  run?: typeof runCommand;
  /** Usage for one account, refreshed when stale. Injected in tests. */
  usageOf?: (account: {
    name: string;
    dir: string;
    email?: string;
  }) => Promise<UsageEntry | undefined>;
  stdin?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
}

export interface DesktopOptions {
  wait?: boolean;
  to?: string;
  again?: boolean;
  dryRun?: boolean;
  timeout?: string;
}

const WHEN_WORDS: Record<HandoffWhen, string> = {
  off: 'only when you move one (ccx desktop move)',
  limit: 'when a Desktop turn hits a usage limit',
  credits: 'before Desktop spends usage credits, and at a usage limit',
};

/** A folder, shortened from the left so its end stays readable. */
function shortDir(dir: string, width = 44): string {
  return dir.length <= width ? dir : `…${dir.slice(dir.length - width + 1)}`;
}

/** What is spent on an account, in words, or null when nothing is. */
function spentWords(constraints: Constraint[], now: number): string | null {
  if (constraints.length === 0) return null;
  return constraints
    .map((c) => {
      const label =
        c.label === '5h'
          ? '5-hour limit'
          : c.label === 'week'
            ? 'weekly limit'
            : `${c.label} limit`;
      const wait = c.until ? humanWait(c.until, now) : '';
      return wait ? `${label} spent for ${wait}` : `${label} spent`;
    })
    .join(', ');
}

/** The account Desktop is signed into, with its usage, for status and the credits check. */
async function desktopAccountState(
  context: CliContext,
  deps: DesktopDeps,
  model: string | null,
): Promise<{ name: string; spent: Constraint[] } | null> {
  const accounts = listAccounts(context.ctx);
  const name = desktopAccount(accounts, context.ctx);
  if (!name) return null;
  const account = accounts.find((a) => a.name === name);
  if (!account) return null;
  const usageOf =
    deps.usageOf ??
    (async (a: { name: string; dir: string; email?: string }) => {
      const cached = readUsageSnapshot(context.ctx).accounts[a.name];
      // Fresh enough to decide on; otherwise ask, once, for this one account.
      if (cached && Date.now() - cached.at < 10 * 60_000) return cached;
      const snapshot = await refreshUsage([a], context.ctx, { maxAgeMs: 10 * 60_000 });
      return snapshot.accounts[a.name];
    });
  const usage = await usageOf(account);
  return { name, spent: usageConstraints(usage, model, Date.now()) };
}

function say(context: CliContext): (m: string) => void {
  return context.err ?? ((m: string) => process.stderr.write(`${m}\n`));
}

/* ------------------------------------------------------------------ */
/* ccx desktop [status]                                                */
/* ------------------------------------------------------------------ */

async function status(context: CliContext, deps: DesktopDeps): Promise<number> {
  const out = context.out;
  const conversations = (deps.conversations ?? (() => liveDesktopConversations(context.ctx)))();
  const preferred = context.config.rotation.modelPreference[0] ?? null;
  const account = await desktopAccountState(context, deps, preferred);
  const now = Date.now();
  if (account) {
    const spent = spentWords(account.spent, now);
    out(
      spent
        ? `Claude Desktop is signed in as ${account.name}: ${spent}, so Desktop is spending usage credits there (or stopping, without them).`
        : `Claude Desktop is signed in as ${account.name}, which still has plan room.`,
    );
  } else {
    out('Claude Desktop: not signed in here, or signed in as an account ccx does not have.');
  }
  out("Its conversations can't switch accounts; ccx moves one to a terminal that can.");
  out('');

  const wanted = context.config.desktop.handoff;
  const installed = readInstalledHandoff(context.ctx);
  out(`  moves by itself  ${WHEN_WORDS[wanted]}  (ccx desktop handoff off|limit|credits)`);
  if (installed !== wanted) {
    out(`  ! your Claude settings say "${installed}"; run: ccx desktop handoff ${wanted}`);
  }
  out(
    `  continues as     ${context.config.desktop.mode === 'fork' ? 'a copy; Desktop keeps the original as it was' : 'the same conversation'}  (ccx desktop mode fork|same)`,
  );
  out(`  carries on with  "${context.config.desktop.prompt}"  (ccx desktop prompt "<text>")`);
  out('');

  if (conversations.length === 0) {
    out('No conversations are open in Claude Desktop.');
    return 0;
  }
  out('Open in Claude Desktop now:');
  conversations.forEach((c, i) => {
    const mark = c.status === 'busy' ? 'busy' : c.status === 'idle' ? 'idle' : c.status;
    out(
      `  ${String(i + 1).padStart(2)}  ${mark.padEnd(5)} ${(c.name || '(untitled)').padEnd(40)} ${shortDir(c.cwd)}`,
    );
  });
  out('');
  out('Move one:  ccx desktop move <number>   (press Stop on a busy one first, or add --wait)');
  return 0;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function saveDesktop(context: CliContext, change: Partial<CliContext['config']['desktop']>): void {
  // The FILE, not the env-merged config: see the config read-modify-write rule.
  const onDisk = loadConfigFile(context.ctx);
  saveConfig({ ...onDisk, desktop: { ...onDisk.desktop, ...change } }, context.ctx);
}

/** The setting after `current`, for a key that steps through them: off, limit, credits. */
export function nextHandoff(current: HandoffWhen): HandoffWhen {
  return current === 'off' ? 'limit' : current === 'limit' ? 'credits' : 'off';
}

export function setHandoff(context: CliContext, value: string | undefined): number {
  const when = value as HandoffWhen;
  if (!['off', 'limit', 'credits'].includes(when)) {
    context.out('usage: ccx desktop handoff off|limit|credits');
    return 1;
  }
  const hooks = installDesktopHooks(when, context.ctx);
  if (!hooks.ok) {
    context.out(`could not change your Claude settings: ${hooks.reason}`);
    return 1;
  }
  saveDesktop(context, { handoff: when });
  context.out(`Desktop conversations now move to a terminal ${WHEN_WORDS[when]}.`);
  if (when === 'credits') {
    context.out('A message sent in Desktop while its account is past its plan is held there and');
    context.out('continues in a terminal instead, so it never spends usage credits.');
  }
  return 0;
}

export function setMode(context: CliContext, value: string | undefined): number {
  if (value !== 'fork' && value !== 'same') {
    context.out('usage: ccx desktop mode fork|same');
    return 1;
  }
  saveDesktop(context, { mode: value });
  context.out(
    value === 'fork'
      ? 'A moved conversation continues as a copy; Desktop keeps the original exactly as it was.'
      : 'A moved conversation continues itself. Do not send anything more to it in Desktop while it does.',
  );
  return 0;
}

export function setPrompt(context: CliContext, words: string[]): number {
  const checked = checkResumePrompt(words.join(' '));
  if (!checked.ok) {
    context.out(`not set: ${checked.reason}`);
    return 1;
  }
  saveDesktop(context, { prompt: checked.prompt });
  context.out(`A moved conversation carries on with: "${checked.prompt}"`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* ccx desktop move                                                    */
/* ------------------------------------------------------------------ */

/**
 * Where a conversation leaving Desktop goes: the best account by the
 * configured order that is not the one it is leaving, and never one that is
 * out. Chosen here, not left to the run, which could start it on the very
 * account it left. Null when no other account has room.
 *
 * Judged for the conversation's own model when it is known (the one it will
 * carry on with), the preferred one otherwise: an account whose Fable week is
 * spent has no room for a conversation on Fable, however much Opus it has.
 */
export function destinationFor(context: CliContext, leaving: string | null, conversationModel?: string | null): string | null {
  const now = Date.now();
  const capped = cappedNames(loadLedger(context.ctx), now);
  const { rotation } = context.config;
  const model = conversationModel ?? preferredModel(context);
  // Room decides whether an account can take it at all; the order decides
  // which of those goes first. A smart score is above zero for an account
  // whose 5-hour window is spent (its weekly budget still counts), so it
  // cannot be the test of "has room".
  const roomOf = roomOfFromSnapshot(context.ctx, now, 'most-room');
  const rankOf = roomOfFromSnapshot(context.ctx, now, rotation.accountOrder, model);
  const usage = readUsageSnapshot(context.ctx);
  let best: { name: string; rank: number } | null = null;
  for (const a of listAccounts(context.ctx)) {
    if (!a.enabled || a.name === leaving || capped.has(a.name) || !hasLogin(a.dir)) continue;
    if (roomOf(a.name) <= 0) continue;
    if (rotation.accountOrder === 'smart' && standingOf(usage.accounts[a.name], now, model).runway <= 0) continue;
    const rank = rotation.accountOrder === 'priority' ? -a.priority : rankOf(a.name);
    if (!best || rank > best.rank) best = { name: a.name, rank };
  }
  return best?.name ?? null;
}

function settingsFor(context: CliContext, to?: string, startPrompt?: string): HandoffSettings {
  return {
    mode: context.config.desktop.mode,
    prompt: context.config.desktop.prompt,
    ...(to ? { account: to } : {}),
    ...(startPrompt ? { startPrompt } : {}),
  };
}

/**
 * Why a conversation cannot be moved to `name`, or null when it can. Checked
 * up front, because a run told to start on an account that cannot take it
 * starts on another one, and the window would not say why.
 */
function accountRefusal(context: CliContext, name: string): string | null {
  const account = listAccounts(context.ctx).find((a) => a.name === name);
  if (!account || !account.enabled) return `no enabled account named "${name}" (see: ccx list)`;
  if (!hasLogin(account.dir)) return `"${name}" is not signed in (ccx login ${name})`;
  if (cappedNames(loadLedger(context.ctx), Date.now()).has(name)) {
    return `"${name}" is out of usage right now; ccx swap shows which accounts have room`;
  }
  return null;
}

function report(
  context: CliContext,
  result: HandoffResult,
  conv: { name: string; sessionId: string },
  settings: HandoffSettings,
): void {
  if (!result.ok) {
    context.out(`could not open a terminal: ${result.reason}`);
    return;
  }
  const where = settings.account ? ` on ${settings.account}` : '';
  context.out(`${called(conv)} continues in a ${result.via} window${where}.`);
  context.out(
    settings.mode === 'fork'
      ? 'It carries on as a copy; Desktop keeps the original exactly as it was.'
      : 'It carries on as the same conversation: send nothing more to it in Desktop.',
  );
}

export async function moveConversation(
  context: CliContext,
  which: string | undefined,
  opts: DesktopOptions,
  deps: DesktopDeps = {},
): Promise<number> {
  const conversations = (deps.conversations ?? (() => liveDesktopConversations(context.ctx)))();
  if (conversations.length === 0) {
    context.out('No conversations are open in Claude Desktop.');
    return 1;
  }
  const conv = which
    ? pickConversation(conversations, which)
    : conversations.length === 1
      ? conversations[0]
      : null;
  if (!conv) {
    context.out(
      which
        ? `no single open conversation matches "${which}"; pick one by number:`
        : 'pick one by number:',
    );
    conversations.forEach((c, i) =>
      context.out(`  ${i + 1}  ${c.status.padEnd(5)} ${c.name || '(untitled)'}`),
    );
    return 1;
  }
  if (opts.to) {
    const refusal = accountRefusal(context, opts.to);
    if (refusal) {
      context.out(refusal);
      return 1;
    }
  }
  const flags = (deps.flagsOf ?? readProcessFlags)(conv.pid);
  const to =
    opts.to ??
    (deps.destination ?? destinationFor)(
      context,
      desktopAccount(listAccounts(context.ctx), context.ctx),
      flags.model,
    );
  if (!to) {
    context.out("No account other than Desktop's own has room right now; ccx swap shows them all.");
    return 1;
  }
  if (conv.status === 'busy' && !opts.wait) {
    context.out(
      `${called(conv)} is working in Desktop right now. Press Stop on it there, then run this again,`,
    );
    context.out('or add --wait to open the terminal now and pick it up the moment it stops.');
    return 1;
  }
  const recent = handedOffRecently(conv.sessionId, context.ctx);
  if (recent !== null && !opts.again) {
    context.out(
      `${called(conv)} was moved to a terminal ${humanWait(Date.now() + (Date.now() - recent), Date.now())} ago; add --again to move it again.`,
    );
    return 1;
  }
  const target: HandoffTarget = {
    sessionId: conv.sessionId,
    cwd: conv.cwd,
    name: conv.name,
    model: flags.model,
    effort: flags.effort,
    permissionMode: flags.permissionMode,
  };
  const settings = settingsFor(context, to);
  if (opts.dryRun) {
    context.out(`would run in ${conv.cwd}:`);
    context.out(`  ccx ${pasteable(continuationArgs(target, settings))}`);
    return 0;
  }
  const result = (deps.handOff ?? handOff)(target, settings, context.ctx, deps, conv.pid);
  report(context, result, conv, settings);
  if (result.ok) {
    appendEvent(
      configHome(context.ctx),
      `desktop: moved ${called(conv)} to a terminal`,
      Date.now(),
      {
        kind: 'desktop-handoff',
        data: { why: 'by hand', mode: settings.mode, to: settings.account ?? null },
      },
    );
  }
  return result.ok ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* ccx desktop wait <pid>: the gate a launcher runs before resuming.   */
/* ------------------------------------------------------------------ */

function recordStatus(context: CliContext, pid: number): { status: string; name: string } | null {
  try {
    const file = path.join(defaultClaudeRoot(context.ctx), 'sessions', `${pid}.json`);
    if (!existsSync(file)) return null;
    const record = JSON.parse(readFileSync(file, 'utf8')) as { status?: unknown; name?: unknown };
    return {
      status: typeof record.status === 'string' ? record.status : 'unknown',
      name: typeof record.name === 'string' ? record.name : '',
    };
  } catch {
    return null;
  }
}

async function waitForDesktop(
  context: CliContext,
  pidText: string | undefined,
  opts: DesktopOptions,
  deps: DesktopDeps,
): Promise<number> {
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) {
    context.out('usage: ccx desktop wait <pid>');
    return 1;
  }
  // A Claude process, not merely a live pid: a record left "busy" by one that
  // was killed, its pid since given to something else, would hold this for an hour.
  const isAlive = deps.isAlive ?? isClaudeProcess;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const minutes = Number(opts.timeout ?? 60);
  const deadline = Date.now() + (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
  let told = false;
  for (;;) {
    const record = isAlive(pid) ? recordStatus(context, pid) : null;
    // Gone, or no longer busy: Desktop has let go of the conversation.
    if (!record || record.status !== 'busy') return 0;
    if (!told) {
      context.out(
        `Waiting for Claude Desktop to finish its turn${record.name ? ` on "${record.name}"` : ''} before carrying on here.`,
      );
      context.out('Press Stop on it in Desktop to hand it over now.');
      told = true;
    }
    if (Date.now() >= deadline) {
      context.out(
        'Desktop is still working on it, so it was not picked up here. Close this window.',
      );
      return 1;
    }
    await sleep(2_000);
  }
}

/* ------------------------------------------------------------------ */
/* ccx desktop-hook limit|prompt: run by Claude inside Desktop sessions */
/* ------------------------------------------------------------------ */

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

interface HookPayload {
  session_id?: unknown;
  cwd?: unknown;
  transcript_path?: unknown;
  error?: unknown;
  prompt?: unknown;
  permission_mode?: unknown;
  effort?: { level?: unknown };
}

/**
 * Run by Claude Desktop's sessions through the hooks `ccx desktop handoff`
 * installs. Never gets in the way: anything unexpected lets the turn or the
 * message through untouched, and only a held message exits non-zero.
 *
 * Quick on purpose: Claude waits for it, and a Claude that is exiting takes it
 * down mid-way. It decides from the payload alone and leaves the slow part,
 * reading the process and opening the window, to a detached ccx (see
 * scheduleHandoff).
 */
export async function desktopHookCommand(
  context: CliContext,
  event: string | undefined,
  deps: DesktopDeps = {},
): Promise<number> {
  const env = context.ctx.env ?? process.env;
  if (env.CLAUDE_CODE_ENTRYPOINT !== 'claude-desktop') return 0;
  const when = context.config.desktop.handoff;
  if (when === 'off' || (event === 'prompt' && when !== 'credits')) return 0;

  let payload: HookPayload;
  try {
    payload = JSON.parse(await (deps.stdin ?? readStdin)()) as HookPayload;
  } catch {
    return 0;
  }
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  if (!sessionId || !cwd) return 0;

  const pid = Number(env.CLAUDE_PID);
  const hasPid = Number.isInteger(pid) && pid > 0;
  const conv = hasPid
    ? (deps.conversations ?? (() => liveDesktopConversations(context.ctx)))().find(
        (c) => c.pid === pid,
      )
    : undefined;
  const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  const target: HandoffTarget = {
    sessionId,
    cwd,
    name: conv?.name ?? '',
    model: transcript ? lastModelIn(transcript) : null,
    effort: typeof payload.effort?.level === 'string' ? payload.effort.level : null,
    permissionMode: typeof payload.permission_mode === 'string' ? payload.permission_mode : null,
  };
  const home = configHome(context.ctx);
  const log = (msg: string, data: Record<string, unknown>): void =>
    appendEvent(home, msg, Date.now(), { kind: 'desktop-handoff', data });
  const schedule = (settings: HandoffSettings): boolean =>
    (deps.schedule ?? scheduleHandoff)(
      { target, settings, ...(hasPid ? { flagsFrom: pid, waitFor: pid } : {}) },
      context.ctx,
    );

  if (event === 'limit') {
    const error = typeof payload.error === 'string' ? payload.error : '';
    if (error !== 'rate_limit' && error !== 'billing_error') return 0;
    if (handedOffRecently(sessionId, context.ctx) !== null) return 0;
    const to = (deps.destination ?? destinationFor)(
      context,
      desktopAccount(listAccounts(context.ctx), context.ctx),
      target.model,
    );
    if (!to) {
      log(
        `desktop: ${called(target)} stopped at its account's limit, and no other account has room`,
        {
          why: 'limit',
          error,
          ok: false,
        },
      );
      return 0;
    }
    const ok = schedule(settingsFor(context, to));
    log(
      ok
        ? `desktop: ${called(target)} stopped at its account's limit; continuing it in a terminal on ${to}`
        : `desktop: ${called(target)} stopped at its account's limit; could not hand it over`,
      { why: 'limit', error, ok, to },
    );
    return 0;
  }

  if (event !== 'prompt') return 0;
  const account = await desktopAccountState(context, deps, target.model ?? null);
  if (!account || account.spent.length === 0) return 0;
  const tell = say(context);
  const spent = spentWords(account.spent, Date.now()) ?? 'past its plan';
  if (handedOffRecently(sessionId, context.ctx) !== null) {
    tell(
      `ccx: ${account.name} is past its plan (${spent}), and this conversation is already continuing in a terminal. Carry on there.`,
    );
    return 2;
  }
  const message = typeof payload.prompt === 'string' ? payload.prompt : '';
  // Held only when it can be carried over: a message too long for a command
  // line, or a machine with no terminal to open, would be lost, not saved.
  const carry = checkStartPrompt(message);
  const platform = context.ctx.platform;
  const canOpen =
    deps.canOpen ?? (() => canOpenTerminal(platform !== undefined ? { platform } : {}));
  // And only when somewhere else has room: carried to an account that is just
  // as spent, it would hit the same wall, or spend the same credits there.
  const to = (deps.destination ?? destinationFor)(context, account.name, target.model);
  if (!carry.ok || !canOpen() || !to) {
    const why = !carry.ok
      ? `it could not be carried over (${carry.reason})`
      : !to
        ? 'no other account has room'
        : 'there is no terminal program to open here';
    log(
      `desktop: ${called(target)} is past ${account.name}'s plan, but the message went to Desktop: ${why}`,
      {
        why: 'credits',
        ok: false,
      },
    );
    return 0;
  }
  const settings = settingsFor(context, to, message);
  if (!schedule(settings)) {
    // Holding the message with nowhere to send it would strand it; let it through.
    log(`desktop: could not hand ${called(target)} over; the message went to Desktop`, {
      why: 'credits',
      ok: false,
    });
    return 0;
  }
  log(`desktop: ${called(target)} is past ${account.name}'s plan; continuing it in a terminal`, {
    why: 'credits',
    ok: true,
  });
  tell(
    `ccx: ${account.name} is past its plan (${spent}), so this message did not go to Desktop, where it would spend usage credits. ` +
      `It continues in a terminal window on ${to}, with your message. Carry on there.`,
  );
  return 2;
}

/**
 * `ccx desktop-run <file>`: what a handover's window runs. The file says what
 * `ccx run` would be told; see LaunchSpec for why it is a file.
 */
export async function desktopRunCommand(
  context: CliContext,
  file: string | undefined,
  deps: DesktopDeps = {},
): Promise<number> {
  const spec = file ? readLaunchSpec(file) : null;
  if (!spec) {
    context.out(`ccx: could not read what to run from ${file ?? '(nothing given)'}`);
    return 1;
  }
  return (deps.run ?? runCommand)(context, spec.claudeArgs, {
    resumePrompt: spec.resumePrompt,
    ...(spec.startPrompt !== undefined ? { startPrompt: spec.startPrompt } : {}),
    ...(spec.account !== undefined ? { account: spec.account } : {}),
  });
}

/** The detached half of a hook's handover: read the process, open the window. */
export function desktopContinueCommand(
  context: CliContext,
  file: string | undefined,
  deps: DesktopDeps = {},
): number {
  if (!file) return 1;
  const result = runHandoffJob(file, context.ctx, deps);
  if (!result.ok) {
    appendEvent(
      configHome(context.ctx),
      `desktop: could not open a terminal: ${result.reason}`,
      Date.now(),
      {
        kind: 'desktop-handoff',
        data: { ok: false },
      },
    );
  }
  return result.ok ? 0 : 1;
}

/** Dispatch `ccx desktop [status|handoff|mode|prompt|move|wait]`. */
export async function desktopCommand(
  context: CliContext,
  action: string | undefined,
  rest: string[],
  opts: DesktopOptions = {},
  deps: DesktopDeps = {},
): Promise<number> {
  switch (action ?? 'status') {
    case 'status':
      return status(context, deps);
    case 'handoff':
      return setHandoff(context, rest[0]);
    case 'mode':
      return setMode(context, rest[0]);
    case 'prompt':
      return setPrompt(context, rest);
    case 'move':
      return moveConversation(context, rest[0], opts, deps);
    case 'wait':
      return waitForDesktop(context, rest[0], opts, deps);
    default:
      context.out(
        'usage: ccx desktop [status|handoff off|limit|credits|mode fork|same|prompt "<text>"|move [n]]',
      );
      return 1;
  }
}
