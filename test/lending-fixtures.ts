import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addAccount } from '../src/accounts/registry.js';
import { loadConfig } from '../src/config/config.js';
import type { PathCtx } from '../src/config/paths.js';
import type { CliContext } from '../src/context.js';

/**
 * Machines for the lending tests: each a ccx home of its own in a temporary
 * folder, so an owner and its receivers can sit side by side in one test.
 * Every token here is made up, and nothing reaches the network.
 */

export const HOUR = 3_600_000;
export const MINUTE = 60_000;

export interface Machine {
  home: string;
  ctx: PathCtx;
}

export function machine(prefix = 'cas-lend-'): Machine {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  return { home, ctx: { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } } };
}

export function writeConfig(m: Machine, config: unknown): void {
  writeFileSync(path.join(m.home, 'config.json'), JSON.stringify(config), 'utf8');
}

export interface OwnLogin {
  accessToken?: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
}

/** Register `name` on `m` with a login of its own, refresh token and identity included, as a signed-in owner has it. */
export function ownLogin(m: Machine, name: string, login: OwnLogin): string {
  const dir = path.join(m.home, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  const email = login.email ?? `${name}@example.com`;
  writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: login.accessToken ?? `at-${name}-1`,
        refreshToken: login.refreshToken ?? `rt-${name}-1`,
        expiresAt: login.expiresAt,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    }),
    'utf8',
  );
  writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: email, accountUuid: `uuid-${name}` },
      userID: `install-${name}`,
    }),
    'utf8',
  );
  addAccount({ name, dir, email }, m.ctx);
  return dir;
}

/** A context for `m`, with what ccx says kept in `out` (standard output) and `err` (its own messages). */
export function contextOn(
  m: Machine,
  options: { quiet?: boolean; json?: boolean } = {},
): {
  context: CliContext;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const context: CliContext = {
    ctx: m.ctx,
    config: loadConfig(m.ctx),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    json: options.json ?? false,
    quiet: options.quiet ?? false,
  };
  return { context, out, err };
}
