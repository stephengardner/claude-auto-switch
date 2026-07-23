import { listAccounts } from '../accounts/registry.js';
import { isShimInstalled } from '../shell/install-shim.js';
import { defaultPowerShellProfile, defaultPosixProfile } from '../shell/profile-path.js';
import type { CliContext } from '../context.js';

/**
 * State-aware onboarding guidance: given how many accounts exist and whether the
 * transparent shim is installed, return the single clearest next step. Pure so
 * the whole decision tree is testable.
 */
export function setupGuidance(accountCount: number, shimInstalled: boolean): string {
  if (accountCount === 0) {
    return [
      'Step 1: add your Claude accounts.',
      '  ccx add <name>     log in an account (opens your browser)',
      '',
      'Add at least two, so ccx has somewhere to switch when one hits its limit.',
    ].join('\n');
  }
  if (accountCount === 1) {
    return [
      'Almost there: add one more account so ccx can switch between them.',
      '  ccx add <name>',
    ].join('\n');
  }
  if (!shimInstalled) {
    return [
      `You have ${accountCount} accounts registered. You're ready to go.`,
      '',
      'Start a session now:            ccx run',
      'Or type `claude` transparently: ccx on   (then just use `claude`)',
    ].join('\n');
  }
  return [
    `All set: ${accountCount} accounts, and transparent switching is on.`,
    'Just use `claude` as normal; ccx switches accounts automatically on a cap.',
  ].join('\n');
}

/** `ccx setup`: print the tailored next step for the current state. */
export function setupCommand(context: CliContext): number {
  const count = listAccounts(context.ctx).length;
  const platform = context.ctx.platform ?? process.platform;
  const profile =
    platform === 'win32'
      ? defaultPowerShellProfile(context.ctx)
      : defaultPosixProfile(context.ctx);
  context.out(setupGuidance(count, isShimInstalled(profile)));
  return 0;
}
