/**
 * The sign-ins to a person's own MCP servers (`claude mcp login`), which
 * Claude keeps in the login text beside the Claude account's, under `mcpOAuth`.
 *
 * Such a sign-in has a refresh token that works once, so two stores holding
 * one sign-in cancel each other at the first refresh. Each is held by one
 * store, the one a Claude runs on: ccx never copies a live store's into another,
 * a store that ends hands its own to the account's saved login, and a store that
 * starts takes what was handed over.
 */

export const MCP_OAUTH_KEY = 'mcpOAuth';

/**
 * What installing one login over another does with `mcpOAuth`:
 * - keep-target: the target keeps its own and gets none of the source's. For an
 *   account's saved login written from a store that lives on.
 * - folder: keep-target for a folder a Claude runs on, except that a folder
 *   holding no login at all is new, and gets the source whole.
 * - park: the source's MCP logins join the target's server by server, because
 *   its store is ending: for a server both hold, the sign-in that expires
 *   later stays (a copy of one sign-in is routine, and the later is the one
 *   refreshed last) and the source's stands when that is not known, and a
 *   server the source does not hold stays. A source that holds none, or an
 *   empty set, parks nothing, since another store may have parked some there
 *   meanwhile.
 */
export type McpMode = 'keep-target' | 'folder' | 'park';

function asObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Whether a store holds no login text at all: nothing there, or the `{}` that is put where a Claude is to read again. */
export function holdsNoLogin(text: string | null): boolean {
  if (text === null || text.trim() === '') return true;
  const held = asObject(text);
  return held !== null && Object.keys(held).length === 0;
}

/** A map of sign-ins with a server in it, or null: an empty `mcpOAuth` holds nothing. */
function signIns(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
    ? (value as Record<string, unknown>)
    : null;
}

