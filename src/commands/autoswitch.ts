import os from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAccount } from '../accounts/registry.js';
import { hasWorkingLogin } from '../accounts/account-login.js';
import { acquireOwnedLock, type LockHandle } from '../claude/locks.js';
import { loadConfigFile, saveConfig } from '../config/config.js';
import { ConfigSchema, type PartialConfig } from '../config/config.schema.js';
import type { CliContext } from '../context.js';
import {
  assertSshHost,
  COMMAND_NOT_FOUND,
  SSH_FAILED,
  SSH_UNAVAILABLE,
  type RemoteResult,
} from '../remote/ssh.js';
import { activeSince, getActive } from '../state/active.js';
import { readHandPick } from '../state/hand-pick.js';
import { newerInstall, type NewerInstall } from '../update/newer-install.js';
import { CasError } from '../util/errors.js';
import { MINUTE, standingPick, type MoveKind } from '../autoswitch/decide.js';
import { applyFollow, APPLY_EXIT } from '../autoswitch/followers.js';
import {
  clearWebhook,
  postToSlack,
  readWebhook,
  saveWebhook,
  webhookHost,
} from '../autoswitch/notify.js';
import { runPass, type PassReport } from '../autoswitch/pass.js';
import { readTotals } from '../autoswitch/reads.js';
import { runRemote, runRemoteCcx, type UnattendedOptions } from '../autoswitch/remote.js';
import { serviceGuide } from '../autoswitch/service.js';
import {
  beat,
  lastBeat,
  loadState,
  passLockPath,
  pause,
  readControls,
  resume,
  setEarlyMoves,
  watchDir,
} from '../autoswitch/state.js';
import {
  loadWatchdogState,
  parseFacts,
  saveWatchdogState,
  watchdogPass,
  type WatchdogReport,
} from '../autoswitch/watchdog.js';
import {
  announce,
  buildPassDeps,
  logLine,
  reloadConfig,
  switchUnderLock,
  type WiringOptions,
} from '../autoswitch/wiring.js';

/**
 * `ccx autoswitch`: one watcher for the whole machine.
 *
 * `ccx auto` asks every account for its usage on each check and moves when the
 * cached number for the active one is past the threshold. This reads only the
 * account in use, once a minute and directly, and decides from its own last
 * few readings, so it sees a fast burn, a spent account and a refused login,
 * and it reads the account it is about to move to before it moves. Run one or
 * the other: two switchers with different rules will each undo the other.
 */

export interface AutoswitchOptions {
  json?: boolean;
  dryRun?: boolean;
  force?: boolean;
  /** Who is asking, for the history. */
  by?: string;
  /** Decide by one model's own week. */
  model?: string;
  /** Seconds between passes when looping. */
  interval?: string;
  /** stats: how far back to count. */
  hours?: string;
  /** watchdog: the machine the watcher runs on. */
  host?: string;
  /** watchdog: what to run there to start the watcher again. */
  restart?: string;
  /** watchdog: how ccx is run there. */
  remoteCcx?: string;
  /** watchdog: one check and exit. */
  once?: boolean;
  /** apply: the move another machine made. */
  from?: string;
  to?: string;
  kind?: string;
}

/** Stable exit codes for a pass, the ones `ccx auto` uses. */
export const AUTOSWITCH_EXIT = {
  switched: 0,
  error: 1,
  nothingToDo: 2,
  /** A pause, a pick or the early-moves switch held a move back. */
  held: 3,
} as const;

export interface AutoswitchDeps extends WiringOptions {
  /** Injected in tests: ends a loop. */
  signal?: AbortSignal;
  /** Injected in tests: the wait between passes. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injected in tests: a newer ccx installed under this one. */
  newerInstall?: () => NewerInstall | null;
  /** Injected in tests: how ccx is run on another machine. */
  remoteCcx?: (host: string, args: string[], options?: UnattendedOptions) => Promise<RemoteResult>;
  /** Injected in tests: how a command of the user's own is run on another machine. */
  remoteShell?: (host: string, command: string) => Promise<RemoteResult>;
  /** Injected in tests: everything piped in on standard input. */
  readStdin?: () => Promise<string>;
  /** Injected in tests: whether something starts the watcher again when it exits (not on Windows). */
  restartsOnExit?: boolean;
  nodePath?: string;
  cliPath?: string;
}

