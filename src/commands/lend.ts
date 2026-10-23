import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { getAccount, listAccounts } from '../accounts/registry.js';
import { loginWasRejected } from '../accounts/account-login.js';
import { credentialPath, isUsableCredential } from '../accounts/credential-vault.js';
import { DEFAULT_RENEW_AHEAD_MINUTES } from '../config/config.schema.js';
import type { CliContext } from '../context.js';
import type { LeaseOptions } from '../session/lease.js';
import { getActive } from '../state/active.js';
import { readExpiresAt } from '../usage/token-expiry.js';
import { CasError, LendError } from '../util/errors.js';
import { writeSecretFile } from '../util/secret-file.js';
import {
  MAX_BUNDLE_BYTES,
  buildRevokeBundle,
  parseBundle,
  serializeBundle,
  type LendBundle,
  type RevokeBundle,
} from '../lending/bundle.js';
import { installLend, removeLend, type RemoveResult } from '../lending/install.js';
import { lendMarginMs, lendUsable, lentLoginIn } from '../lending/lent-login.js';
import {
  lendBundleFor,
  renewAhead,
  targetAccounts,
  targetSettings,
  type RenewAheadOptions,
} from '../lending/owner.js';
import { deliver, describeTransport, type TransportDeps } from '../lending/transport.js';
import { durationWords, expiryWords, parseDuration } from '../lending/words.js';

/**
 * `ccx lend` and `ccx renew`: lending logins to other machines.
 *
 * The machine that holds a login (the owner) sends only its access token,
 * renewed ahead of its expiry and sent again before it runs out. A receiving
 * machine runs on it with no sign-in of its own, and can never renew it, so it
 * can never end the owner's login. See docs/lending.md.
 */

export interface LendDeps {
  now?: () => number;
  /** Whether standard output is a terminal, which `export` does not print a token to. */
  stdoutIsTTY?: boolean;
  /** Whether standard input is a terminal, which `import` does not wait on. */
  stdinIsTTY?: boolean;
  /** Standard input, read whole. */
  readStdin?: () => Promise<string>;
  transport?: TransportDeps;
  /** The token endpoint and how it is reached, for tests. */
  refresh?: RenewAheadOptions['refresh'];
  leaseOptions?: LeaseOptions;
}

/** ccx's own messages, kept off standard output where a bundle goes. */
function noteTo(context: CliContext): (message: string) => void {
  return context.err ?? ((message) => void process.stderr.write(`${message}\n`));
}

/** What a refused step says, or the error itself when it is not one ccx meant. */
function refusal(error: unknown): string {
  if (error instanceof CasError) return error.message;
  throw error;
}

async function readStandardInput(limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > limit)
      throw new LendError('what came in is larger than any lend bundle, so it was not read');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `ccx lend export <account>`: the bundle that lends it, to standard output or `--out <file>`. */
export async function lendExportCommand(
  context: CliContext,
  name: string,
  options: { out?: string; force?: boolean } = {},
  deps: LendDeps = {},
): Promise<number> {
  const note = noteTo(context);
  const now = (deps.now ?? Date.now)();
  const account = getAccount(name, context.ctx);
  if (!account) {
    note(`account "${name}" not found`);
    return 1;
  }
  if (!options.out && (deps.stdoutIsTTY ?? process.stdout.isTTY === true) && !options.force) {
    note(
      'not printed: a lend carries a live token, and standard output is a terminal. ' +
        `Pipe it (ccx lend export ${name} | ssh <host> ccx lend import), write it with --out <file>, or add --force`,
    );
    return 1;
  }
  let bundle: LendBundle;
  try {
    bundle = lendBundleFor(account, context.ctx, now);
  } catch (error) {
    note(`not exported: ${refusal(error)}`);
    return 1;
  }
  const text = serializeBundle(bundle);
  const expiresAt = bundle.claudeAiOauth.expiresAt;
  if (options.out) {
    const file = path.resolve(options.out);
    writeSecretFile(file, text);
    note(`lent "${name}" written to ${file} (owner-only), ${expiryWords(expiresAt, now)}`);
  } else {
    context.out(text.trimEnd());
    note(`lent "${name}", ${expiryWords(expiresAt, now)}`);
  }
  const aheadMs =
    (context.config.lending?.renewAheadMinutes ?? DEFAULT_RENEW_AHEAD_MINUTES) * 60_000;
  if (expiresAt - now < aheadMs)
    note(`  it has little time left; ccx renew ${name} first gives a lend hours`);
  return 0;
}

