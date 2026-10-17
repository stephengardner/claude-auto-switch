import path from 'node:path';
import { getActive } from '../state/active.js';
import { getAccount, listAccounts } from '../accounts/registry.js';
import { setTarget, removeTarget, isLink, readTarget } from '../daemon/junction.js';
import { ensureEditorReady } from '../commands/editor-ready.js';
import { hasWorkingLogin } from '../accounts/account-login.js';
import { CREDENTIALS_LOCK_DIR, lockDirHeld } from '../claude/locks.js';
import { configHome, type PathCtx } from '../config/paths.js';
import type { CliContext } from '../context.js';

/** The account the editor pointer currently resolves to, or null. */
export function editorTargetAccount(context: CliContext): { name: string; loggedIn: boolean } | null {
  const target = readTarget(editorJunctionPath(context));
  if (!target) return null;
  const resolved = path.resolve(target);
  const account = listAccounts(context.ctx).find((a) => path.resolve(a.dir) === resolved);
  if (!account) return null;
  // Not `existsSync` on the credential file: a signed-OUT profile keeps a
  // complete one with empty tokens, which is the check this project replaced
  // everywhere else years ago and which survived here. Refused logins are
  // excluded too, so doctor does not report the editor as pointed at a
  // working account when it is pointed at a finished one.
  const loggedIn = hasWorkingLogin(account.dir, context.ctx);
  return { name: account.name, loggedIn };
}

/**
 * The account the editor pointer targets, resolved from paths alone.
 *
 * A separate, lighter version of editorTargetAccount for callers that only have
 * a paths context. It exists because the editor's Claude reads an account's login
 * DIRECTLY through this pointer, so ccx is not in the loop for those sessions and
 * cannot know one is running: renewing that login can sign the editor out the
 * same way it used to sign terminal sessions out.
 *
 * Returns null when the editor integration is off, so nothing is protected
 * needlessly.
 */
export function editorPointerAccount(
  accounts: Array<{ name: string; dir: string }>,
  c: PathCtx = {},
): string | null {
  const target = readTarget(editorLinkPath(c));
  if (!target) return null;
  const resolved = path.resolve(target);
  return accounts.find((a) => path.resolve(a.dir) === resolved)?.name ?? null;
}

/** Where the editor's pointer lives, for a caller with only a paths context. */
export function editorLinkPath(c: PathCtx = {}): string {
  return path.join(configHome(c), 'editor-active');
}

/**
 * The editor points CLAUDE_CONFIG_DIR at this stable path. It was a link ccx
 * flipped to whichever account is active; an install still on that link is
 * moved into a folder of its own at the same path (editor/folder), and this
 * file keeps the link working until then. It is the editor's OWN path (distinct
 * from the daemon's "active" link) so `ccx editor off` and `ccx daemon
 * uninstall` never disturb each other.
 */
export function editorJunctionPath(context: CliContext): string {
  return editorLinkPath(context.ctx);
}

/**
 * Point the editor pointer at the active account (seeded so the editor's Claude
 * does not re-onboard). Returns false when there is no usable active account.
 */
export function syncEditorJunctionToActive(context: CliContext): boolean {
  const active = getActive(context.ctx);
  if (!active) return false;
  const account = getAccount(active, context.ctx);
  if (!account) return false;
  ensureEditorReady(account.dir, context.ctx);
  // Already there: left alone. Rewriting removes the link and makes it again,
  // and two sessions moving at once would meet each other's half-made one.
  const now = readTarget(editorJunctionPath(context));
  if (now !== null && path.resolve(now) === path.resolve(account.dir)) return true;
  setTarget(editorJunctionPath(context), account.dir, { platform: context.ctx.platform });
  return true;
}

/** How recently a login lock must have been touched to count as in use: Claude touches its own every 5 s. */
const LOCK_IN_USE_MS = 10_000;
/** How long a move of the pointer waits, at most, for a renewal through it to end, and how often it looks. */
const POINTER_WAIT_MS = 10_000;
const POINTER_LOOK_MS = 200;

/**
 * Repoint the editor pointer at the active account, but ONLY if the editor is
 * actually set up (the pointer already exists). Safe to call from any switch
 * site; it is a no-op when the editor integration is off.
 *
 * Whatever the account's login: one due for renewal may still be renewed by
 * a session moving onto it (see renewIdleLogin). But not while a renewal
 * through the pointer may be running. The editor's Claude takes its lock as
 * <pointer>/.oauth_refresh.lock and lets it go by removing that same path, so
 * a pointer moved in between makes it remove the lock of the account moved
 * to, which a session may have just taken to renew that login. So while the
 * account the pointer is on has its login lock in use, the move waits,
 * looking again every POINTER_LOOK_MS on a timer. This returns at once, but
 * the timer keeps a short-lived command such as `ccx use` running until the
 * pointer has moved. After POINTER_WAIT_MS the pointer moves anyway, since
 * nothing else would move it later; the race then needs a lock held longer
 * than that as well.
 */
export function syncEditorPointerIfEnabled(context: CliContext): void {
  movePointerWhenFree(context, Date.now() + POINTER_WAIT_MS);
}

function movePointerWhenFree(context: CliContext, giveUpAt: number): void {
  // Never throws: it is called from a running session's poll, where nothing
  // would catch it, and the editor following is not worth ending a session.
  try {
    const link = editorJunctionPath(context);
    if (!isLink(link)) return;
    const from = readTarget(link);
    const active = getActive(context.ctx);
    const to = active ? getAccount(active, context.ctx) : undefined;
    const moving = from !== null && to !== undefined && path.resolve(from) !== path.resolve(to.dir);
    if (
      moving &&
      Date.now() < giveUpAt &&
      lockDirHeld(path.join(path.resolve(from), CREDENTIALS_LOCK_DIR), LOCK_IN_USE_MS)
    ) {
      setTimeout(() => movePointerWhenFree(context, giveUpAt), POINTER_LOOK_MS);
      return;
    }
    syncEditorJunctionToActive(context);
  } catch {
    /* the pointer stays as it was until the next switch points it */
  }
}

/** Remove the editor pointer (used by `ccx editor off`). */
export function removeEditorJunction(context: CliContext): void {
  removeTarget(editorJunctionPath(context));
}
