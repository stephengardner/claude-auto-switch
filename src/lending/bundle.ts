import { z, type ZodError } from 'zod';
import { LendError } from '../util/errors.js';
import { assertProfileName } from '../util/names.js';
import { LENT_MARKER, lentLoginFromText } from './lent-login.js';

/**
 * What one machine sends another to lend it a login (`ccx lend export`, `ccx
 * lend sync`), and to take a lend back (`ccx lend revoke`). Versioned JSON,
 * read by `ccx lend import`.
 *
 * What goes across is what the receiver's Claude needs to make requests: the
 * access token and when it expires, its scopes and plan, and who the account
 * is. Never the refresh token. It renews the login and works once, so a second
 * holder of it would end the owner's login the first time either renewed.
 * Fields are copied by name, so one that Claude adds to its login later is not
 * lent until ccx is taught that it is safe to lend.
 */

export const BUNDLE_FORMAT = 'ccx-lend';
export const BUNDLE_VERSION = 1;
/** Far more than any bundle needs; bounds what an import reads. */
export const MAX_BUNDLE_BYTES = 64 * 1024;

/** The parts of `claudeAiOauth` a lend carries. */
const LENT_FIELDS = [
  'accessToken',
  'expiresAt',
  'scopes',
  'subscriptionType',
  'rateLimitTier',
] as const;

const LentOauthSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
  scopes: z.array(z.string().max(256)).max(64).optional(),
  subscriptionType: z.string().max(64).optional(),
  rateLimitTier: z.string().max(128).optional(),
});

const common = {
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  account: z.string().min(1).max(64),
  /** When the owner made it, by the owner's clock. */
  issuedAt: z.number().int().nonnegative(),
};

const LendBundleSchema = z.object({
  ...common,
  kind: z.literal('lend'),
  /** The address the owner registered the account with. */
  email: z.string().max(320).optional(),
  /** Goes into the receiver's `.credentials.json`, as Claude keeps it there. */
  claudeAiOauth: LentOauthSchema,
  /** Who the account is, from the owner's `.claude.json`, as Claude keeps it there. */
  oauthAccount: z.record(z.string(), z.unknown()).optional(),
});

const RevokeBundleSchema = z.object({ ...common, kind: z.literal('revoke') });

const BundleSchema = z.discriminatedUnion('kind', [LendBundleSchema, RevokeBundleSchema]);

export type LendBundle = z.infer<typeof LendBundleSchema>;
export type RevokeBundle = z.infer<typeof RevokeBundleSchema>;
export type Bundle = LendBundle | RevokeBundle;

const REFRESH_KEY = /refresh[_-]?token/i;
/** How Anthropic's refresh tokens begin. */
const REFRESH_VALUE = /^sk-ant-ort/;
const MAX_DEPTH = 16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether anything in `value` is, or is named as, a refresh token. Deeper than
 * any bundle nests counts as yes: refused rather than half searched.
 */
export function containsRefreshToken(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (typeof value === 'string') return REFRESH_VALUE.test(value);
  if (Array.isArray(value)) return value.some((item) => containsRefreshToken(item, depth + 1));
  if (isPlainObject(value)) {
    return Object.entries(value).some(
      ([key, item]) => REFRESH_KEY.test(key) || containsRefreshToken(item, depth + 1),
    );
  }
  return false;
}

/** The first thing a schema refused, by where it is: never the value. */
function issueWords(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'not a usable value';
  return `${issue.path.length > 0 ? issue.path.join('.') : 'bundle'}: ${issue.message}`;
}

export interface LendSource {
  account: string;
  /** The address the account is registered with on the owner. */
  email?: string;
  /** The owner's stored login, as text. */
  credential: string;
  /** Who the account is, from the owner's `.claude.json`. */
  oauthAccount?: unknown;
  now: number;
}