const sameSignIn = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** When a sign-in expires, as epoch ms, or null when it says nothing a comparison can use. */
function expiryOf(signIn: unknown): number | null {
  if (typeof signIn !== 'object' || signIn === null) return null;
  const at = (signIn as { expiresAt?: unknown }).expiresAt;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

/**
 * Whether sign-in `a` is a later refresh of a server than `b`: both expire at a
 * known time and a's is later. Anything else, an equal or unknown expiry, is
 * not an answer, and the caller's own rule for a tie decides.
 */
function newer(a: unknown, b: unknown): boolean {
  const first = expiryOf(a);
  const second = expiryOf(b);
  return first !== null && second !== null && first > second;
}

/** `kept` joined by `parking`, server by server: a sign-in `kept` holds that is newer stays, and `parking` stands on a tie. */
function join(
  kept: Record<string, unknown>,
  parking: Record<string, unknown>,
): Record<string, unknown> {
  const joined = { ...kept };
  for (const [server, signIn] of Object.entries(parking)) {
    if (!Object.hasOwn(joined, server) || !newer(joined[server], signIn)) joined[server] = signIn;
  }
  return joined;
}

/** Whether a text holds MCP logins: a sign-in to at least one server in `mcpOAuth`. */
export function holdsMcpLogins(text: string): boolean {
  return signIns(asObject(text)?.[MCP_OAUTH_KEY]) !== null;
}

/**
 * Whether `copy` holds, for every server `ending` holds, that sign-in or one
 * that expires later. False when either is not a JSON object.
 */
export function holdsMcpLoginsOf(copy: string, ending: string): boolean {
  const saved = asObject(copy);
  const leaving = asObject(ending);
  if (saved === null || leaving === null) return false;
  const parking = signIns(leaving[MCP_OAUTH_KEY]);
  if (parking === null) return true;
  const kept = signIns(saved[MCP_OAUTH_KEY]);
  return (
    kept !== null &&
    Object.entries(parking).every(
      ([server, signIn]) =>
        Object.hasOwn(kept, server) &&
        (sameSignIn(kept[server], signIn) || newer(kept[server], signIn)),
    )
  );
}

/**
 * The sign-ins the `texts` of several stores of one folder hold between them,
 * server by server: the one that expires latest, and the first store's when
 * that is not known. Null when none holds any.
 */
export function gatherMcpLogins(texts: string[]): Record<string, unknown> | null {
  const gathered: Record<string, unknown> = {};
  for (const text of texts) {
    const held = signIns(asObject(text)?.[MCP_OAUTH_KEY]);
    if (held === null) continue;
    for (const [server, signIn] of Object.entries(held)) {
      if (!Object.hasOwn(gathered, server) || newer(signIn, gathered[server])) {
        gathered[server] = signIn;
      }
    }
  }
  return Object.keys(gathered).length > 0 ? gathered : null;
}

/**
 * `text` carrying `logins` as its sign-ins, its Claude login as it is. `text`
 * itself when it holds them already, and only the sign-ins when it is not a
 * JSON object.
 */
export function withMcpLogins(text: string, logins: Record<string, unknown>): string {
  const carrying = JSON.stringify({ [MCP_OAUTH_KEY]: logins });
  const held = asObject(text);
  if (held === null) return carrying;
  if (holdsMcpLoginsOf(text, carrying)) return text;
  return JSON.stringify({ ...held, [MCP_OAUTH_KEY]: logins });
}

/**
 * The text to write when `source` is installed over `target`, what the store
 * holds now (null when it holds nothing). Everything of the source but
 * `mcpOAuth` is kept as it is. When neither text holds `mcpOAuth`, or one is
 * not a JSON object, the result is `source` itself.
 */
export function mergeMcpLogins(
  source: string,
  target: string | null,
  mode: McpMode = 'keep-target',
): string {
  if (mode === 'folder' && holdsNoLogin(target)) return source;
  const incoming = asObject(source);
  if (incoming === null) return source;
  const parking = mode === 'park' ? signIns(incoming[MCP_OAUTH_KEY]) : null;
  if (parking !== null) {
    const held = target === null ? {} : asObject(target);
    if (held === null) return source;
    const kept = signIns(held[MCP_OAUTH_KEY]);
    if (kept === null) return source;
    const joined = join(kept, parking);
    const asItIs =
      Object.keys(joined).length === Object.keys(parking).length &&
      Object.entries(parking).every(([server, signIn]) => joined[server] === signIn);
    return asItIs ? source : JSON.stringify({ ...incoming, [MCP_OAUTH_KEY]: joined });
  }
  let own: unknown;
  if (target !== null) {
    const held = asObject(target);
    if (held === null) return source;
    own = held[MCP_OAUTH_KEY];
  }
  if (own === undefined && !Object.hasOwn(incoming, MCP_OAUTH_KEY)) return source;
  const merged = { ...incoming };
  if (own === undefined) delete merged[MCP_OAUTH_KEY];
  else merged[MCP_OAUTH_KEY] = own;
  return JSON.stringify(merged);
}

/**
 * `copy`, an account's saved login, with the MCP logins of `ending`, the text of
 * a store that is going, joined to those it holds server by server (for a
 * server both hold, the sign-in that expires later stays, and the ending
 * store's when that is not known), and its Claude login as it is. `copy`
 * itself when `ending` holds none, an empty set included, or `copy` holds its
 * sign-ins or later ones already, or either is not a JSON object.
 */
export function parkMcpLogins(copy: string, ending: string): string {
  const leaving = asObject(ending);
  const saved = asObject(copy);
  if (leaving === null || saved === null) return copy;
  const parking = signIns(leaving[MCP_OAUTH_KEY]);
  if (parking === null || holdsMcpLoginsOf(copy, ending)) return copy;
  const kept = signIns(saved[MCP_OAUTH_KEY]) ?? {};
  return JSON.stringify({ ...saved, [MCP_OAUTH_KEY]: join(kept, parking) });
}