const ACTIONS =
  'status|run|once|now|pause|resume|early|notify|label|followers|stats|service|watchdog';
/** A pass asks every account at worst; five minutes is far past the slowest. */
const PASS_MAX_MS = 5 * MINUTE;
const MOVE_KINDS: readonly MoveKind[] = ['early', 'burn', 'blind-high', 'spent', 'dead', 'blind', 'forced'];

export async function autoswitchCommand(
  context: CliContext,
  action = 'status',
  args: string[] = [],
  options: AutoswitchOptions = {},
  deps: AutoswitchDeps = {},
): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  try {
    switch (action) {
      case 'status':
        return status(context, options, now());
      case 'run':
        return await runLoop(context, options, deps);
      case 'once':
        return await onePass(context, options, deps, { manual: false, waitMs: 0 });
      case 'now':
        return await onePass(context, options, deps, { manual: true, waitMs: 2 * MINUTE });
      case 'pause': {
        const reason = args.join(' ').trim() || `paused by ${asker(options)}`;
        pause(reason, context.ctx);
        logLine(context, `paused: ${reason}`, now());
        context.out('switching is paused: no move of any kind. The watcher keeps reading and says what it would have done.');
        context.out('  back on with: ccx autoswitch resume');
        return 0;
      }
      case 'resume':
        resume(context.ctx);
        logLine(context, `resumed by ${asker(options)}`, now());
        context.out('auto-switch is on.');
        return 0;
      case 'early':
        return early(context, args[0], options, now());
      case 'stats':
        return stats(context, options, now());
      case 'notify':
        return await notify(context, args[0], deps, now());
      case 'label':
        return setLabel(context, args);
      case 'followers':
        return followers(context, args[0], args[1]);
      case 'service':
        return service(context, deps);
      case 'watchdog':
        return await watchdog(context, options, deps);
      case 'facts':
        return facts(context, now());
      case 'apply':
        return apply(context, options, now());
      default:
        context.out(`usage: ccx autoswitch <${ACTIONS}>`);
        return 1;
    }
  } catch (err) {
    if (!(err instanceof CasError)) throw err;
    context.out(err.message);
    return 1;
  }
}

/** Who to put down as asking: named, or whoever is logged in here. */
function asker(options: AutoswitchOptions): string {
  if (options.by) return options.by;
  try {
    return os.userInfo().username;
  } catch {
    return 'someone';
  }
}

/** "40s", "12 min", "3h 5m", "2d 4h". */
function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * One pass at a time on a machine. The service, a person asking for a pass
 * now, and another machine's watchdog running one all come through here, and
 * a second pass reading and switching alongside the first is how an account
 * gets read twice a second and a switch gets made twice.
 */
function passLock(context: CliContext, waitMs: number): LockHandle {
  mkdirSync(watchDir(context.ctx), { recursive: true, mode: 0o700 });
  return acquireOwnedLock(passLockPath(context.ctx), { waitMs, staleMs: MINUTE, maxHoldMs: PASS_MAX_MS });
}

function exitFor(report: PassReport): number {
  if (report.outcome === 'switched' || report.outcome === 'would-switch') return AUTOSWITCH_EXIT.switched;
  if (report.outcome === 'failed') return AUTOSWITCH_EXIT.error;
  if (report.outcome === 'held') return AUTOSWITCH_EXIT.held;
  return AUTOSWITCH_EXIT.nothingToDo;
}

function say(context: CliContext, options: AutoswitchOptions, report: PassReport): void {
  if (options.json || context.json) {
    context.out(
      JSON.stringify({
        schemaVersion: 1,
        event: report.outcome,
        ...(report.account ? { account: report.account } : {}),
        ...(report.target?.name ? { target: report.target.name } : {}),
        ...(report.read ? { read: report.read } : {}),
        reason: report.detail,
      }),
    );
    return;
  }
  context.out(report.account ? `${report.account}: ${report.detail}` : report.detail);
}