/** The bundle that lends `source`'s login. Throws LendError, naming the account and never a value. */
export function buildLendBundle(source: LendSource): LendBundle {
  const { account } = source;
  assertProfileName(account);
  if (lentLoginFromText(source.credential)) {
    throw new LendError(
      `"${account}" is lent to this machine; only the machine that holds its login can lend it`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.credential);
  } catch {
    throw new LendError(`"${account}": its stored login could not be read`);
  }
  const oauth = isPlainObject(parsed) ? parsed.claudeAiOauth : undefined;
  if (
    !isPlainObject(oauth) ||
    typeof oauth.accessToken !== 'string' ||
    oauth.accessToken.length === 0
  ) {
    throw new LendError(`"${account}" has no signed-in login here to lend`);
  }
  if (
    typeof oauth.expiresAt !== 'number' ||
    !Number.isFinite(oauth.expiresAt) ||
    oauth.expiresAt <= 0
  ) {
    throw new LendError(
      `"${account}": its login does not say when it expires, so it cannot be lent`,
    );
  }
  const lent: Record<string, unknown> = {};
  for (const field of LENT_FIELDS) {
    if (oauth[field] !== undefined) lent[field] = oauth[field];
  }
  lent.expiresAt = Math.floor(oauth.expiresAt);
  const bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    kind: 'lend',
    account,
    ...(source.email ? { email: source.email } : {}),
    issuedAt: source.now,
    claudeAiOauth: lent,
    ...(isPlainObject(source.oauthAccount) ? { oauthAccount: source.oauthAccount } : {}),
  };
  // Checked on the way out as well as on the way in: whatever the stored login
  // or its identity held, a refresh token never leaves this machine.
  if (containsRefreshToken(bundle)) {
    throw new LendError(`"${account}" was not lent: what would be sent names a refresh token`);
  }
  const checked = LendBundleSchema.safeParse(bundle);
  if (!checked.success) {
    throw new LendError(
      `"${account}": its login is not in a shape ccx can lend (${issueWords(checked.error)})`,
    );
  }
  return checked.data;
}

/** The bundle that takes a lend of `account` back. */
export function buildRevokeBundle(account: string, now: number): RevokeBundle {
  assertProfileName(account);
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, kind: 'revoke', account, issuedAt: now };
}

export function serializeBundle(bundle: Bundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * Read a bundle, refusing anything that is not exactly one: too large, not
 * JSON, another format or a newer version, anything that carries a refresh
 * token, a malformed field, an account name ccx cannot use, or a lend that
 * has already expired. Throws LendError; no message repeats the input.
 */
export function parseBundle(text: string, now: number): Bundle {
  if (Buffer.byteLength(text, 'utf8') > MAX_BUNDLE_BYTES) {
    throw new LendError('this is larger than any lend bundle, so it was not read');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // JSON.parse quotes the text it stopped at, which can be a token.
    throw new LendError('this is not a lend bundle (not valid JSON)');
  }
  if (!isPlainObject(raw) || raw.format !== BUNDLE_FORMAT)
    throw new LendError('this is not a ccx lend bundle');
  if (raw.version !== BUNDLE_VERSION) {
    throw new LendError(
      typeof raw.version === 'number' && raw.version > BUNDLE_VERSION
        ? `this bundle is version ${raw.version}, newer than this ccx reads (${BUNDLE_VERSION}); update ccx here`
        : 'this bundle has no version this ccx reads',
    );
  }
  // Before anything else is read from it: a lend carrying a refresh token is
  // the very thing lending exists to prevent.
  if (containsRefreshToken(raw)) {
    throw new LendError(
      'this bundle carries a refresh token, which a lend never does; nothing was installed',
    );
  }
  const checked = BundleSchema.safeParse(raw);
  if (!checked.success)
    throw new LendError(`this bundle is not one ccx can read (${issueWords(checked.error)})`);
  const bundle = checked.data;
  try {
    assertProfileName(bundle.account);
  } catch {
    throw new LendError(
      'this bundle names an account ccx cannot use (letters, digits, dot, dash, underscore)',
    );
  }
  if (bundle.kind === 'lend' && bundle.claudeAiOauth.expiresAt <= now) {
    throw new LendError(
      `the lent login for "${bundle.account}" has already expired; ask its owner to send a fresh one (ccx lend sync there)`,
    );
  }
  return bundle;
}

/** The credential a receiver keeps for a lend: Claude's own shape, marked as lent, with no refresh token. */
export function lentCredentialText(bundle: LendBundle): string {
  return JSON.stringify({
    claudeAiOauth: bundle.claudeAiOauth,
    [LENT_MARKER]: { version: BUNDLE_VERSION, issuedAt: bundle.issuedAt },
  });
}
