import { readCredentialEvents, type CredentialEvent } from '../accounts/credential-log.js';
import { readEvents, formatEvents } from '../events/log.js';
import { configHome } from '../config/paths.js';
import { codes, paint } from '../ui/style.js';
import type { CliContext } from '../context.js';

/**
 * What has happened to your accounts and your logins.
 *
 * This exists because being asked to sign in again used to be a mystery. A
 * login can stop working for reasons that leave no trace on screen: it was
 * renewed (which retires the previous token), it was refused, or the session was
 * signed out. Those are now recorded, and this is where you read them.
 */

export interface HistoryOptions {
  /** How many entries to show. */
  limit?: string;
  /** Show only login-related entries, not switches. */
  logins?: boolean;
}

/** Plain-English wording for each kind of credential event. */
const WORDING: Record<CredentialEvent['kind'], string> = {
  renewed: 'login renewed (the previous token stopped working at this point)',
  'needs-login': 'renewal refused: this account has to be signed in again',
  'renew-failed': 'renewal did not go through (may be temporary)',
  installed: 'login written',
  refused: 'login NOT written, to avoid overwriting a good one',
  'rolled-back': 'previous login restored',
  'signed-out': 'session was signed out',
};

function when(at: number): string {
  return new Date(at).toLocaleString();
}

function colorFor(kind: CredentialEvent['kind']): string {
  if (kind === 'needs-login' || kind === 'signed-out') return codes.red;
  if (kind === 'refused' || kind === 'renew-failed' || kind === 'rolled-back') return codes.yellow;
  return codes.dim;
}

/** Print recent credential events, and recent switches unless asked not to. */
export function historyCommand(context: CliContext, options: HistoryOptions = {}): number {
  const limit = Math.max(1, Number(options.limit) || 30);
  const color = process.stdout.isTTY === true && !context.json;
  const credential = readCredentialEvents(limit, context.ctx);

  if (context.json) {
    context.out(JSON.stringify({ schemaVersion: 1, credentialEvents: credential }, null, 2));
    return 0;
  }

  context.out('');
  context.out(paint('logins', codes.bold, color));
  if (credential.length === 0) {
    context.out(paint('  nothing recorded yet', codes.dim, color));
  } else {
    for (const event of credential) {
      const repeat = event.count && event.count > 1 ? ` (x${event.count})` : '';
      const line = `  ${when(event.at)}  ${event.account}: ${WORDING[event.kind]}${repeat}`;
      context.out(paint(line, colorFor(event.kind), color));
      if (event.detail) context.out(paint(`      ${event.detail}`, codes.dim, color));
    }
  }

  if (!options.logins) {
    const switches = formatEvents(readEvents(configHome(context.ctx), limit));
    context.out('');
    context.out(paint('switches', codes.bold, color));
    if (switches.length === 0) {
      context.out(paint('  nothing recorded yet', codes.dim, color));
    } else {
      for (const line of switches) context.out(paint(`  ${line}`, codes.dim, color));
    }
  }
  context.out('');
  return 0;
}
