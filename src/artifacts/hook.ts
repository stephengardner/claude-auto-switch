import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listAccounts } from '../accounts/registry.js';
import type { Account } from '../accounts/registry.schema.js';
import { resolveSessionIdentity } from '../session/session-identity.js';
import { loadConfig } from '../config/config.js';
import type { PathCtx } from '../config/paths.js';
import type { LeaseOptions } from '../session/lease.js';
import { sessionLease } from '../session/session-lease.js';
import {
  awaySince,
  hopDir,
  hopId,
  hopsOpen,
  markDone,
  NOTE_PREFIX,
  readState,
  writeAsk,
  type HopState,
} from './hop-files.js';
import { appendPage, findPage, pageKey, readPages, recordDeletion } from './record.js';
import { decideRoute, readCall, routingOn, type RoutingSettings } from './route.js';
import { claimTurn, listedPages, turnOf, writeResult } from './scan.js';

/**
 * What ccx's hooks on Claude's Artifact tool do, in a ccx session with page
 * routing on.
 *
 * Before a call: work out which account it belongs on, and ask the ccx process
 * that owns the session to hold the session there for the length of the call,
 * moving it first when it is elsewhere. The call goes ahead only once that
 * process says it holds it there; otherwise it is refused with the reason, so
 * a page never lands on the wrong account in silence. After a call, and after
 * each batch of calls: say they are over, wait until the session is back, and
 * write down which account a published page went out as, or that a page was
 * deleted.
 *
 * The hook moves no login and reads none. It never approves a call either:
 * with nothing to refuse it says nothing, and Claude asks the person whatever
 * it would have asked.
 */

export interface HookInput {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_use_id?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  tool_response?: unknown;
  /** How long the tool itself ran, without the time a question to the person or a hook took. */
  duration_ms?: unknown;
  /** After a failure: what went wrong. */
  error?: unknown;
  /** After a batch: every call in it, refused ones included. */
  tool_calls?: unknown;
}

export interface HookEnv {
  /** The session's folder: `CLAUDE_CONFIG_DIR` as the hook inherited it. */
  sessionDir: string;
  ctx: PathCtx;
  now?: () => number;
  /** How long the hook waits for the session to be held, and to be put back. */
  applyWaitMs?: number;
  returnWaitMs?: number;
  pollMs?: number;
  leaseOptions?: LeaseOptions;
  /** Set in the one Claude `ccx artifacts scan` runs: the scan's folder (see scan.ts). */
  scanDir?: string | null;
}

/** What the hook tells Claude: refuse the call, add a word for the model, or nothing. */
export type HookAnswer = { deny: string } | { context: string } | null;

/**
 * Both under the timeouts the hooks are installed with (hooks.ts): a hook
 * Claude gives up on does not stop the call. The first covers renewing a
 * login that was due, which asks the network.
 */
export const APPLY_WAIT_MS = 25_000;
export const RETURN_WAIT_MS = 15_000;
/** How far back a call is taken to have begun, past what Claude says the tool ran for. */
const START_MARGIN_MS = 2_000;
/** Taken as the tool's running time when Claude gives none. */
const UNKNOWN_DURATION_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const word = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

function settingsOf(ctx: PathCtx): RoutingSettings {
  return loadConfig(ctx).artifacts;
}

/** The accounts, or none when the registry cannot be read: then nobody can be named for certain. */
function readAccounts(ctx: PathCtx): Account[] {
  try {
    return listAccounts(ctx);
  } catch {
    return [];
  }
}

async function waitForState(
  env: HookEnv,
  id: string,
  ready: (state: HopState | null) => boolean,
  waitMs: number,
): Promise<HopState | null> {
  const now = env.now ?? (() => Date.now());
  const deadline = now() + waitMs;
  for (;;) {
    const state = readState(env.sessionDir, id);
    if (ready(state) || now() >= deadline) return state;
    await sleep(env.pollMs ?? 25);
  }
}

/**
 * The account a session is really signed in as: the one ccx announced for it,
 * unless somebody signed in as another from inside it (/login), which the
 * session's own folder says. Null when that is no account ccx knows.
 */
