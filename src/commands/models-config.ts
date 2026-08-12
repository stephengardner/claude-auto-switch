import { loadConfig, saveConfig } from '../config/config.js';
import type { RotationStrategy } from '../usage/rotation-plan.js';
import type { CliContext } from '../context.js';

/**
 * Read and set the model policy: which models to use, in what order, and
 * whether the MODEL or the ACCOUNT is the thing that gets used up first.
 *
 * This lives behind a command rather than only in the config file because it
 * is the setting most worth changing: which model a session runs is the
 * difference an operator actually feels, and the two strategies produce
 * opposite behaviour from the same accounts.
 */

export interface ModelsCommandOptions {
  /** 'model-first' or 'account-first'. */
  strategy?: string;
}

const STRATEGIES: RotationStrategy[] = ['model-first', 'account-first'];

function describeStrategy(strategy: RotationStrategy, chain: readonly string[]): string {
  const first = chain[0] ?? 'the current model';
  const next = chain[1];
  return strategy === 'model-first'
    ? `model-first: stay on ${first} across every account, and only then ` +
        (next ? `fall back to ${next}` : 'stop, because nothing else is allowed')
    : `account-first: use each account up across ${chain.join(' then ')} before moving to the next account`;
}

/** Show or change the model policy. */
export function modelsCommand(
  context: CliContext,
  models: string[] | undefined,
  options: ModelsCommandOptions = {},
): number {
  const onDisk = loadConfig(context.ctx);
  const named = (models ?? []).flatMap((m) => m.split(',')).map((m) => m.trim()).filter(Boolean);

  let strategy = onDisk.rotation.modelStrategy;
  if (options.strategy !== undefined) {
    const wanted = options.strategy.trim().toLowerCase();
    if (!STRATEGIES.includes(wanted as RotationStrategy)) {
      context.out(`--strategy must be one of: ${STRATEGIES.join(', ')} (got "${options.strategy}")`);
      return 1;
    }
    strategy = wanted as RotationStrategy;
  }

  // Nothing to change: report where things stand, and how to change them.
  if (named.length === 0 && options.strategy === undefined) {
    const chain = onDisk.rotation.modelPreference;
    context.out(`models:   ${chain.join(' then ')}`);
    context.out(`strategy: ${describeStrategy(strategy, chain)}`);
    context.out('');
    context.out('  ccx models fable opus            use Fable, fall back to Opus');
    context.out('  ccx models fable                 only ever Fable, never fall back');
    context.out('  ccx models --strategy account-first   use each account up instead');
    return 0;
  }

  const chain = named.length > 0 ? named : [...onDisk.rotation.modelPreference];
  saveConfig(
    {
      ...onDisk,
      rotation: {
        ...onDisk.rotation,
        modelPreference: chain as [string, ...string[]],
        modelStrategy: strategy,
      },
    },
    context.ctx,
  );

  context.out(`models:   ${chain.join(' then ')}`);
  context.out(`strategy: ${describeStrategy(strategy, chain)}`);
  if (chain.length === 1) {
    context.out(
      `nothing to fall back to: when ${chain[0]} runs out everywhere, ccx says so rather than ` +
        'switching you to a model you did not choose',
    );
  }
  return 0;
}