/** `ccx lend import [file]`: install the lend (or take back the one) in a bundle from a file or standard input. */
export async function lendImportCommand(
  context: CliContext,
  file: string | undefined,
  options: { as?: string } = {},
  deps: LendDeps = {},
): Promise<number> {
  const now = (deps.now ?? Date.now)();
  let text: string;
  try {
    if (file !== undefined && file !== '-') {
      if (statSync(file).size > MAX_BUNDLE_BYTES)
        throw new LendError(`${file} is larger than any lend bundle, so it was not read`);
      text = readFileSync(file, 'utf8');
    } else {
      if (deps.stdinIsTTY ?? process.stdin.isTTY === true) {
        context.out(
          'nothing to import: pipe a bundle in (ccx lend export <account> | ccx lend import), or name a file',
        );
        return 1;
      }
      text = await (deps.readStdin ?? (() => readStandardInput(MAX_BUNDLE_BYTES)))();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    context.out(
      `not imported: ${error instanceof CasError ? error.message : `${file ?? 'standard input'} could not be read${code ? ` (${code})` : ''}`}`,
    );
    return 1;
  }
  try {
    const bundle = parseBundle(text, now);
    if (bundle.kind === 'revoke') {
      context.out(removedWords(removeLend(options.as ?? bundle.account, context)));
      return 0;
    }
    const installed = installLend(bundle, context, {
      ...(options.as ? { as: options.as } : {}),
      now,
    });
    const words = expiryWords(installed.expiresAt, now);
    context.out(
      installed.status === 'unchanged'
        ? `lent "${installed.account}" is already up to date, ${words}`
        : `lent "${installed.account}" ${installed.status}, ${words}`,
    );
    const marginMs = lendMarginMs(context.ctx);
    if (!lendUsable({ expiresAt: installed.expiresAt }, marginMs, now)) {
      context.out(
        `  it is inside this machine's ${durationWords(marginMs)} margin, so nothing starts on it until a fresher one comes`,
      );
    }
    return 0;
  } catch (error) {
    context.out(`not imported: ${refusal(error)}`);
    return 1;
  }
}

function removedWords(removed: RemoveResult): string {
  if (removed.status === 'absent') return `nothing lent as "${removed.account}" here to take back`;
  return removed.deregistered
    ? `took back the lent login for "${removed.account}", and the account the lend added`
    : `took back the lent login for "${removed.account}"; the account stays, with no login`;
}

/** `ccx renew <account>`: renew a login now when it has less than `--ahead` left, or with `--force` whatever is left. */
export async function renewCommand(
  context: CliContext,
  name: string,
  options: { ahead?: string; force?: boolean } = {},
  deps: LendDeps = {},
): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const account = getAccount(name, context.ctx);
  if (!account) {
    context.out(`account "${name}" not found`);
    return 1;
  }
  let aheadMs = (context.config.lending?.renewAheadMinutes ?? DEFAULT_RENEW_AHEAD_MINUTES) * 60_000;
  if (options.ahead !== undefined) {
    const typed = parseDuration(options.ahead);
    if (typed === null) {
      context.out(
        `--ahead takes a length of time such as 90m, 2h or 1h30m, not "${options.ahead}"`,
      );
      return 1;
    }
    aheadMs = typed;
  }
  try {
    const result = await renewAhead(account, listAccounts(context.ctx), context.ctx, {
      aheadMs,
      ...(options.force ? { force: true } : {}),
      now,
      ...(deps.refresh ? { refresh: deps.refresh } : {}),
      ...(deps.leaseOptions ? { leaseOptions: deps.leaseOptions } : {}),
    });
    switch (result.outcome) {
      case 'renewed':
        context.out(`renewed "${name}", ${expiryWords(result.expiresAt, now())}`);
        return 0;
      case 'fresh':
        context.out(
          `"${name}" was not renewed: it has ${durationWords(result.expiresAt - now())} left, ` +
            `more than ${durationWords(aheadMs)} (--force renews it anyway)`,
        );
        return 0;
      default:
        context.out(`"${name}" was not renewed: ${result.detail ?? result.outcome}`);
        return 1;
    }
  } catch (error) {
    context.out(`"${name}" was not renewed: ${refusal(error)}`);
    return 1;
  }
}

/**
 * `ccx lend sync`: for each target (or the one named), renew ahead the logins
 * it lends that need it, then send each a fresh bundle. Safe to run as often
 * as you like, from cron or a timer: a login is renewed at most once a run, and
 * a receiver that already has a lend as fresh changes nothing. Exits non-zero
 * when anything that should have been sent was not.
 */
