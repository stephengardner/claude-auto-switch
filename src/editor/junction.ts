import { getActive } from '../state/active.js';
import { getAccount } from '../accounts/registry.js';
import { activeLinkPath } from '../daemon/install.js';
import { setTarget, removeTarget, isLink } from '../daemon/junction.js';
import { ensureEditorReady } from '../commands/editor-ready.js';
import { configHome } from '../config/paths.js';
import type { CliContext } from '../context.js';

/**
 * The editor points CLAUDE_CONFIG_DIR at this stable path, and ccx flips it to
 * whichever account is active. Reuses the same "active" link the daemon uses, so
 * the terminal and editor share one notion of the active account.
 */
export function editorJunctionPath(context: CliContext): string {
  return activeLinkPath(configHome(context.ctx));
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
