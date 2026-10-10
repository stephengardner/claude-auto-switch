import path from 'node:path';
import { findPage, findRepublished, type Page } from './record.js';

/**
 * Which account one call of Claude's Artifact tool should go out as. Pure: the
 * hook reads the call, the settings, the session and the record, and this
 * decides.
 *
 * What is routed, and why only these:
 * - a publish of a new page, to the home account;
 * - a publish to a page that exists (named by its link, or by this
 *   conversation publishing the same file again, or an upload to it), to the
 *   account that owns it, which is the only one that can change it;
 * - a read of a recorded page, to its owner: Claude reads a page before it
 *   updates one from another conversation, and a private page reads as
 *   missing to everyone else.
 * Listing, deleting, opening, pinning and the rest are left exactly as they
 * are: they are about the account the session is on, or ask the person first,
 * and a move held open across a question could outlast its bound.
 */

/** The part of a call that decides where it goes. */
export interface ArtifactCall {
  /** `publish` when the call names none, which most do not. */
  action: string;
  /** The page the call names, when it names one. */
  url: string | null;
  /** The file it publishes, absolute. */
  file: string | null;
}

export interface RoutingSettings {
  home: string | null;
  updates: 'off' | 'owner';
}

export interface RouteInput {
  call: ArtifactCall;
  settings: RoutingSettings;
  /** The account the session is on now. */
  sessionAccount: string;
  /** The conversation making the call. */
  sessionId: string | null;
  pages: readonly Page[];
  /**
   * Whether ccx has an account by this name. Whether it is signed in is asked
   * later, by the ccx process that would make the move: it reads logins, and
   * the hook does not.
   */
  registered: (name: string) => boolean;
}

export type Route =
  /** Nothing is configured for this call: it is not touched in any way. */
  | { kind: 'none' }
  /** It belongs on the account the session is already on. */
  | { kind: 'stay'; account: string; why: 'home' | 'owner' }
  /** The session is moved to `to` for the length of the call. */
  | { kind: 'hop'; to: string; why: 'home' | 'owner'; page: Page | null }
  /** An update to a page nobody recorded the owner of: sent as it is, with a word on how to record owners. */
  | { kind: 'unknown-owner'; url: string }
  /** The route cannot be honoured, and the call must not go out anywhere else. */
  | { kind: 'refuse'; reason: string };

/** Whether either setting is on. With both off ccx does nothing here at all. */
export function routingOn(settings: RoutingSettings): boolean {
  return settings.home !== null || settings.updates === 'owner';
}

const word = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/** The call in a hook's `tool_input`. A relative file is Claude's, so it is resolved against Claude's folder. */
export function readCall(toolInput: unknown, cwd: string | null): ArtifactCall {
  const input = typeof toolInput === 'object' && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
  const file = word(input.file_path);
  return {
    action: word(input.action) ?? 'publish',
    url: word(input.url),
    file: file === null ? null : path.resolve(cwd ?? '', file),
  };
}

function notAnAccount(why: 'home' | 'owner', account: string): string {
  return why === 'home'
    ? `new pages are published as "${account}" (the setting artifacts.home), and ccx has no account called ` +
        `"${account}", so the page was not published. Ask the person to run: ccx config artifacts.home <account> ` +
        '(ccx list names them), or ccx config artifacts.home off'
    : `this page belongs to "${account}", and only that account can change or read it, but ccx has no account ` +
        `called "${account}" any more, so the call was not sent. Ask the person to add that account again (ccx add), ` +
        'or to run: ccx artifacts scan';
}

export function decideRoute(input: RouteInput): Route {
  const { call, settings, sessionAccount } = input;
  if (!routingOn(settings)) return { kind: 'none' };
  if (call.action !== 'publish' && call.action !== 'read') return { kind: 'none' };

  let target: { account: string; why: 'home' | 'owner'; page: Page | null };
  if (call.action === 'read' || call.url !== null) {
    const page = findPage(input.pages, call.url);
    const sent = existingPage(settings, page);
    if (sent === 'leave') return { kind: 'none' };
    if (sent === 'unknown') {
      // A page nothing is recorded about may be somebody else's, shared to
      // read: only a publish to one is worth a word.
      return call.action === 'publish' && call.url !== null ? { kind: 'unknown-owner', url: call.url } : { kind: 'none' };
    }
    target = { ...sent, page };
  } else {
    const page = findRepublished(input.pages, input.sessionId, call.file);
    if (page === null) {
      if (settings.home === null) return { kind: 'none' };
      target = { account: settings.home, why: 'home', page: null };
    } else {
      const sent = existingPage(settings, page);
      if (sent === 'leave') return { kind: 'none' };
      if (sent === 'unknown') return { kind: 'unknown-owner', url: page.url };
      target = { ...sent, page };
    }
  }

  if (target.account === sessionAccount) return { kind: 'stay', account: target.account, why: target.why };
  if (!input.registered(target.account)) {
    return { kind: 'refuse', reason: notAnAccount(target.why, target.account) };
  }
  return { kind: 'hop', to: target.account, why: target.why, page: target.page };
}

/**
 * Where a call about a page that exists goes. With updates routed, to its
 * owner. With only a home account set, still to that account for the pages on
 * it: those are the ones ccx put there, and the session that published one
 * could otherwise never change it.
 */
function existingPage(
  settings: RoutingSettings,
  page: Page | null,
): { account: string; why: 'home' | 'owner' } | 'leave' | 'unknown' {
  const owner = page?.owner ?? null;
  if (settings.updates === 'owner') return owner === null ? 'unknown' : { account: owner, why: 'owner' };
  if (owner !== null && owner === settings.home) return { account: owner, why: 'home' };
  return 'leave';
}
