import { existsSync } from 'node:fs';
import path from 'node:path';
import { listAccounts } from '../accounts/registry.js';
import { getActive, setActive } from '../state/active.js';
import { probeAll } from '../health/prober.js';
import { select } from '../selector/selector.js';
import { launchWatched, spawnWatched } from '../launcher/launcher.js';
import type { CapClassification } from '../launcher/cap-detect.js';
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

/** Pick the account to launch on: active if usable, else the healthiest eligible. */
async function pickAccount(context: CliContext): Promise<Account | undefined> {
  const accounts = listAccounts(context.ctx);
  const capped = cappedNames(loadLedger(context.ctx), Date.now());
  const active = getActive(context.ctx) ?? undefined;

  const fast = accounts.find(
    (a) => a.name === active && a.enabled && !capped.has(a.name) && hasLogin(a.dir),
  );
  if (fast) return fast;

  const picked = await selectHealthy(context, accounts, capped, active);
  if (picked) setActive(picked.name, context.ctx);
  return picked;
}

/** After a run, if it capped: record it and flip the active account for next time. */
async function handleCap(
  context: CliContext,
  chosen: Account,
  classification: CapClassification,
): Promise<void> {
  if (classification.kind !== 'capped') return;
  const home = configHome(context.ctx);
  saveLedger(
    markCapped(loadLedger(context.ctx), {
      account: chosen.name,
      now: Date.now(),
      resetAt: classification.resetAt ?? null,
      backoffMinutes: context.config.rotation.defaultBackoffMinutes,
      reason: classification.reason ?? 'usage cap',
    }),
    context.ctx,
  );
  appendEvent(home, `${chosen.name} hit its limit (editor)`, Date.now());
  const next = await selectHealthy(
    context,
    listAccounts(context.ctx),
    cappedNames(loadLedger(context.ctx), Date.now()),
    undefined,
  );
  if (next) {
    setActive(next.name, context.ctx);
    appendEvent(home, `next editor chat will use ${next.name}`, Date.now());
  }
}

/**
 * WRAPPER mode: run the EXACT command an editor hands us (e.g. `node cli.js
 * ...args`) on the chosen account, with inherited stdio so the extension's
 * protocol is untouched. On a cap, flip the active account so the next chat is
 * fresh. This is what the editor's claudeProcessWrapper setting points at.
 */
export async function wrapperLaunch(context: CliContext, argv: string[]): Promise<number> {
  const chosen = await pickAccount(context);
  if (!chosen || argv.length === 0) {
    // No usable account, or nothing to run: exec the command untouched.
    if (argv.length === 0) return 0;
    return (await spawnWatched(argv[0]!, argv.slice(1))).exitCode;
  }
  ensureEditorReady(chosen.dir, context.ctx);
  const result = await spawnWatched(argv[0]!, argv.slice(1), { CLAUDE_CONFIG_DIR: chosen.dir });
  await handleCap(context, chosen, result.classification);
  return result.exitCode;
}

/**
 * DIRECT mode: resolve the real claude and run it with the given claude args on
 * the chosen account. Used when ccx-claude is invoked directly (not via an
 * editor that passes the full command).
 */
export async function editorLaunch(context: CliContext, args: string[]): Promise<number> {
  const claude = getClaude(context);
  const chosen = await pickAccount(context);
  if (!chosen) {
    return (await launchWatched(args, { name: '', dir: '' }, { claude })).exitCode;
  }
  ensureEditorReady(chosen.dir, context.ctx);
  const result = await launchWatched(args, { name: chosen.name, dir: chosen.dir }, { claude });
  await handleCap(context, chosen, result.classification);
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
