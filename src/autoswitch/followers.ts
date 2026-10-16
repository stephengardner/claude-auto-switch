import { COMMAND_NOT_FOUND, SSH_FAILED, SSH_UNAVAILABLE, type RemoteResult } from '../remote/ssh.js';
import { handPickHolds, isEarly, type HandPick, type MoveKind } from './decide.js';
import type { FollowOutcome, SwitchOutcome } from './pass.js';
import { lastLine } from './remote.js';
import type { Controls } from './state.js';

/**
 * Machines that follow a switch.
 *
 * The watcher runs on one machine. After it switches, each machine listed in
 * `autoSwitch.followers` is asked, over SSH, to make the same move with its own
 * ccx: from the account that was left to the account that was taken, by name.
 *
 * By name, never by copying a login. Each machine holds its own login of each
 * account, because a refresh token can be used once: a login copied between
 * machines ends whichever copy renews second.
 *
 * A follower keeps its own say. It follows only when it is still on the
 * account being left, and a pick or a pause made on that machine holds there
 * exactly as it would against a watcher of its own.
 */

/** What `ccx autoswitch apply` exits with on the machine that follows. */
export const APPLY_EXIT = {
  followed: 0,
  failed: 1,
  /** It was on another account, or something there holds the move: not an error. */
  leftAlone: 3,
  /** Somebody there was switching at that moment. Asking again shortly will do. */
  busy: 4,
} as const;

export interface FollowRequest {
  from: string;
  to: string;
  kind: MoveKind;
  /** The machine asking, for the follower's own history. */
  by: string;
}

/** The arguments `ccx autoswitch apply` takes, as the watcher sends them. */
export function applyArgs(request: FollowRequest): string[] {
  return ['autoswitch', 'apply', '--from', request.from, '--to', request.to, '--kind', request.kind, '--by', request.by];
}

/**
 * Ask every follower at once, and say how each took it. One that cannot be
 * reached, or refuses, is a line in the answer: it never fails the others, or
 * the switch already made here.
 */
export async function tellFollowers(
  hosts: readonly string[],
  request: FollowRequest,
  run: (host: string, args: string[]) => Promise<RemoteResult>,
): Promise<FollowOutcome[]> {
  return Promise.all(
    hosts.map(async (host): Promise<FollowOutcome> => {
      try {
        const result = await run(host, applyArgs(request));
        // Unreachable or mid-switch may be different a minute from now; every other answer is final.
        const retry = result.exitCode === SSH_FAILED || result.exitCode === APPLY_EXIT.busy;
        return {
          host,
          ok: result.exitCode === APPLY_EXIT.followed,
          detail: howItWent(result),
          ...(retry ? { retry: true } : {}),
        };
      } catch (err) {
        // A host ssh cannot be given safely is refused before anything runs.
        return { host, ok: false, detail: (err as Error).message };
      }
    }),
  );
}

function howItWent(result: RemoteResult): string {
  const said = lastLine(result.stdout);
  switch (result.exitCode) {
    case APPLY_EXIT.followed:
      return said || 'followed';
    case APPLY_EXIT.leftAlone:
      return said || 'left as it was';
    case APPLY_EXIT.busy:
      return said || 'another switch was in progress there';
    case SSH_UNAVAILABLE:
      return 'ssh could not be started here';
    case SSH_FAILED:
      return `could not reach it${lastLine(result.stderr) ? ` (${lastLine(result.stderr)})` : ''}`;
    case COMMAND_NOT_FOUND:
      return 'ccx was not found there';
    default:
      return said || lastLine(result.stderr) || `ccx there exited ${result.exitCode}`;
  }
}

export interface ApplyDeps {
  active: () => string | null;
  /** Whether `name` is registered here, and signed in. */
  account: (name: string) => { loggedIn: boolean } | null;
  controls: () => Controls;
  handPick: () => HandPick | null;
  /** The same switch the watcher makes: under the lock, only if `from` is still in use. */
  switchTo: (from: string, to: string, reason: string) => SwitchOutcome;
}

export interface ApplyResult {
  exit: (typeof APPLY_EXIT)[keyof typeof APPLY_EXIT];
  said: string;
}

/** What the machine that follows does with a request. */
export function applyFollow(deps: ApplyDeps, request: FollowRequest): ApplyResult {
  const { from, to, kind } = request;
  const active = deps.active();
  if (active === to) return { exit: APPLY_EXIT.followed, said: `already on ${to}` };
  if (active !== from) {
    // Someone here picked another account, or a session moved on by itself.
    // Either way this machine is not where the other one was.
    return { exit: APPLY_EXIT.leftAlone, said: `on ${active ?? 'no account'}, not ${from}; left as it is` };
  }
  const controls = deps.controls();
  if (controls.paused !== null) {
    return { exit: APPLY_EXIT.leftAlone, said: `switching is paused here (${controls.paused}); not followed` };
  }
  if (handPickHolds(deps.handPick(), active, kind)) {
    return { exit: APPLY_EXIT.leftAlone, said: `${from} was picked by hand here, which holds against an early move; not followed` };
  }
  if (isEarly(kind) && controls.earlyOff) {
    return { exit: APPLY_EXIT.leftAlone, said: 'early moves are off here; not followed' };
  }
  const target = deps.account(to);
  if (!target) return { exit: APPLY_EXIT.failed, said: `no account "${to}" here; add it with: ccx add ${to}` };
  if (!target.loggedIn) return { exit: APPLY_EXIT.failed, said: `"${to}" is not signed in here; sign it in with: ccx login ${to}` };

  const outcome = deps.switchTo(from, to, `followed ${request.by} (${kind})`);
  switch (outcome.code) {
    case 'done':
      return { exit: APPLY_EXIT.followed, said: `now on ${to}; ${outcome.sessions} running session${outcome.sessions === 1 ? '' : 's'} asked to follow` };
    case 'busy':
      return { exit: APPLY_EXIT.busy, said: 'another switch was in progress here; not followed yet' };
    case 'changed':
      return { exit: APPLY_EXIT.leftAlone, said: `on ${outcome.active ?? 'no account'}, not ${from}; left as it is` };
    default:
      return { exit: APPLY_EXIT.failed, said: outcome.why };
  }
}