async function onePass(
  context: CliContext,
  options: AutoswitchOptions,
  deps: AutoswitchDeps,
  how: { manual: boolean; waitMs: number },
): Promise<number> {
  reloadConfig(context);
  const lock = passLock(context, how.waitMs);
  if (!lock.held) {
    context.out(how.manual ? 'another pass held the lock for two minutes; try again' : 'another pass is running');
    return AUTOSWITCH_EXIT.nothingToDo;
  }
  try {
    const report = await runPass(buildPassDeps(context, { ...deps, ...(options.model ? { model: options.model } : {}) }), {
      by: options.by ?? (how.manual ? asker(options) : 'watcher'),
      manual: how.manual,
      ...(options.force ? { force: true } : {}),
      ...(options.dryRun ? { dryRun: true } : {}),
    });
    say(context, options, report);
    return exitFor(report);
  } finally {
    lock.release();
  }
}

/**
 * Say that something in a loop failed, without ending the loop. The reason
 * goes to ccx's history, which only its owner can read. Standard error gets
 * the kind of failure alone: under a service it lands in a system log that
 * others can read, and an error's message can carry a path with an account's
 * name in it.
 */
function sayFailure(context: CliContext, what: string, err: unknown): void {
  const error = err as NodeJS.ErrnoException;
  logLine(context, `${what} failed: ${error.message}`);
  context.err?.(`ccx autoswitch: ${what} failed (${error.code ?? error.name}); ccx history has the reason. Carrying on`);
}

/** A wait that ends early when the loop is told to stop. */
function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    // Not unref'd: this loop is meant to keep running until it is stopped.
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/** The signal a loop runs under: the test's, or one that Ctrl-C and a service stop end. */
function stopSignal(deps: AutoswitchDeps): AbortSignal {
  if (deps.signal) return deps.signal;
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  return controller.signal;
}

async function runLoop(context: CliContext, options: AutoswitchOptions, deps: AutoswitchDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const intervalMs = Math.max(10, Number(options.interval) || 30) * 1000;
  const signal = stopSignal(deps);
  const sleep = deps.sleep ?? sleepUntil;
  const json = options.json === true || context.json;
  if (!json && !context.quiet) {
    context.out(`watching the account in use, a pass every ${Math.round(intervalMs / 1000)}s (Ctrl-C to stop)`);
  }
  // A systemd unit or a launch agent starts the watcher again when it exits.
  // A Windows task started at sign-in does not, so there the watcher never
  // ends itself: one that is a release behind beats none at all.
  const restartsOnExit = deps.restartsOnExit ?? (context.ctx.platform ?? process.platform) !== 'win32';
  let toldOfNewer = '';
  let said = '';
  while (!signal.aborted) {
    let lock: LockHandle | undefined;
    try {
      beat(context.ctx, now());
      reloadConfig(context);
      lock = passLock(context, 0);
      if (lock.held) {
        const report = await runPass(
          buildPassDeps(context, { ...deps, ...(options.model ? { model: options.model } : {}) }),
          { by: options.by ?? 'watcher' },
        );
        // A line when something changed, not one every thirty seconds saying it did not.
        const what = `${report.account ?? ''}|${report.outcome}|${report.decision?.act ? report.decision.kind : (report.decision?.cat ?? '')}`;
        if (json || (!context.quiet && (what !== said || report.outcome === 'switched'))) say(context, options, report);
        said = what;
      }
    } catch (err) {
      // Nothing a pass trips over may end the watcher: the next one starts clean.
      sayFailure(context, 'a pass', err);
    } finally {
      lock?.release();
    }
    const newer = (deps.newerInstall ?? newerInstall)();
    if (newer && restartsOnExit) {
      // Its service starts it again, on the new one.
      context.out(`ccx ${newer.version} is installed; ending so the watcher starts again on it`);
      return 0;
    }
    if (newer && newer.version !== toldOfNewer) {
      toldOfNewer = newer.version;
      context.out(`ccx ${newer.version} is installed; this watcher stays on the old one until its task is run again (schtasks /End, then /Run)`);
    }
    await sleep(intervalMs, signal);
  }
  return 0;
}

