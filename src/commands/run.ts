import { listAccounts } from '../accounts/registry.js';
import { getActive } from '../state/active.js';
import { probeAll } from '../health/prober.js';
import { select } from '../selector/selector.js';
import { launchWatched } from '../launcher/launcher.js';
import { autoRotateHeadless } from '../launcher/rotating-run.js';
import { loadLedger, saveLedger, cappedNames, markCapped } from '../ledger/ledger.js';
import { getClaude, type CliContext } from '../context.js';
import { hasAnyUsableAccount, runInteractiveHotSwap } from './session.js';

/** True for headless requests (`-p` / `--print`), where output can be captured. */
function isHeadless(args: string[]): boolean {
  return args.includes('-p') || args.includes('--print');
}

/**
 * Launch claude on the pinned/healthiest account. Headless requests auto-rotate
 * past capped accounts; interactive sessions launch once (mid-session rotation
 * is Phase 4).
 */
export async function runCommand(context: CliContext, passthroughArgs: string[]): Promise<number> {
  const accounts = listAccounts(context.ctx);
  if (accounts.length === 0) {
    context.out('no accounts registered (run: ccx add <name>)');
    return 1;
  }

  // Interactive sessions with stored tokens get transparent hot-swap: the token
  // selects the account, so we skip the slow per-account health probe.
  if (!isHeadless(passthroughArgs) && hasAnyUsableAccount(context)) {
    return runInteractiveHotSwap(context, passthroughArgs);
  }

  const pinned = getActive(context.ctx) ?? undefined;
  const claude = getClaude(context);
  const healths = await probeAll(accounts, { claude });
  const loggedIn = new Set(healths.filter((h) => h.loggedIn).map((h) => h.name));

  if (isHeadless(passthroughArgs) && context.config.rotation.autoRotateHeadless) {
    const result = await autoRotateHeadless(passthroughArgs, {
      claude,
      accounts,
      loggedIn,
      pinned,
      now: () => Date.now(),
      defaultBackoffMinutes: context.config.rotation.defaultBackoffMinutes,
      ledger: loadLedger(context.ctx),
      out: context.out,
      writeOutput: (stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
      },
    });
    saveLedger(result.ledger, context.ctx);
    return result.exitCode;
  }

  const capped = cappedNames(loadLedger(context.ctx), Date.now());
  const result = select({ accounts, loggedIn, capped, pinned });
  if (!result.ok) {
    context.out(`cannot run: ${result.reason}`);
    return 1;
  }

  const watched = await launchWatched(passthroughArgs, result.account, { claude });
  if (watched.classification.kind === 'capped') {
    saveLedger(
      markCapped(loadLedger(context.ctx), {
        account: result.account.name,
        now: Date.now(),
        resetAt: watched.classification.resetAt ?? null,
        backoffMinutes: context.config.rotation.defaultBackoffMinutes,
        reason: watched.classification.reason ?? 'usage cap',
      }),
      context.ctx,
    );
    context.out(
      `\n[ccx] "${result.account.name}" hit its limit; your next session will use a different account.`,
    );
  }
  return watched.exitCode;
}