function signedInAs(env: HookEnv, announced: string, accounts: Account[]): string | null {
  const identity = resolveSessionIdentity({
    sessionDir: env.sessionDir,
    believed: accounts.find((a) => a.name === announced) ?? null,
    accounts,
  });
  return identity.mismatch ? (identity.actual?.name ?? null) : announced;
}

/**
 * True the first time `mark` is asked for in this session. The mark is a
 * file in the session's folder: a note (NOTE_PREFIX) is kept for the
 * session's life, anything else for ten minutes.
 */
function firstTime(env: HookEnv, mark: string): boolean {
  try {
    mkdirSync(hopDir(env.sessionDir), { recursive: true });
    writeFileSync(path.join(hopDir(env.sessionDir), mark), '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Have the session held on `to` for this call. Null once it is, and otherwise
 * why not, in words for whoever made the call: nothing was sent.
 */
async function visit(input: HookInput, env: HookEnv, to: string): Promise<string | null> {
  const now = env.now ?? (() => Date.now());
  if (!hopsOpen(env.sessionDir)) {
    return (
      `ccx: this call belongs on "${to}", and this session was started by a ccx from before it could ` +
      'hold it there for one call, so nothing was sent. Ask the person to quit this session and start it ' +
      'again (claude --resume picks the conversation up).'
    );
  }
  const id = hopId(input.tool_use_id) ?? `call-${randomUUID()}`;
  const transcript = word(input.transcript_path);
  let transcriptFrom: number | null = null;
  if (transcript && existsSync(transcript)) {
    try {
      transcriptFrom = statSync(transcript).size;
    } catch {
      transcriptFrom = null;
    }
  }
  writeAsk(env.sessionDir, {
    id,
    to,
    at: now(),
    transcript: transcriptFrom === null ? null : transcript,
    transcriptFrom,
  });
  const waitMs = env.applyWaitMs ?? APPLY_WAIT_MS;
  const state = await waitForState(env, id, (s) => s !== null, waitMs);
  if (state?.state === 'applied') return null;
  if (state?.state === 'refused') return `ccx: ${state.reason}`;
  // Not answered. Left as given up on, so a hold made late is undone at once.
  markDone(env.sessionDir, id);
  return (
    `ccx: this call belongs on "${to}", and the session was not held there within ` +
    `${Math.round(waitMs / 1000)} seconds, so nothing was sent. Try the call again.`
  );
}

export async function beforeArtifactCall(input: HookInput, env: HookEnv): Promise<HookAnswer> {
  if (input.tool_name !== 'Artifact') return null;
  if (env.scanDir) return beforeScanCall(input, env, env.scanDir);
  // The announcement is written best effort. A ccx that answers requests is
  // the one that knows the account, so its session is routed without one.
  const lease = sessionLease(env.sessionDir, env.ctx, env.leaseOptions);
  if (!lease && !hopsOpen(env.sessionDir)) return null;
  const call = readCall(input.tool_input, word(input.cwd));
  if (call.kind === 'other') return null;

  let settings: RoutingSettings;
  try {
    settings = settingsOf(env.ctx);
  } catch (error) {
    // Whether this call is routed is in that file, and the hooks are only there while it was.
    return {
      deny:
        `ccx: its config.json does not load (${(error as Error).message.split('\n')[0]}), so it cannot tell which ` +
        'account this call belongs on, and nothing was sent. Ask the person to run: ccx doctor',
    };
  }
  if (!routingOn(settings)) return null;

  try {
    const accounts = listAccounts(env.ctx);
    const route = decideRoute({
      call,
      settings,
      sessionId: word(input.session_id),
      pages: readPages(env.ctx),
      registered: (name) => accounts.some((a) => a.name === name),
    });
    if (route.kind === 'none') return null;
    if (route.kind === 'refuse') return { deny: `ccx: ${route.reason}` };
    if (route.kind === 'unknown-owner') {
      if (!firstTime(env, `${NOTE_PREFIX}${pageKey(route.url) ?? 'page'}`)) return null;
      const account = lease ? (signedInAs(env, lease.account, accounts) ?? lease.account) : null;
      return {
        context:
          `ccx: nothing records which account owns ${route.url}, so this call goes out as ` +
          `${account === null ? '' : `"${account}", `}the account this session is on, and fails if the page ` +
          'belongs to another one. "ccx artifacts scan" records the owner of every existing page.',
      };
    }
    const refused = await visit(input, env, route.to);
    return refused === null ? null : { deny: refused };
  } catch (error) {
    return {
      deny: `ccx could not work out which account this call belongs on (${(error as Error).message}), so nothing was sent.`,
    };
  }
}

/** Say this call is over, and wait for the session to be back if it held it. The state as the call ended. */
async function releaseCall(env: HookEnv, id: string | null): Promise<HopState | null> {
  // Read first: whether the session was held for the call when it ended.
  const state = id ? readState(env.sessionDir, id) : null;
  if (id && state?.state === 'applied') {
    // Whatever the settings say now: a hold that was made is always released.
    markDone(env.sessionDir, id);
    await waitForState(env, id, (s) => s?.state === 'ended', env.returnWaitMs ?? RETURN_WAIT_MS);
  }
  return state;
}

export async function afterArtifactCall(input: HookInput, env: HookEnv, failed: boolean): Promise<HookAnswer> {
  if (input.tool_name !== 'Artifact') return null;
  const now = env.now ?? (() => Date.now());
  const id = hopId(input.tool_use_id);
  const state = await releaseCall(env, id);
  const heldTo = state?.state === 'applied' ? state.to : null;
  const moved = state?.state === 'applied' && state.moved;

  const call = readCall(input.tool_input, word(input.cwd));
  if (env.scanDir) {
    afterScanCall(input, env, env.scanDir, heldTo, failed);
    return null;
  }
  if (failed) {
    if (!moved || call.kind !== 'publish' || call.url !== null) return null;
    return {
      context:
        `ccx: this call was sent as "${heldTo}". If it was meant to update a page that exists, ` +
        'pass that page\'s url, so ccx can tell it from a new page.',
    };
  }

  let settings: RoutingSettings;
  try {
    settings = settingsOf(env.ctx);
  } catch {
    return null;
  }
  if (!routingOn(settings)) return null;
  const lease = sessionLease(env.sessionDir, env.ctx, env.leaseOptions);
  // A call the session's ccx held is that session's, announced or not.
  if (!lease && heldTo === null) return null;
  // Once per call, when the hook is installed in two places and so runs twice.
  if (id && !firstTime(env, `once-${id}`)) return null;

  if (call.kind === 'delete') {
    if (call.url) recordDeletion(call.url, env.ctx, now());
    return null;
  }
  if (call.kind !== 'publish') return null;
  const response =
    typeof input.tool_response === 'object' && input.tool_response !== null
      ? (input.tool_response as Record<string, unknown>)
      : {};
  const url = word(response.url);
  if (pageKey(url) === null) return null;

  let owner: string | null;
  if (heldTo !== null) {
    owner = heldTo;
  } else {
    // Nothing held it: the account the session is on, unless it was somewhere
    // else for any part of the call, when nothing here can say which one sent it.
    const ran = typeof input.duration_ms === 'number' && input.duration_ms >= 0 ? input.duration_ms : UNKNOWN_DURATION_MS;
    owner =
      !lease || awaySince(env.sessionDir, now() - ran - START_MARGIN_MS)
        ? null
        : signedInAs(env, lease.account, readAccounts(env.ctx));
  }
  appendPage(
    {
      url: url as string,
      id: word(response.artifact_id),
      title: word(response.title),
      owner,
      session: word(input.session_id),
      file: call.file,
      at: now(),
      via: 'publish',
    },
    env.ctx,
  );

  // The call was to go out as another account, and did not.
  const meantFor = state && state.state !== 'refused' && state.to !== owner ? state.to : null;
  if (meantFor === null) return null;
  return {
    context:
      owner === null
        ? `ccx: this page was meant to go out as "${meantFor}", and the session's hold there ended while the call ` +
          'was running, so ccx cannot tell which account published it. "ccx artifacts scan" finds out.'
        : `ccx: this page was meant to go out as "${meantFor}", but the session's hold there had ended before the ` +
          `call was sent (a hold lasts two minutes at most), so it was published as "${owner}". ` +
          `Publish it again as a new page to put it on "${meantFor}".`,
  };
}

/**
 * After every batch of tool calls, before Claude's next model request: end the
 * holds of this batch's Artifact calls, and wait for the session to be back. A
 * call refused after the session was moved (by the person's own hook, a
 * permission rule, plan mode) runs no after-hook of its own, and this is what
 * keeps the next request from going out on the account it was moved to.
 */
export async function batchArtifactCalls(input: HookInput, env: HookEnv): Promise<HookAnswer> {
  const calls = Array.isArray(input.tool_calls) ? (input.tool_calls as unknown[]) : [];
  const ids = calls
    .filter((c) => (c as { tool_name?: unknown } | null)?.tool_name === 'Artifact')
    .map((c) => hopId((c as { tool_use_id?: unknown }).tool_use_id))
    .filter((id): id is string => id !== null);
  await Promise.all(ids.map((id) => releaseCall(env, id)));
  return null;
}

/**
 * In the scan's own Claude: each `list` is given the next account to be
 * listed, and the session is held there for it. Whatever the page settings
 * say, since the scan is how owners get recorded before they are turned on.
 */
async function beforeScanCall(input: HookInput, env: HookEnv, scanDir: string): Promise<HookAnswer> {
  if (!sessionLease(env.sessionDir, env.ctx, env.leaseOptions) && !hopsOpen(env.sessionDir)) return null;
  if (readCall(input.tool_input, word(input.cwd)).action !== 'list') {
    return { deny: 'ccx: this session only lists pages, for ccx artifacts scan. No other Artifact action is allowed in it.' };
  }
  const id = hopId(input.tool_use_id);
  let turn: Awaited<ReturnType<typeof claimTurn>>;
  try {
    turn = id === null ? 'no-answer' : await claimTurn(scanDir, id);
  } catch {
    // A hook that fails says nothing, and the call would list whichever account the session is on.
    turn = 'no-answer';
  }
  if (turn === 'none-left') {
    return { deny: 'ccx: every account has been listed. Make no more calls, and reply with only: done' };
  }
  if (turn === 'no-answer') {
    return { deny: 'ccx: this call could not be given an account to list. Go on to the next call.' };
  }
  let refused: string | null;
  try {
    refused = await visit(input, env, turn.account);
  } catch (error) {
    refused = `ccx: "${turn.account}" could not be listed (${(error as Error).message}).`;
  }
  if (refused === null) return null;
  writeResult(scanDir, turn.index, { account: turn.account, error: refused.replace(/^ccx: /, '') });
  return { deny: `${refused} Go on to the next call.` };
}

/** Write down the pages one account listed, as that account's, when it is certain the account answered. */
function afterScanCall(input: HookInput, env: HookEnv, scanDir: string, heldTo: string | null, failed: boolean): void {
  const now = env.now ?? (() => Date.now());
  const id = hopId(input.tool_use_id);
  const turn = id === null ? null : turnOf(scanDir, id);
  if (turn === null) return;
  if (failed) {
    writeResult(scanDir, turn.index, { account: turn.account, error: word(input.error) ?? 'the list call failed' });
    return;
  }
  const lease = sessionLease(env.sessionDir, env.ctx, env.leaseOptions);
  const ran = typeof input.duration_ms === 'number' && input.duration_ms >= 0 ? input.duration_ms : UNKNOWN_DURATION_MS;
  const answeredBy =
    heldTo ??
    (lease && !awaySince(env.sessionDir, now() - ran - START_MARGIN_MS)
      ? signedInAs(env, lease.account, readAccounts(env.ctx))
      : null);
  const listed = listedPages(input.tool_response);
  if (!firstTime(env, `once-${id as string}`)) return;
  if (answeredBy !== turn.account || listed === null) {
    writeResult(scanDir, turn.index, {
      account: turn.account,
      error: listed === null ? 'the answer was not a list of pages' : 'ccx could not tell which account answered',
    });
    return;
  }
  const known = readPages(env.ctx);
  for (const page of listed.pages) {
    // Already recorded as this account's, under this title: a second scan adds nothing.
    const recorded = findPage(known, page.url);
    if (recorded && recorded.owner === turn.account && recorded.title === page.title) continue;
    appendPage(
      { url: page.url, id: null, title: page.title, owner: turn.account, session: null, file: null, at: now(), via: 'scan' },
      env.ctx,
    );
  }
  writeResult(scanDir, turn.index, { account: turn.account, listed: listed.pages.length, total: listed.total });
}