function early(context: CliContext, word: string | undefined, options: AutoswitchOptions, now: number): number {
  if (word !== 'on' && word !== 'off') {
    const { earlyOff } = readControls(context.ctx);
    context.out(
      earlyOff
        ? 'early moves are off: nothing moves before an account is used up. Back on with: ccx autoswitch early on'
        : `early moves are on: the watcher moves at ${context.config.autoSwitch.thresholdPercent}% used. Hold them with: ccx autoswitch early off`,
    );
    return 0;
  }
  setEarlyMoves(word === 'on', context.ctx, asker(options));
  logLine(context, `early moves turned ${word} by ${asker(options)}`, now);
  context.out(
    word === 'on'
      ? `early moves are on: the watcher moves at ${context.config.autoSwitch.thresholdPercent}% used.`
      : 'early moves are off: nothing moves before an account is used up. One that cannot run still moves, so nothing gets stuck.',
  );
  return 0;
}

function status(context: CliContext, options: AutoswitchOptions, now: number): number {
  const { ctx, config } = context;
  const state = loadState(ctx);
  const controls = readControls(ctx);
  const webhook = readWebhook(ctx);
  const beatAt = lastBeat(ctx);
  const last = state.reads.at(-1) ?? null;
  const mode = controls.paused !== null ? 'paused' : controls.earlyOff ? 'early-off' : 'on';
  const alsoProactive = config.rotation.proactivePercent > 0;

  if (options.json || context.json) {
    context.out(
      JSON.stringify({
        schemaVersion: 1,
        mode,
        ...(controls.paused !== null ? { pausedBecause: controls.paused } : {}),
        active: getActive(ctx),
        thresholdPercent: config.autoSwitch.thresholdPercent,
        hysteresisPercent: config.autoSwitch.hysteresisPercent,
        lastServicePassAt: beatAt,
        lastPassAt: state.lastPassAt || null,
        lastReading: last ? { used: last.used, at: last.at } : null,
        lastDecision: state.lastWhy,
        lastSwitch: state.lastSwitch,
        messages: webhook ? { to: webhookHost(webhook), nameAccounts: config.autoSwitch.nameAccounts } : null,
        followers: config.autoSwitch.followers,
      }),
    );
    return 0;
  }

  const out = context.out;
  out(
    mode === 'paused'
      ? `auto-switch:    PAUSED (${controls.paused}); no move of any kind. Back on with: ccx autoswitch resume`
      : mode === 'early-off'
        ? 'auto-switch:    early moves off; an account that cannot run still moves. Back on with: ccx autoswitch early on'
        : `auto-switch:    on; moves at ${config.autoSwitch.thresholdPercent}% used, to an account with ${config.autoSwitch.hysteresisPercent} points more room`,
  );
  out(
    state.lastPassAt
      ? `watcher:        last pass ${span(now - state.lastPassAt)} ago, by ${state.lastPassBy ?? 'someone'}${beatAt !== null && now - beatAt > 3 * MINUTE ? '; its service has not run one for ' + span(now - beatAt) : ''}`
      : 'watcher:        has never run here. Try it: ccx autoswitch run. Keep it running: ccx autoswitch service',
  );
  out(
    state.account
      ? `account in use: ${state.account.name}, for ${span(now - state.account.since)}`
      : `account in use: ${getActive(ctx) ?? 'none'}`,
  );
  out(
    `last reading:   ${last ? `${Math.round(last.used * 100)}% used, ${span(now - last.at)} ago` : 'none yet'}` +
      (state.lastFailure ? `; the read ${span(now - state.lastFailure.at)} ago failed (${String(state.lastFailure.status)})` : ''),
  );
  if (state.lastWhy) out(`last decision:  ${state.lastWhy}`);
  out(
    state.lastSwitch
      ? `last switch:    ${state.lastSwitch.from} to ${state.lastSwitch.to}, ${span(now - state.lastSwitch.at)} ago (${state.lastSwitch.kind}: ${state.lastSwitch.why}), by ${state.lastSwitch.by}`
      : 'last switch:    none yet',
  );
  out(
    webhook
      ? `messages:       to Slack (${webhookHost(webhook)}), accounts ${config.autoSwitch.nameAccounts ? 'named' : 'not named'}${config.autoSwitch.label ? `, starting [${config.autoSwitch.label}]` : ''}`
      : 'messages:       off. Send a line per switch with: ccx autoswitch notify <Slack webhook address>',
  );
  out(`followers:      ${config.autoSwitch.followers.length > 0 ? config.autoSwitch.followers.join(', ') : 'none'}`);
  if (alsoProactive) {
    out('');
    out(
      `Sessions also move themselves early (rotation.proactivePercent is ${config.rotation.proactivePercent}). Two switchers with different rules undo each other; turn that off with: ccx proactive off`,
    );
  }
  return 0;
}