export async function lendSyncCommand(
  context: CliContext,
  options: { target?: string; dryRun?: boolean } = {},
  deps: LendDeps = {},
): Promise<number> {
  const lending = context.config.lending;
  if (!lending || lending.targets.length === 0) {
    context.out('lending is off: config.json has no lending targets (see docs/lending.md)');
    return 1;
  }
  const targets = options.target
    ? lending.targets.filter((t) => t.name === options.target)
    : lending.targets;
  if (targets.length === 0) {
    context.out(
      `no lending target named "${options.target}" (there are: ${lending.targets.map((t) => t.name).join(', ')})`,
    );
    return 1;
  }
  const now = deps.now ?? (() => Date.now());
  const { ctx } = context;
  const dryRun = options.dryRun === true;
  const accounts = listAccounts(ctx);
  const byName = new Map(accounts.map((a) => [a.name, a] as const));
  const plans = targets.map((target) => ({
    target,
    ...targetAccounts(target, accounts, getActive(ctx)),
    ...targetSettings(target, lending),
  }));
  let failures = 0;
  const say = (line: string): void => {
    if (!context.quiet || dryRun) context.out(line);
  };
  const fail = (line: string): void => {
    failures += 1;
    context.out(line);
  };

  // Each login renewed at most once a run, as far ahead as the most demanding
  // target that lends it asks. Only a login of this machine's own that can be
  // renewed at all: the rest are reported once, when they are not sent.
  const renewable = (dir: string): boolean =>
    !lentLoginIn(dir) && isUsableCredential(credentialPath(dir)) && !loginWasRejected(dir, ctx);
  const aheadFor = new Map<string, number>();
  for (const plan of plans) {
    for (const name of plan.names) {
      const account = byName.get(name);
      if (account && renewable(account.dir))
        aheadFor.set(name, Math.max(aheadFor.get(name) ?? 0, plan.aheadMs));
    }
  }
  const renewing = new Set<string>();
  for (const [name, aheadMs] of aheadFor) {
    const account = byName.get(name);
    if (!account) continue;
    const left = readExpiresAt(credentialPath(account.dir)) - now();
    if (left > aheadMs) continue;
    if (dryRun) {
      renewing.add(name);
      say(
        `would renew "${name}" (${left > 0 ? `${durationWords(left)} left` : 'expired'}, under ${durationWords(aheadMs)})`,
      );
      continue;
    }
    try {
      const result = await renewAhead(account, accounts, ctx, {
        aheadMs,
        now,
        ...(deps.refresh ? { refresh: deps.refresh } : {}),
        ...(deps.leaseOptions ? { leaseOptions: deps.leaseOptions } : {}),
      });
      if (result.outcome === 'renewed')
        say(`renewed "${name}", ${expiryWords(result.expiresAt, now())}`);
      // Not a failure on its own: the token it has may still be worth sending.
      else if (result.outcome !== 'fresh')
        context.out(`"${name}" was not renewed: ${result.detail ?? result.outcome}`);
    } catch (error) {
      context.out(`"${name}" was not renewed: ${refusal(error)}`);
    }
  }

  for (const plan of plans) {
    const to = `${plan.target.name} (${describeTransport(plan.target.transport)})`;
    for (const name of plan.names) {
      const account = byName.get(name);
      if (!account) {
        fail(`${plan.target.name}: "${name}" is not an account here, so it was not sent`);
        continue;
      }
      let bundle: LendBundle;
      try {
        bundle = lendBundleFor(account, ctx, now());
      } catch (error) {
        // `all` lends whichever accounts can be lent; a list names ones that should be.
        if (plan.explicit) fail(`${plan.target.name}: "${name}" was not sent: ${refusal(error)}`);
        else say(`${plan.target.name}: "${name}" skipped: ${refusal(error)}`);
        continue;
      }
      const expiresAt = bundle.claudeAiOauth.expiresAt;
      if (dryRun && renewing.has(name)) {
        say(`would send "${name}" to ${to} once renewed`);
        continue;
      }
      if (expiresAt - now() <= plan.marginMs) {
        fail(
          `${plan.target.name}: "${name}" was not sent: it has ${durationWords(expiresAt - now())} left, ` +
            `inside the target's ${durationWords(plan.marginMs)} margin`,
        );
        continue;
      }
      if (dryRun) {
        say(`would send "${name}" to ${to}, ${expiryWords(expiresAt, now())}`);
        continue;
      }
      const delivered = await deliver(
        plan.target.transport,
        {
          account: name,
          kind: 'lend',
          payload: serializeBundle(bundle),
          secrets: [bundle.claudeAiOauth.accessToken],
        },
        { ...deps.transport, ctx: deps.transport?.ctx ?? ctx },
      );
      if (delivered.ok) say(`sent "${name}" to ${to}: ${delivered.detail}`);
      else fail(`${plan.target.name}: "${name}" was not delivered: ${delivered.detail}`);
    }
  }
  if (dryRun) say('dry run: nothing was renewed or sent');
  return failures > 0 ? 1 : 0;
}

