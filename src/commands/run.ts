import { listAccounts } from '../accounts/registry.js';
import { getActive } from '../state/active.js';
import { probeAll } from '../health/prober.js';
import { select } from '../selector/selector.js';
import { launchWatched, launchPassthrough } from '../launcher/launcher.js';
import { claudeSubcommandIn } from '../launcher/subcommand.js';
import { isPrintMode } from '../launcher/claude-args.js';
import { autoRotateHeadless } from '../launcher/rotating-run.js';
import {
  loadLedger,
  updateLedger,
  applyLedgerChange,
  cappedNames,
  markCapped,
  type LedgerChange,
} from '../ledger/ledger.js';
import { appendEvent, flushQueuedEvents } from '../events/log.js';
import { thrownReason } from '../util/thrown-reason.js';
import { preferredModel, roomOfFromSnapshot } from '../usage/account-room.js';
import { getClaude, type CliContext } from '../context.js';
import { hasAnyUsableAccount, runInteractiveHotSwap } from './session.js';
import { advanceActiveToHealthy } from '../state/active-sync.js';
import { shouldHintShim, shimHintText, wasHinted, markHinted, markCovered, recentlyCovered } from './shim-hint.js';
import { shellCoverage, shellPlans } from '../shell/shells.js';
import { configHome } from '../config/paths.js';
import { signedInAndNotRejected } from '../health/signed-in.js';
import { confirmCap } from '../usage/confirm-cap.js';
import { judgeRefusal } from '../session/refused-turn.js';

/** Show a one-time tip about the transparent shim, after an interactive session. */
function maybeHintShim(context: CliContext): void {
  const home = configHome(context.ctx);
  // Cheap checks first. Finding the PowerShell profiles starts both
  // PowerShells, too costly after every session, so complete coverage is
  // looked at again only once a day, which still notices a shell taken up later.
  if (wasHinted(home) || recentlyCovered(home)) return;
  const coverage = shellCoverage(shellPlans(context.ctx));
  if (shouldHintShim(coverage, false)) {
    (context.err ?? ((m: string) => process.stderr.write(`${m}\n`)))(shimHintText(coverage));
    markHinted(home);
  } else {
    markCovered(home);
  }
}

/**
 * Apply one change a headless run made to the ledger as it stands now. A ledger
 * that cannot be read or written loses that change, never the request: the run
 * goes on to the next account, and the event log says what was not recorded.
 */
function recordRunChange(context: CliContext, change: LedgerChange): void {
  try {
    updateLedger(context.ctx, (ledger) => applyLedgerChange(ledger, change));
  } catch (error) {
    const what =
      change.kind === 'capped' ? `that "${change.cap.account}" is out` : `that "${change.account}" ran fine`;
    appendEvent(
      configHome(context.ctx),
      `could not record ${what} on the ledger (${thrownReason(error)})`,
      Date.now(),
      { kind: 'ledger-write-failed', data: { change } },
    );
  }
}

/**
 * Launch claude on the pinned/healthiest account. Headless requests auto-rotate
 * past capped accounts; interactive sessions launch once (mid-session rotation
 * is Phase 4).
 */
export interface RunCommandOptions {
  /** Start armed: see HotSwapOptions.resumePrompt. Interactive sessions only. */
  resumePrompt?: string;
  /** See HotSwapOptions.startPrompt. Interactive sessions only. */
  startPrompt?: string;
  /** See HotSwapOptions.account. Interactive sessions only. */
  account?: string;
}

export async function runCommand(
  context: CliContext,
  passthroughArgs: string[],
  options: RunCommandOptions = {},
): Promise<number> {
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

  // Headless requests (print mode, however it is written: `-p`, `--print`,
  // `-pc`), where output can be captured.
  const headless = isPrintMode(passthroughArgs);
  // Interactive sessions with stored tokens get transparent hot-swap: the token
  // selects the account, so we skip the slow per-account health probe.
  if (!headless && hasAnyUsableAccount(context)) {
    let code: number;
    try {
      code = await runInteractiveHotSwap(context, passthroughArgs, options);
    } finally {
      // What the session logged is in the file once it has ended.
      flushQueuedEvents();
    }
    maybeHintShim(context); // one-time tip after the session, if the shim is off
    return code;
  }
  const ignored = (['resumePrompt', 'startPrompt'] as const).filter(
    (key) => options[key] !== undefined,
  );
  if (ignored.length > 0) {
    // Said rather than dropped silently: a -p run ends when it answers, so there
    // is no later swap for an armed prompt to ride.
    (context.err ?? ((m: string) => process.stderr.write(`${m}\n`)))(
      `ccx: ${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} for interactive sessions; ignored for this run`,
    );
  }

  // An account asked for by name comes first here too, when it can take the
  // run; otherwise the order picks, as for an interactive session.
  const pinned = options.account ?? getActive(context.ctx) ?? undefined;
  const claude = getClaude(context);
  const healths = await probeAll(accounts, { claude });
  const loggedIn = signedInAndNotRejected(healths, accounts, context.ctx);

  if (headless && context.config.rotation.autoRotateHeadless) {
    const result = await autoRotateHeadless(passthroughArgs, {
      claude,
      accounts,
      loggedIn,
      pinned,
      now: () => Date.now(),
      // The account's OWN usage decides, so a limit is never recorded from text
      // alone and a model-scoped one keeps its scope. When it cannot answer,
      // the run's own record of a refused turn can; nothing changes the login
      // under a print-mode run.
      confirmCap: (account, renderedText, recorded) =>
        confirmCap(account.dir, renderedText, {
          ...(context.capProbe ? { probe: context.capProbe } : {}),
          ...(recorded
            ? {
                refusal: judgeRefusal(
                  recorded,
                  {
                    sessionDir: null,
                    configDirs: () => accounts.map((a) => a.dir),
                    ctx: context.ctx,
                    ...(context.isClaudeProcess ? { isClaude: context.isClaudeProcess } : {}),
                  },
                  () => 0,
                ),
              }
            : {}),
        }),
      modelPreference: context.config.rotation.modelPreference,
      modelStrategy: context.config.rotation.modelStrategy,
      order: context.config.rotation.accountOrder,
      roomOf: roomOfFromSnapshot(context.ctx, Date.now(), context.config.rotation, preferredModel(context)),
      defaultBackoffMinutes: context.config.rotation.defaultBackoffMinutes,
      ledger: loadLedger(context.ctx),
      recordChange: (change) => recordRunChange(context, change),
      out: context.out,
      writeOutput: (stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
      },
    });
    advanceActiveToHealthy(context, loggedIn); // carry the switch over to the editor
    return result.exitCode;
  }

  const capped = cappedNames(loadLedger(context.ctx), Date.now());
  const result = select({
    accounts,
    loggedIn,
    capped,
    pinned,
    order: context.config.rotation.accountOrder,
    roomOf: roomOfFromSnapshot(context.ctx, Date.now(), context.config.rotation, preferredModel(context)),
  });
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
    const decision = await confirmCap(
      result.account.dir,
      watched.stderr,
      context.capProbe ? { probe: context.capProbe } : {},
    );
    if (decision.limited) {
      updateLedger(context.ctx, (ledger) =>
        markCapped(ledger, {
          account: result.account.name,
          now: Date.now(),
          resetAt: decision.resetAt ?? watched.classification.resetAt ?? null,
          backoffMinutes: context.config.rotation.defaultBackoffMinutes,
          reason: watched.classification.reason ?? 'usage cap',
          ...(decision.model ? { model: decision.model } : {}),
        }),
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
