import { readFileSync } from 'node:fs';
import path from 'node:path';
import { homeDir, type PathCtx } from '../config/paths.js';
import { looksLikeConversationId } from '../launcher/conversation.js';

/**
 * Which of your accounts Claude Desktop is signed into.
 *
 * Desktop's chat sessions do not use a login ccx can swap: Desktop hands each
 * session its own signed-in account as a token. So the useful question is
 * which ccx account that is, because everything Desktop does spends it.
 * Desktop notes the account in its own settings, and every ccx account folder
 * holds the account id Claude recorded for its login; matching the two needs
 * no network and nothing from Desktop.
 */

/** Where Claude Desktop keeps its own settings on this platform. */
export function desktopConfigPath(c: PathCtx = {}): string {
  const env = c.env ?? process.env;
  const platform = c.platform ?? process.platform;
  if (platform === 'win32') {
    return path.join(
      env.APPDATA ?? path.join(homeDir(c), 'AppData', 'Roaming'),
      'Claude',
      'config.json',
    );
  }
  if (platform === 'darwin') {
    return path.join(homeDir(c), 'Library', 'Application Support', 'Claude', 'config.json');
  }
  return path.join(
    env.XDG_CONFIG_HOME ?? path.join(homeDir(c), '.config'),
    'Claude',
    'config.json',
  );
}

function readObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The Anthropic account id Desktop last signed in with, or null. */
export function desktopAccountId(c: PathCtx = {}): string | null {
  const id = readObject(desktopConfigPath(c))?.lastKnownAccountUuid;
  // Same shape as a conversation id: a UUID.
  return typeof id === 'string' && looksLikeConversationId(id) ? id : null;
}

/** The Anthropic account id behind a ccx account folder's login, or null. */
export function accountIdOf(dir: string): string | null {
  const oauth = readObject(path.join(dir, '.claude.json'))?.oauthAccount;
  if (typeof oauth !== 'object' || oauth === null) return null;
  const id = (oauth as Record<string, unknown>).accountUuid;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * The ccx account holding the same login as Desktop, or null when Desktop is
 * not signed in, or signed in as an account ccx does not have.
 */
export function desktopAccount(
  accounts: ReadonlyArray<{ name: string; dir: string }>,
  c: PathCtx = {},
  accountId: string | null = desktopAccountId(c),
): string | null {
  if (!accountId) return null;
  return accounts.find((a) => accountIdOf(a.dir) === accountId)?.name ?? null;
}
