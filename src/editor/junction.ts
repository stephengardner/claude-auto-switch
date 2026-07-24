import path from 'node:path';
import { existsSync } from 'node:fs';
import { getActive } from '../state/active.js';
import { getAccount, listAccounts } from '../accounts/registry.js';
import { setTarget, removeTarget, isLink, readTarget } from '../daemon/junction.js';
import { readToken } from '../daemon/token-store.js';
import { ensureEditorReady } from '../commands/editor-ready.js';
import { configHome } from '../config/paths.js';
import type { CliContext } from '../context.js';

/** The account the editor pointer currently resolves to, or null. */
export function editorTargetAccount(context: CliContext): { name: string; loggedIn: boolean } | null {
  const target = readTarget(editorJunctionPath(context));
  if (!target) return null;
  const resolved = path.resolve(target);
  const account = listAccounts(context.ctx).find((a) => path.resolve(a.dir) === resolved);
  if (!account) return null;
  const loggedIn = existsSync(path.join(account.dir, '.credentials.json')) || readToken(account.dir) !== null;
  return { name: account.name, loggedIn };
}

/**
 * The editor points CLAUDE_CONFIG_DIR at this stable path, and ccx flips it to
 * whichever account is active. It is the editor's OWN pointer (distinct from the
 * daemon's "active" link) so `ccx editor off` and `ccx daemon uninstall` never
 * disturb each other.
 */
export function editorJunctionPath(context: CliContext): string {
  return path.join(configHome(context.ctx), 'editor-active');
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
  setTarget(editorJunctionPath(context), account.dir, { platform: context.ctx.platform });
  return true;
}

/**
 * Repoint the editor pointer at the active account, but ONLY if the editor is
 * actually set up (the pointer already exists). Safe to call from any switch
 * site; it is a no-op when the editor integration is off.
 */
export function syncEditorPointerIfEnabled(context: CliContext): void {
  if (isLink(editorJunctionPath(context))) syncEditorJunctionToActive(context);
}

/** Remove the editor pointer (used by `ccx editor off`). */
export function removeEditorJunction(context: CliContext): void {
  removeTarget(editorJunctionPath(context));
}
