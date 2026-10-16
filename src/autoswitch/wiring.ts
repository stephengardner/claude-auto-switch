import os from 'node:os';
import path from 'node:path';
import { getAccount, listAccounts } from '../accounts/registry.js';
import { hasWorkingLogin } from '../accounts/account-login.js';
import { CREDENTIALS_FILE } from '../accounts/credential-storage.js';
import { loadConfig } from '../config/config.js';
import { configHome } from '../config/paths.js';
import type { CliContext } from '../context.js';
import { numberSessions } from '../dashboard/session-choice.js';
import { syncEditorPointerIfEnabled } from '../editor/junction.js';
import { appendEvent } from '../events/log.js';
import { cappedNames, cappedSince, loadLedger } from '../ledger/ledger.js';
import type { RemoteResult } from '../remote/ssh.js';
import { orderComparator } from '../selector/selector.js';
import { liveLeases } from '../session/lease.js';
import { activeSince, getActive, setActive } from '../state/active.js';
import { clearHandPick, readHandPick } from '../state/hand-pick.js';
import { requestMoves } from '../state/switch-request.js';
import { withSwitchLock } from '../state/switch-lock.js';
import { preferredModel, roomOfFromSnapshot } from '../usage/account-room.js';
import type { UsageLike } from '../usage/headroom.js';
import { probeUsage, type LimitProbeResult } from '../usage/limit-probe.js';
import { toUsageLike } from '../usage/proactive-deps.js';
import { readExpiresAt } from '../usage/token-expiry.js';
import { recordUsageReading, refreshUsage, usageCredentialDir } from '../usage/usage-store.js';
import { MINUTE } from './decide.js';
import { tellFollowers } from './followers.js';
import { eventMessage, postToSlack, readWebhook, type WatchdogEvent } from './notify.js';
import type { PassDeps, SwitchOutcome, WatchAccount, WatchEvent } from './pass.js';
import { readOutcome } from './reads.js';
import { runRemoteCcx } from './remote.js';
import { loadState, readControls, saveState } from './state.js';
import type { TargetCandidate } from './target.js';

/**
 * The watcher's pass, joined to the real ccx: its accounts, its usage reads,
 * its ledger, and the same switch a hand-made `ccx use` makes.
 */

/** What the watcher's lines are filed under in `ccx history`. */
export const EVENT_KIND = 'auto-switch';

/** One line in ccx's history, said by the watcher. */
export function logLine(context: CliContext, line: string, now: number = Date.now()): void {
  appendEvent(configHome(context.ctx), `auto-switch: ${line}`, now, { kind: EVENT_KIND });
}

/**
 * Switch the active account, under the switch lock, only if `from` is still
 * the account in use: the same three steps as `ccx auto`, made safe against a
 * pick that landed a moment before.
 *
 * Every running session on the account being left is asked to move by a
 * request of its own, in place, so its conversation and whatever it has
 * running carry on. A session somebody moved to another account stays there.
 */
export function switchUnderLock(
  context: CliContext,
  from: string,
  to: string,
  reason: string,
  options: { now: number; waitMs: number },
): SwitchOutcome {
  const { ctx } = context;
  return withSwitchLock(ctx, { waitMs: options.waitMs }, (held): SwitchOutcome => {
    if (!held) return { code: 'busy' };
    const active = getActive(ctx);
    if (active !== from) return { code: 'changed', active };
    if (!getAccount(to, ctx)) return { code: 'failed', why: `no account "${to}"` };
    try {
      setActive(to, ctx);
      syncEditorPointerIfEnabled(context);
      const leaving = numberSessions(liveLeases(ctx)).filter((s) => s.account === from);
      const moving = requestMoves(to, leaving, 'seamless', ctx, options.now);
      appendEvent(configHome(ctx), `auto-switch to ${to} (${reason})`, options.now, {
        kind: EVENT_KIND,
        data: { from, to, reason, sessions: moving.length },
      });
      return { code: 'done', sessions: moving.length };
    } catch (err) {
      return { code: 'failed', why: (err as Error).message };
    }
  });
}

/** The accounts as the watcher weighs them, read fresh. */
export function watchAccounts(context: CliContext, now: number): WatchAccount[] {
  const capped = cappedNames(loadLedger(context.ctx), now);
  return listAccounts(context.ctx).map((a) => ({
    name: a.name,
    dir: a.dir,
    ...(a.email ? { email: a.email } : {}),
    priority: a.priority,
    enabled: a.enabled,
    loggedIn: hasWorkingLogin(a.dir, context.ctx),
    capped: capped.has(a.name),
  }));
}

export interface WiringOptions {
  /** Decide by this model's own week alone, beside the account-wide windows. */
  model?: string;
  now?: () => number;
  /** Injected in tests: stands in for the usage endpoint. */
  probe?: (credentialsFile: string) => Promise<LimitProbeResult>;
  /** Injected in tests: the pause between accounts when ccx refreshes what it knows of them all. */
  usageGapMs?: number;
  /** Injected in tests: stands in for Slack. */
  fetchImpl?: typeof fetch;
  /** Injected in tests: stands in for ssh to a machine that follows. */
  runRemote?: (host: string, args: string[]) => Promise<RemoteResult>;
  /** This machine's name, as the machines that follow it record it. */
  hostname?: string;
}

