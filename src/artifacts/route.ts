import path from 'node:path';
import { findPage, findRepublished, type Page } from './record.js';

/**
 * Which account one call of Claude's Artifact tool should go out as. Pure: the
 * hook reads the call, the settings and the record, and this decides. Whether
 * the session is already on that account is not decided here: the session's
 * own ccx holds it there for the call, or moves it (see hop.ts).
 *
 * Every action Claude Code 2.1.296's tool takes is sorted here, in both of its
 * spellings (the tool turns `publish` with `asset: true` into `upload_asset`
 * or `copy_from`, `read` with `path` into `read_file` or `read_asset`, `read`
 * with only `type_url` into `describe_type`, `list` with a scope into
 * `list_files`, `list_assets` or `list_types`, `delete` with `path` into
 * `delete_asset`, and back):
 * - publish: a new page goes to the home account; a page that exists, named
 *   by its link or by this conversation publishing the same file again, to
 *   its owner. With `type_url` it is always a new page.
 * - change (upload_asset, copy_from, delete_asset, share) and delete: to the
 *   owner, the only account that can change the page or who sees it.
 * - read (read, read_file, read_asset, read_page_data, list_files,
 *   list_assets): to the owner, since a private page reads as missing to
 *   anyone else.
 * - everything else goes as it is: list, list_types, describe_type and
 *   quickstart are about the session's own account; open, pin and unpin about
 *   the person's own view; comments, reply, resolve, watch, unwatch, status,
 *   resume_replies, read_db, write_db, verify and preview are the actions of
 *   the comments, data and check tools; room_send, get_endpoints,
 *   call_endpoint and run_script reach a page's live room and server code,
 *   can ask the person and run for as long as the code does, and are left
 *   until that is measured; sync, version and live-edit have no code in this
 *   build, which refuses them itself; and an action this does not know is
 *   left alone.
 */

export type CallKind = 'publish' | 'change' | 'delete' | 'read' | 'other';

/** The part of a call that decides where it goes. */
export interface ArtifactCall {
  /** As the call named it; `publish` when it named none, as most do. */
  action: string;
  kind: CallKind;
  /** The page the call names, when it names one. */
  url: string | null;
  /** The file it publishes, absolute. */
  file: string | null;
  /** The type a new page is made from. */
  typeUrl: string | null;
}

export interface RoutingSettings {
  home: string | null;
  updates: 'off' | 'owner';
}

export interface RouteInput {
  call: ArtifactCall;
  settings: RoutingSettings;
  /** The conversation making the call. */
  sessionId: string | null;
  pages: readonly Page[];
  /** Whether ccx has an account by this name. Whether it is signed in is asked by the session's ccx. */
  registered: (name: string) => boolean;
}

export type Route =
  /** Nothing is configured for this call: it is not touched in any way. */
  | { kind: 'none' }
  /** It goes out as `to`: the session is held there, or moved there, for the length of the call. */
  | { kind: 'go'; to: string; why: 'home' | 'owner'; page: Page | null }
  /** A call about a page nobody recorded the owner of: sent as it is, with a word on how to record owners. */
  | { kind: 'unknown-owner'; url: string }
  /** The route cannot be honoured, and the call must not go out anywhere else. */
  | { kind: 'refuse'; reason: string };

/** Whether either setting is on. With both off ccx does nothing here at all. */
export function routingOn(settings: RoutingSettings): boolean {
  return settings.home !== null || settings.updates === 'owner';
}

const word = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

const CHANGES = new Set(['upload_asset', 'copy_from', 'delete_asset', 'share']);
const READS = new Set(['read_file', 'read_asset', 'read_page_data', 'list_files', 'list_assets']);

function kindOf(action: string, input: Record<string, unknown>, url: string | null): CallKind {
  let kind: CallKind;
  if (action === 'publish') kind = input.asset === true ? 'change' : 'publish';
  else if (CHANGES.has(action)) kind = 'change';
  else if (READS.has(action)) kind = 'read';
  else if (action === 'read') kind = word(input.type_url) !== null && url === null ? 'other' : 'read';
  else if (action === 'list') kind = input.scope === 'files' || input.scope === 'assets' ? 'read' : 'other';
  else if (action === 'delete') kind = word(input.path) !== null ? 'change' : 'delete';
  else return 'other';
  // Only a publish can be about a page it does not name.
  return kind === 'publish' || url !== null ? kind : 'other';
}

/** The call in a hook's `tool_input`. A relative file is Claude's, so it is resolved against Claude's folder. */
export function readCall(toolInput: unknown, cwd: string | null): ArtifactCall {
  const input = typeof toolInput === 'object' && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
  const action = word(input.action) ?? 'publish';
  const url = word(input.url);
  const file = word(input.file_path);
  return {
    action,
    kind: kindOf(action, input, url),
    url,
    file: file === null ? null : path.resolve(cwd ?? '', file),
    typeUrl: word(input.type_url),
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
  const { call, settings } = input;
  if (!routingOn(settings) || call.kind === 'other') return { kind: 'none' };

  let target: { account: string; why: 'home' | 'owner'; page: Page | null };
  // A page from a type is always a new one, whatever file it is given.
  const existing =
    call.kind !== 'publish'
      ? findPage(input.pages, call.url)
      : call.typeUrl !== null
        ? null
        : call.url !== null
          ? findPage(input.pages, call.url)
          : findRepublished(input.pages, input.sessionId, call.file);
  const named = call.kind !== 'publish' || (call.typeUrl === null && call.url !== null);

  if (existing === null && !named) {
    if (settings.home === null) return { kind: 'none' };
    target = { account: settings.home, why: 'home', page: null };
  } else {
    const sent = existingPage(settings, existing);
    if (sent === 'leave') return { kind: 'none' };
    if (sent === 'unknown') {
      // A page nothing is recorded about may be somebody else's, shared to
      // read: only a change to one is worth a word.
      return call.kind === 'read' ? { kind: 'none' } : { kind: 'unknown-owner', url: existing?.url ?? (call.url as string) };
    }
    target = { ...sent, page: existing };
  }

  if (!input.registered(target.account)) {
    return { kind: 'refuse', reason: notAnAccount(target.why, target.account) };
  }
  return { kind: 'go', to: target.account, why: target.why, page: target.page };
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
