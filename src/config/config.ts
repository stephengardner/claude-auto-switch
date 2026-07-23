import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigSchema, type Config, type PartialConfig } from './config.schema.js';
import { configHome, type PathCtx } from './paths.js';
import { writeJsonFile } from '../util/fs-json.js';
import { ConfigError } from '../util/errors.js';

const CONFIG_FILENAME = 'config.json';

/** Absolute path to the user's config.json inside the config home. */
export function configFilePath(c: PathCtx = {}): string {
  const platform = c.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(configHome(c), CONFIG_FILENAME);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursively merge `over` onto `base` (nested plain objects merge; others replace). */
function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/** Map a fixed set of `CAS_*` environment variables to config overrides. */
function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (env.CAS_PROFILES_DIR) out.profilesDir = env.CAS_PROFILES_DIR;
  if (env.CAS_REAL_CLAUDE_PATH) out.realClaudePath = env.CAS_REAL_CLAUDE_PATH;

  const browser: Record<string, unknown> = {};
  if (env.CAS_BROWSER_DEBUG_PORT) browser.debugPort = Number(env.CAS_BROWSER_DEBUG_PORT);
  if (env.CAS_BROWSER_CHANNEL) browser.channel = env.CAS_BROWSER_CHANNEL;
  if (Object.keys(browser).length > 0) out.browser = browser;

  const rotation: Record<string, unknown> = {};
  if (env.CAS_AUTO_ROTATE_HEADLESS) {
    rotation.autoRotateHeadless = env.CAS_AUTO_ROTATE_HEADLESS === 'true';
  }
  if (Object.keys(rotation).length > 0) out.rotation = rotation;

  return out;
}

/**
 * Load config with precedence: built-in defaults < config.json < environment.
 * Always returns a fully-populated Config. Throws ConfigError on invalid values.
 */
export function loadConfig(c: PathCtx = {}): Config {
  const env = c.env ?? process.env;
  const file = configFilePath(c);

  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new ConfigError(`could not parse ${file}: ${(err as Error).message}`);
    }
    if (isPlainObject(parsed)) raw = parsed;
  }

  const merged = deepMerge(raw, envOverrides(env));
  try {
    return ConfigSchema.parse(merged);
  } catch (err) {
    throw new ConfigError(`Invalid config at ${file}: ${(err as Error).message}`);
  }
}

/** Persist config (partial allowed; missing keys fall back to defaults on load). */
export function saveConfig(config: PartialConfig, c: PathCtx = {}): void {
  writeJsonFile(configFilePath(c), config);
}
