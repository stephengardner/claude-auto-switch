import path from 'node:path';

/**
 * Injectable platform context. Every path helper takes this so the same code is
 * deterministic in tests regardless of the host OS: we pick `path.win32` or
 * `path.posix` based on the target `platform`, never the ambient separator.
 */
export interface PathCtx {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function resolveCtx(c: PathCtx = {}) {
  const platform = c.platform ?? process.platform;
  const env = c.env ?? process.env;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return { platform, env, p };
}

/** The user's home directory: USERPROFILE on Windows, HOME elsewhere. */
export function homeDir(c: PathCtx = {}): string {
  const { platform, env } = resolveCtx(c);
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  if (!home) {
    throw new Error('Cannot resolve home directory: HOME/USERPROFILE is not set');
  }
  return home;
}

/** Expand a leading `~` (bare or followed by a separator) to the home directory. */
export function expandTilde(input: string, c: PathCtx = {}): string {
  const { p } = resolveCtx(c);
  if (input === '~') return homeDir(c);
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return p.join(homeDir(c), input.slice(2));
  }
  return input;
}

/**
 * The tool's config home. Defaults to `~/.claude-auto-switch`; overridable with
 * the `CLAUDE_AUTO_SWITCH_HOME` environment variable.
 */
export function configHome(c: PathCtx = {}): string {
  const { env, p } = resolveCtx(c);
  const override = env.CLAUDE_AUTO_SWITCH_HOME;
  if (override) return expandTilde(override, c);
  return p.join(homeDir(c), '.claude-auto-switch');
}

/**
 * Where per-account profile folders live. Defaults to `<configHome>/profiles`;
 * a configured `profilesDir` (tilde allowed) overrides it.
 */
export function profilesDir(config: { profilesDir?: string }, c: PathCtx = {}): string {
  const { p } = resolveCtx(c);
  if (config.profilesDir) return expandTilde(config.profilesDir, c);
  return p.join(configHome(c), 'profiles');
}

/**
 * The default location where the real Claude CLI keeps credentials for the
 * DEFAULT account (spec fact 5). macOS returns the sentinel `keychain` because
 * credentials live in the Keychain there, not a file.
 */
export function defaultCredFile(c: PathCtx = {}): string {
  const { platform, p } = resolveCtx(c);
  if (platform === 'darwin') return 'keychain';
  return p.join(homeDir(c), '.claude', '.credentials.json');
}
