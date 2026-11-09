import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Stands for Claude's own default login, the one a Claude run with no
 * CLAUDE_CONFIG_DIR keeps: the Keychain item named without a hash on macOS,
 * ~/.claude/.credentials.json on Linux (keychain.ts). Chat mode
 * (default-login.ts) moves the active account's login into it.
 */
export const DEFAULT_LOGIN = '<claude-default-login>';

/** The folder of Claude's default login, ~/.claude; CCX_DEFAULT_CLAUDE_HOME stands in for the home folder in a test. */
export function defaultLoginFolder(): string {
  return path.join(process.env.CCX_DEFAULT_CLAUDE_HOME || process.env.HOME || homedir(), '.claude');
}
