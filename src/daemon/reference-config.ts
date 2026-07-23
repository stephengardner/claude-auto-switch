import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homeDir, type PathCtx } from '../config/paths.js';

/**
 * The user's DEFAULT claude config file (used when CLAUDE_CONFIG_DIR is unset).
 * This is the "already onboarded" reference: it has hasCompletedOnboarding, the
 * theme, trusted folders, etc. We inherit those so a managed session skips the
 * first-run prompts instead of re-onboarding.
 */
export function defaultClaudeJsonPath(c: PathCtx = {}): string {
  const platform = c.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(homeDir(c), '.claude.json');
}

export function readReferenceConfig(c: PathCtx = {}): Record<string, unknown> {
  const file = defaultClaudeJsonPath(c);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Onboarding/preference flags that, when present, skip claude's first-run prompts. */
const ONBOARDING_KEYS = [
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'theme',
  'hasSeenTasksHint',
  'hasUsedBackslashReturn',
  'hasUsedRemoteControl',
  'hasIdeOnboardingBeenShown',
  'cachedChromeExtensionInstalled',
  'editorMode',
  'autoUpdates',
  'bypassPermissionsModeAccepted',
  'hasAcknowledgedCostThreshold',
  'hasAvailableMaxSubscription',
];

/** Extract just the onboarding/preference flags from a reference config. */
export function onboardingFlags(reference: Record<string, unknown>): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  for (const key of ONBOARDING_KEYS) {
    if (key in reference) flags[key] = reference[key];
  }
  // Ensure onboarding is marked complete even if the reference lacked the flag.
  flags.hasCompletedOnboarding = true;
  return flags;
}
