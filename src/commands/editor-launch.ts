import { existsSync } from 'node:fs';
import path from 'node:path';
import { listAccounts } from '../accounts/registry.js';
import { getActive, setActive } from '../state/active.js';
import { probeAll } from '../health/prober.js';
import { select } from '../selector/selector.js';
import { launchWatched } from '../launcher/launcher.js';
import { loadLedger, saveLedger, markCapped, cappedNames } from '../ledger/ledger.js';
import { readToken } from '../daemon/token-store.js';
import { appendEvent } from '../events/log.js';
import { ensureEditorReady } from './editor-ready.js';
import { configHome } from '../config/paths.js';
import { getClaude, type CliContext } from '../context.js';
import type { Account } from '../accounts/registry.schema.js';

function hasLogin(dir: string): boolean {
  return existsSync(path.join(dir, '.credentials.json')) || readToken(dir) !== null;
}

/**
 * Transparent launcher for editors (and anything that spawns `claude` directly).
 * Runs the real claude with the chosen account's config and INHERITED stdio, so
 * the extension's protocol is untouched (no PTY/TUI). It watches for the cap and,
 * on one, flips the active account so the NEXT launch (your next chat/message)
 * starts on a fresh account. There is no mid-session swap here by design; the
 * editor talks to claude in a way that does not allow a live handoff.
 */
export async function editorLaunch(context: CliContext, args: string[]): Promise<number> {
  const accounts = listAccounts(context.ctx);
  const claude = getClaude(context);
  const home = configHome(context.ctx);
  const now = Date.now();
  const capped = cappedNames(loadLedger(context.ctx), now);
  const active = getActive(context.ctx) ?? undefined;

  // Fast path: the active account is usable, so launch on it with no health probe.
  let chosen: Account | undefined = accounts.find(
    (a) => a.name === active && a.enabled && !capped.has(a.name) && hasLogin(a.dir),
  );

  // Otherwise probe health and select the healthiest eligible account.
  if (!chosen) {
    const picked = await selectHealthy(context, accounts, capped, active);
    if (picked) {
      chosen = picked;
      setActive(picked.name, context.ctx);
    }
  }

  if (!chosen) {
    // No usable managed account: behave exactly like plain claude (no override).
    return (await launchWatched(args, { name: '', dir: '' }, { claude })).exitCode;
  }

  // Seed onboarding/identity so the editor's claude does not re-onboard/re-login.
  ensureEditorReady(chosen.dir, context.ctx);
  const result = await launchWatched(args, { name: chosen.name, dir: chosen.dir }, { claude });
  if (result.classification.kind === 'capped') {
    saveLedger(
      markCapped(loadLedger(context.ctx), {
        account: chosen.name,
        now: Date.now(),
        resetAt: result.classification.resetAt ?? null,
        backoffMinutes: context.config.rotation.defaultBackoffMinutes,
        reason: result.classification.reason ?? 'usage cap',
      }),
      context.ctx,
    );
    appendEvent(home, `${chosen.name} hit its limit (editor)`, Date.now());
    // Flip active to the next healthy account so the next chat is fresh.
    const next = await selectHealthy(
      context,
      accounts,
      cappedNames(loadLedger(context.ctx), Date.now()),
      undefined,
    );
    if (next) {
      setActive(next.name, context.ctx);
      appendEvent(home, `next editor chat will use ${next.name}`, Date.now());
    }
  }
  return result.exitCode;
}

/** Probe health and select the best eligible account (pinned preferred). */
async function selectHealthy(
  context: CliContext,
  accounts: Account[],
  capped: Set<string>,
  pinned: string | undefined,
): Promise<Account | undefined> {
  const claude = getClaude(context);
  const healths = await probeAll(accounts, { claude });
  const loggedIn = new Set(healths.filter((h) => h.loggedIn).map((h) => h.name));
  const sel = select({ accounts, loggedIn, capped, ...(pinned ? { pinned } : {}) });
  return sel.ok ? accounts.find((a) => a.name === sel.account.name) : undefined;
}
