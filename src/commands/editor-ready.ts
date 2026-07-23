import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readReferenceConfig, onboardingFlags } from '../daemon/reference-config.js';
import { writeSecretFile } from '../util/secret-file.js';
import type { PathCtx } from '../config/paths.js';

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Merge the user's onboarding preferences into an account's config WITHOUT
 * losing the account's own identity (oauthAccount/userID). This is what stops
 * the editor's claude from re-running first-run prompts (login/theme/trust) when
 * it is pointed at a managed account folder. Pure so it is fully testable.
 */
export function mergeOnboarding(
  accountConfig: Record<string, unknown>,
  reference: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  const flags = onboardingFlags(reference);
  const projects: Record<string, unknown> =
    typeof accountConfig.projects === 'object' && accountConfig.projects
      ? { ...(accountConfig.projects as Record<string, unknown>) }
      : {};
  projects[cwd] = {
    ...(projects[cwd] as Record<string, unknown>),
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  // account values win over reference defaults; onboarding + trusted cwd forced.
  return { ...flags, ...accountConfig, hasCompletedOnboarding: true, projects };
}

/**
 * Ensure an account folder is "ready" for a non-terminal host (an editor): its
 * .claude.json carries the onboarding flags and marks the current folder trusted.
 * Idempotent: once onboarding is marked complete it does nothing.
 */
export function ensureEditorReady(accountDir: string, ctx: PathCtx = {}): void {
  const file = path.join(accountDir, '.claude.json');
  const account = readJson(file);
  if (account.hasCompletedOnboarding === true) return;
  writeSecretFile(file, JSON.stringify(mergeOnboarding(account, readReferenceConfig(ctx), process.cwd())));
}
