import { listAccounts } from '../accounts/registry.js';
import { getActive } from '../state/active.js';
import { probeAll } from '../health/prober.js';
import { select } from '../selector/selector.js';
import { launchWatched, launchPassthrough } from '../launcher/launcher.js';
import { claudeSubcommandIn } from '../launcher/subcommand.js';
import { autoRotateHeadless } from '../launcher/rotating-run.js';
import { loadLedger, saveLedger, cappedNames, markCapped } from '../ledger/ledger.js';
import { getClaude, type CliContext } from '../context.js';
import { hasAnyUsableAccount, runInteractiveHotSwap } from './session.js';
import { advanceActiveToHealthy } from '../state/active-sync.js';
import { shouldHintShim, shimHintText, wasHinted, markHinted } from './shim-hint.js';
import { isShimInstalled } from '../shell/install-shim.js';
import { defaultPowerShellProfile, defaultPosixProfile } from '../shell/profile-path.js';
import { configHome } from '../config/paths.js';
import { signedInAndNotRejected } from '../health/signed-in.js';
import { confirmCap } from '../usage/confirm-cap.js';

/** Show a one-time tip about the transparent shim, after an interactive session. */
function maybeHintShim(context: CliContext): void {
  const home = configHome(context.ctx);
  // Cheap check first: once hinted, skip entirely (resolving the PowerShell
  // profile spawns a shell, which is far too costly for an every-run no-op).
  if (wasHinted(home)) return;
  const platform = context.ctx.platform ?? process.platform;
  const profile =
    platform === 'win32'
      ? defaultPowerShellProfile(context.ctx)
      : defaultPosixProfile(context.ctx);
  if (shouldHintShim(isShimInstalled(profile), false)) {
    (context.err ?? ((m: string) => process.stderr.write(`${m}\n`)))(shimHintText());
    markHinted(home);
  }
}

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
  // A SUBCOMMAND is not a session. `claude update`, `claude mcp list`, `claude
  // rc` and the rest manage the installation or its background sessions and
  // take their own options, while the session path adds `--session-id` for
  // resuming a conversation, which they reject outright. With the transparent
  // shim installed every one of them arrives here, so installing ccx quietly
  // broke them.
  //
  // FIRST, before accounts are even looked at. A subcommand needs no account:
  // it runs with the arguments and environment exactly as they arrived. Placing
  // it after the check below meant `claude update` answered "no accounts
  // registered" on an installation that had not added any yet, which is the
  // moment somebody is most likely to be running it.
  const subcommand = claudeSubcommandIn(passthroughArgs);
  if (subcommand) {
    const { exitCode } = await launchPassthrough(passthroughArgs, { claude: getClaude(context) });
    return exitCode;
  }

  const accounts = listAccounts(context.ctx);
  if (accounts.length === 0) {
    context.out('no accounts registered (run: ccx add <name>)');
    return 1;
  }

  // Interactive sessions with stored tokens get transparent hot-swap: the token
  // selects the account, so we skip the slow per-account health probe.
  if (!isHeadless(passthroughArgs) && hasAnyUsableAccount(context)) {
    const code = await runInteractiveHotSwap(context, passthroughArgs);
    maybeHintShim(context); // one-time tip after the session, if the shim is off
    return code;
  }

  const pinned = getActive(context.ctx) ?? undefined;
  const claude = getClaude(context);
  const healths = await probeAll(accounts, { claude });
  const loggedIn = signedInAndNotRejected(healths, accounts, context.ctx);

  if (isHeadless(passthroughArgs) && context.config.rotation.autoRotateHeadless) {
    const result = await autoRotateHeadless(passthroughArgs, {
      claude,
      accounts,
      loggedIn,
      pinned,
      now: () => Date.now(),
      // The account's OWN usage decides, so a limit is never recorded from text
      // alone and a model-scoped one keeps its scope.
      confirmCap: (account, renderedText) => confirmCap(account.dir, renderedText),
      modelPreference: context.config.rotation.modelPreference,
      modelStrategy: context.config.rotation.modelStrategy,
      defaultBackoffMinutes: context.config.rotation.defaultBackoffMinutes,
      ledger: loadLedger(context.ctx),
      out: context.out,
      writeOutput: (stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
      },
    });
    saveLedger(result.ledger, context.ctx);
    advanceActiveToHealthy(context, loggedIn); // carry the switch over to the editor
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
    // Same rule as every other cap-recording path: text only TRIGGERS, the
    // account's own usage decides. This branch used to write the cap straight
    // from the classification, so a replayed or quoted limit message could
    // bench an account for hours from here even though both rotation paths
    // had learned better.
    const decision = await confirmCap(result.account.dir, watched.stderr);
    if (decision.limited) {
      saveLedger(
        markCapped(loadLedger(context.ctx), {
          account: result.account.name,
          now: Date.now(),
          resetAt: decision.resetAt ?? watched.classification.resetAt ?? null,
          backoffMinutes: context.config.rotation.defaultBackoffMinutes,
          reason: watched.classification.reason ?? 'usage cap',
          ...(decision.model ? { model: decision.model } : {}),
        }),
        context.ctx,
      );
      context.out(
        decision.model
          ? `\n[ccx] "${result.account.name}" is out of ${decision.model}; other models still work here.`
          : `\n[ccx] "${result.account.name}" hit its limit; your next session will use a different account.`,
      );
      // Safe for BOTH scopes: cappedNames excludes model-scoped caps, so a
      // Fable-only limit leaves the active account reading as healthy and this
      // moves nothing. It only advances when the account is genuinely
      // unusable, which is exactly when the editor pointer should follow.
      advanceActiveToHealthy(context, loggedIn);
    } else {
      context.out(
        `\n[ccx] limit text on screen, but "${result.account.name}" shows no spent window; ` +
          'nothing was recorded.',
      );
    }
  }
  return watched.exitCode;
}