/**
 * Send one line to the webhook, when there is one. A message that cannot be
 * sent is a line in the history; it never reaches the caller as a failure.
 */
export async function announce(
  context: CliContext,
  event: WatchEvent | WatchdogEvent,
  options: Pick<WiringOptions, 'now' | 'fetchImpl'> = {},
): Promise<void> {
  const webhook = readWebhook(context.ctx);
  if (!webhook) return;
  const now = (options.now ?? (() => Date.now()))();
  const { label, nameAccounts } = context.config.autoSwitch;
  const sent = await postToSlack(webhook, eventMessage(event, { label, nameAccounts }, now), options.fetchImpl);
  if (!sent.ok) logLine(context, `the message could not be sent (${sent.detail ?? 'no reason given'})`, now);
}

/**
 * The settings as they are on disk now. A watcher runs for days, and a
 * setting changed meanwhile has to reach its next pass. A file caught half
 * edited, or one that no longer loads, leaves the settings as they were.
 */
export function reloadConfig(context: CliContext): void {
  try {
    Object.assign(context.config, loadConfig(context.ctx));
  } catch {
    /* keep deciding on the settings already held */
  }
}

export function buildPassDeps(context: CliContext, options: WiringOptions = {}): PassDeps {
  const { ctx } = context;
  const now = options.now ?? (() => Date.now());
  const probe = options.probe ?? ((file: string) => probeUsage(file));
  const hostname = options.hostname ?? os.hostname();

  /**
   * The login that answers for an account: a running session's copy when one
   * is on it, since that is the copy Claude keeps renewed, else the profile's.
   */
  const credentialsFile = (account: WatchAccount): string => {
    const lease = liveLeases(ctx).find((l) => l.account === account.name);
    return path.join(usageCredentialDir(account, lease?.configDir), CREDENTIALS_FILE);
  };

  return {
    now,
    accounts: () => watchAccounts(context, now()),
    active: () => getActive(ctx),
    activeSince: () => activeSince(ctx),
    handPick: () => readHandPick(ctx),
    clearHandPick: () => clearHandPick(ctx),
    cappedSince: (name) => cappedSince(loadLedger(ctx), name, now()),
    // Read only: the watcher never renews a login, so it can never end one a
    // session is using. An expired token simply does not answer.
    read: async (account) => {
      try {
        return readOutcome(await probe(credentialsFile(account)));
      } catch {
        return { ok: false, status: 'unknown' };
      }
    },
    tokenLive: (account) => readExpiresAt(credentialsFile(account)) > now() + MINUTE,
    record: (name, result, at) => {
      recordUsageReading(name, result, ctx, at);
    },
    usage: async () => {
      const snapshot = await refreshUsage(listAccounts(ctx), ctx, {
        probe,
        ...(options.usageGapMs !== undefined ? { gapMs: options.usageGapMs } : {}),
      });
      const usage = new Map<string, UsageLike>();
      for (const [name, entry] of Object.entries(snapshot.accounts)) usage.set(name, toUsageLike(entry));
      return usage;
    },
    order: () => {
      const { rotation } = context.config;
      const roomOf = roomOfFromSnapshot(ctx, now(), rotation, options.model ?? preferredModel(context));
      return orderComparator<TargetCandidate>(rotation.accountOrder, roomOf);
    },
    switchTo: (from, to, reason) => switchUnderLock(context, from, to, reason, { now: now(), waitMs: 0 }),
    controls: () => readControls(ctx),
    settings: () => ({
      threshold: context.config.autoSwitch.thresholdPercent / 100,
      hysteresis: context.config.autoSwitch.hysteresisPercent / 100,
      ...(options.model ? { model: options.model } : {}),
    }),
    loadState: () => loadState(ctx),
    saveState: (state) => saveState(state, ctx),
    log: (line) => logLine(context, line, now()),
    announce: (event) => announce(context, event, options),
    follow: async (from, to, kind, only) => {
      // A machine taken off the list since the switch is not asked again.
      const listed = context.config.autoSwitch.followers;
      const hosts = only ? listed.filter((host) => only.includes(host)) : listed;
      if (hosts.length === 0) return [];
      const run = options.runRemote ?? ((host: string, args: string[]) => runRemoteCcx(host, args));
      const outcomes = await tellFollowers(hosts, { from, to, kind, by: hostname }, run);
      // Said the first time it is asked; asking again says only when it works.
      if (!only) {
        for (const outcome of outcomes) {
          if (!outcome.ok) {
            logLine(context, `${outcome.host} did not follow: ${outcome.detail}${outcome.retry ? '; asking again for ten minutes' : ''}`, now());
          }
        }
      }
      return outcomes;
    },
  };
}