function stats(context: CliContext, options: AutoswitchOptions, now: number): number {
  const hours = Math.max(1, Math.min(48, Math.round(Number(options.hours) || 1)));
  const totals = readTotals(loadState(context.ctx).counts, hours, now);
  if (options.json || context.json) {
    context.out(JSON.stringify({ schemaVersion: 1, hours, counts: totals }));
    return 0;
  }
  const keys = Object.keys(totals).sort();
  if (keys.length === 0) {
    context.out(`no usage reads in the last ${hours}h.`);
    return 0;
  }
  context.out(`usage reads in the last ${hours}h, by kind and status (429 is the endpoint asking for fewer):`);
  const width = Math.max(...keys.map((k) => k.length));
  for (const key of keys) context.out(`  ${key.padEnd(width)}  ${totals[key]}`);
  return 0;
}

async function notify(context: CliContext, word: string | undefined, deps: AutoswitchDeps, now: number): Promise<number> {
  const { ctx } = context;
  const webhook = readWebhook(ctx);
  if (word === undefined) {
    context.out(
      webhook
        ? `a switch posts one line to Slack (${webhookHost(webhook)}). Try it: ccx autoswitch notify test. Stop: ccx autoswitch notify off`
        : 'no message is sent. Give a Slack incoming webhook: ccx autoswitch notify <address>  (or - to read it from standard input)',
    );
    return 0;
  }
  if (word === 'off') {
    clearWebhook(ctx);
    context.out('no message is sent on a switch any more; the address is removed.');
    return 0;
  }
  if (word === 'test') {
    if (!webhook) {
      context.out('there is no webhook to test. Give one: ccx autoswitch notify <address>');
      return 1;
    }
    const { label } = context.config.autoSwitch;
    const sent = await postToSlack(webhook, `${label ? `[${label}] ` : ''}ccx auto-switch: a test message; a switch will look like this`, deps.fetchImpl);
    context.out(sent.ok ? 'sent. It should be in the channel now.' : `it could not be sent (${sent.detail ?? 'no reason given'}).`);
    return sent.ok ? 0 : 1;
  }
  // `-` takes the address from standard input, which keeps it out of the
  // shell's history and out of the process list while this runs.
  const address = word === '-' ? (await (deps.readStdin ?? readAllStdin)()).trim() : word;
  saveWebhook(address, ctx);
  logLine(context, 'a Slack webhook was set for switch messages', now);
  // Never the address itself: anyone who has it can post to the channel.
  context.out(`saved. A switch now posts one line to Slack (${webhookHost(address)}). Try it: ccx autoswitch notify test`);
  return 0;
}