/**
 * `ccx lend revoke <account>`: take a lend back from the receivers that have it,
 * through the same transports, or with `--local` from this machine, a receiver.
 * A receiver that has nothing lent by that name changes nothing.
 */
export async function lendRevokeCommand(
  context: CliContext,
  name: string,
  options: { target?: string; local?: boolean } = {},
  deps: LendDeps = {},
): Promise<number> {
  if (options.local) {
    if (options.target) {
      context.out('--local takes the lend back on this machine, so it takes no --target');
      return 1;
    }
    try {
      context.out(removedWords(removeLend(name, context)));
      return 0;
    } catch (error) {
      context.out(`not taken back: ${refusal(error)}`);
      return 1;
    }
  }
  const lending = context.config.lending;
  if (!lending || lending.targets.length === 0) {
    context.out(
      'lending is off: config.json has no lending targets (see docs/lending.md); on a receiver, use --local',
    );
    return 1;
  }
  const lendsIt = (t: (typeof lending.targets)[number]): boolean =>
    t.accounts === 'all' || t.accounts === 'all-except-active' || t.accounts.includes(name);
  const targets = options.target
    ? lending.targets.filter((t) => t.name === options.target)
    : lending.targets.filter(lendsIt);
  if (targets.length === 0) {
    context.out(
      options.target
        ? `no lending target named "${options.target}"`
        : `no lending target lends "${name}"; name the one to take it back from with --target`,
    );
    return 1;
  }
  let bundle: RevokeBundle;
  try {
    bundle = buildRevokeBundle(name, (deps.now ?? Date.now)());
  } catch (error) {
    context.out(`not taken back: ${refusal(error)}`);
    return 1;
  }
  let failures = 0;
  for (const target of targets) {
    const delivered = await deliver(
      target.transport,
      { account: name, kind: 'revoke', payload: serializeBundle(bundle), secrets: [] },
      { ...deps.transport, ctx: deps.transport?.ctx ?? context.ctx },
    );
    if (delivered.ok) {
      context.out(`${target.name}: ${delivered.detail}`);
    } else {
      failures += 1;
      context.out(`${target.name}: "${name}" was not taken back: ${delivered.detail}`);
    }
  }
  const accounts = listAccounts(context.ctx);
  const active = getActive(context.ctx);
  const still = targets
    .filter((t) => targetAccounts(t, accounts, active).names.includes(name))
    .map((t) => t.name);
  if (still.length > 0) {
    context.out(
      `note: ${still.join(', ')} still ${still.length === 1 ? 'lends' : 'lend'} "${name}" in config.json, so the next ` +
        `ccx lend sync sends it again; take it out of that target's accounts to stop it`,
    );
  }
  return failures > 0 ? 1 : 0;
}

/** `ccx lend`: what this machine lends, and what is lent to it. */
export function lendStatusCommand(context: CliContext, deps: Pick<LendDeps, 'now'> = {}): number {
  const now = (deps.now ?? Date.now)();
  const lending = context.config.lending;
  const accounts = listAccounts(context.ctx);
  const active = getActive(context.ctx);
  const marginMs = lendMarginMs(context.ctx);
  const lentHere = accounts.flatMap((a) => {
    const lent = lentLoginIn(a.dir);
    return lent
      ? [{ name: a.name, expiresAt: lent.expiresAt, usable: lendUsable(lent, marginMs, now) }]
      : [];
  });
  const targets = (lending?.targets ?? []).map((t) => ({
    name: t.name,
    transport: describeTransport(t.transport),
    accounts: targetAccounts(t, accounts, active).names,
  }));
  if (context.json) {
    context.out(JSON.stringify({ schemaVersion: 1, targets, lentHere }, null, 2));
    return 0;
  }
  if (targets.length === 0) {
    context.out(
      'lending from this machine: off (no lending targets in config.json; see docs/lending.md)',
    );
  } else {
    context.out('lending from this machine:');
    for (const t of targets)
      context.out(`  ${t.name}  ${t.transport}  ${t.accounts.join(', ') || '(no accounts)'}`);
  }
  if (lentHere.length === 0) {
    context.out('lent to this machine: none');
  } else {
    context.out('lent to this machine:');
    for (const l of lentHere) {
      context.out(
        `  ${l.name}  ${l.usable ? expiryWords(l.expiresAt, now) : `lend expired (${expiryWords(l.expiresAt, now)})`}`,
      );
    }
  }
  return 0;
}