async function readAllStdin(): Promise<string> {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

/** Write one auto-switch setting on top of the file as it is, checked against the schema first. */
function saveAutoSwitch(context: CliContext, patch: NonNullable<PartialConfig['autoSwitch']>): void {
  const onDisk = loadConfigFile(context.ctx);
  const next: PartialConfig = { ...onDisk, autoSwitch: { ...onDisk.autoSwitch, ...patch } };
  const checked = ConfigSchema.safeParse(next);
  if (!checked.success) throw new CasError(checked.error.issues[0]?.message ?? 'not a usable value');
  saveConfig(next, context.ctx);
  reloadConfig(context);
}

function setLabel(context: CliContext, words: string[]): number {
  const text = words.join(' ').trim();
  if (text === '') {
    const { label } = context.config.autoSwitch;
    context.out(label ? `switch messages start with [${label}]. Clear it: ccx autoswitch label off` : 'switch messages carry no label. Set one: ccx autoswitch label <text>');
    return 0;
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new CasError('a label is one line of plain text');
  saveAutoSwitch(context, { label: /^off$/i.test(text) ? null : text });
  context.out(context.config.autoSwitch.label ? `switch messages now start with [${context.config.autoSwitch.label}].` : 'switch messages carry no label.');
  return 0;
}

function followers(context: CliContext, word: string | undefined, host: string | undefined): number {
  const current = context.config.autoSwitch.followers;
  if (word === undefined) {
    if (current.length === 0) {
      context.out('no machine follows this one. Add one: ccx autoswitch followers add <host>');
    } else {
      context.out('after a switch here, ccx on each of these is asked over SSH to make the same move:');
      for (const name of current) context.out(`  ${name}`);
    }
    return 0;
  }
  if ((word !== 'add' && word !== 'remove') || !host) {
    context.out('usage: ccx autoswitch followers [add|remove <host>]');
    return 1;
  }
  if (word === 'add') {
    assertSshHost(host);
    if (current.includes(host)) {
      context.out(`${host} follows this machine already.`);
      return 0;
    }
    saveAutoSwitch(context, { followers: [...current, host] });
    context.out(`${host} now follows this machine. It needs ccx, the same account names, and its own sign-in of each.`);
    context.out('  This machine must reach it over SSH without being asked for a password.');
    return 0;
  }
  if (!current.includes(host)) {
    context.out(`${host} was not following this machine.`);
    return 0;
  }
  saveAutoSwitch(context, { followers: current.filter((name) => name !== host) });
  context.out(`${host} no longer follows this machine.`);
  return 0;
}

function service(context: CliContext, deps: AutoswitchDeps): number {
  const platform = context.ctx.platform ?? process.platform;
  const home = (context.ctx.env ?? process.env).CLAUDE_AUTO_SWITCH_HOME;
  const guide = serviceGuide(platform, {
    node: deps.nodePath ?? process.execPath,
    cli: deps.cliPath ?? fileURLToPath(new URL('../cli.js', import.meta.url)),
    ...(home ? { home } : {}),
  });
  const out = context.out;
  if (guide.file === null || guide.contents === null) {
    out('Windows has no service file to write. Task Scheduler runs the watcher from sign-in:');
    for (const line of guide.start) out(`  ${line}`);
    if (home) out(`  (with CLAUDE_AUTO_SWITCH_HOME=${home} set for your user)`);
    out('To stop it:');
    for (const line of guide.stop) out(`  ${line}`);
    return 0;
  }
  out(`Save this as ${guide.file}:`);
  out('');
  out(guide.contents);
  out('Then start it, and keep it across restarts:');
  for (const line of guide.start) out(`  ${line}`);
  out('To stop it:');
  for (const line of guide.stop) out(`  ${line}`);
  if (guide.restart) {
    out('For a second machine to start it again if it ever stops, run this on that machine:');
    out(`  ccx autoswitch watchdog --host <this machine> --restart '${guide.restart}'`);
  }
  return 0;
}

async function watchdog(context: CliContext, options: AutoswitchOptions, deps: AutoswitchDeps): Promise<number> {
  const host = options.host;
  if (!host) {
    context.out('usage: ccx autoswitch watchdog --host <the machine the watcher runs on> [--restart <command>] [--once]');
    return 1;
  }
  assertSshHost(host);
  const now = deps.now ?? (() => Date.now());
  const remote: UnattendedOptions = options.remoteCcx ? { ccx: options.remoteCcx } : {};
  const ccx = deps.remoteCcx ?? runRemoteCcx;
  const shell = deps.remoteShell ?? ((target: string, command: string) => runRemote(target, command));
  const me = deps.hostname ?? os.hostname();
  const restart = options.restart;

  const pass = (): Promise<WatchdogReport> =>
    watchdogPass({
      host,
      now,
      facts: async () => parseFacts((await ccx(host, ['autoswitch', 'facts'], remote)).stdout),
      // A pass can read every account there; give it longer than a question.
      runPass: async () =>
        passInWords((await ccx(host, ['autoswitch', 'once', '--by', me], { ...remote, timeoutMs: 150_000 })).exitCode),
      restart: restart ? async () => (await shell(host, restart)).exitCode === 0 : null,
      loadState: () => loadWatchdogState(host, context.ctx),
      saveState: (state) => saveWatchdogState(host, state, context.ctx),
      log: (line) => logLine(context, line, now()),
      announce: (event) => announce(context, event, deps),
    });
  const tell = (report: WatchdogReport): void => {
    if (options.json || context.json) context.out(JSON.stringify({ schemaVersion: 1, ...report }));
    else context.out(`${report.host}: ${report.state} (${report.detail})${report.ranPass ? `; ran a pass there, ${report.ranPass}` : ''}`);
  };

  if (options.once) {
    const report = await pass();
    tell(report);
    return report.state === 'healthy' ? 0 : AUTOSWITCH_EXIT.nothingToDo;
  }

  const intervalMs = Math.max(30, Number(options.interval) || 60) * 1000;
  const signal = stopSignal(deps);
  const sleep = deps.sleep ?? sleepUntil;
  if (!context.quiet && !options.json && !context.json) {
    context.out(`watching the watcher on ${host}, a check every ${Math.round(intervalMs / 1000)}s (Ctrl-C to stop)`);
  }
  let said = '';
  while (!signal.aborted) {
    reloadConfig(context);
    try {
      const report = await pass();
      if (options.json || context.json || (!context.quiet && report.state !== said)) tell(report);
      said = report.state;
    } catch (err) {
      sayFailure(context, 'a watchdog check', err);
    }
    await sleep(intervalMs, signal);
  }
  return 0;
}

/**
 * How a pass run on another machine went, from its exit code alone. What it
 * printed names accounts, and those stay on the machine they belong to.
 */
function passInWords(exitCode: number): string {
  switch (exitCode) {
    case AUTOSWITCH_EXIT.switched:
      return 'it switched accounts';
    case AUTOSWITCH_EXIT.nothingToDo:
      return 'nothing to do';
    case AUTOSWITCH_EXIT.held:
      return 'a move was held back there';
    case COMMAND_NOT_FOUND:
      return 'ccx was not found there';
    case SSH_FAILED:
    case SSH_UNAVAILABLE:
      return 'it could not be reached';
    default:
      return 'the pass failed';
  }
}

/** What this machine's watcher says of itself, for a watchdog on another one. One line of JSON. */
function facts(context: CliContext, now: number): number {
  // Free means no pass holds it; taken and let go at once, it runs nothing.
  // Not taken only means a pass is running when the lock is really there: a
  // folder that cannot be written fails the same way, and calling that a pass
  // would keep a watchdog waiting on one for ever.
  let passRunning = false;
  try {
    const lock = passLock(context, 0);
    passRunning = !lock.held && existsSync(passLockPath(context.ctx));
    lock.release();
  } catch {
    /* no lock could be made: nothing is running under one */
  }
  // Only what a watchdog reads. Which account is active is no business of the machine asking.
  context.out(JSON.stringify({ beatAt: lastBeat(context.ctx), passRunning, now }));
  return 0;
}

/** Make the move another machine made, when this one was where that one was. */
function apply(context: CliContext, options: AutoswitchOptions, now: number): number {
  const { from, to } = options;
  const kind = MOVE_KINDS.find((k) => k === options.kind);
  if (!from || !to || !kind) {
    context.out('usage: ccx autoswitch apply --from <account> --to <account> --kind <kind> [--by <machine>]');
    return APPLY_EXIT.failed;
  }
  const { ctx } = context;
  const result = applyFollow(
    {
      active: () => getActive(ctx),
      account: (name) => {
        const account = getAccount(name, ctx);
        return account ? { loggedIn: hasWorkingLogin(account.dir, ctx) } : null;
      },
      controls: () => readControls(ctx),
      handPick: () => standingPick(readHandPick(ctx), from, activeSince(ctx) ?? now),
      // A person may be switching here at this very moment: wait a little for them.
      switchTo: (leaving, next, reason) => switchUnderLock(context, leaving, next, reason, { now, waitMs: 5_000 }),
    },
    { from, to, kind, by: options.by ?? 'another machine' },
  );
  context.out(result.said);
  return result.exit;
}
