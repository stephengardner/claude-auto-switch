import { TagError } from '../util/errors.js';

/**
 * Tags on accounts: short labels that say what an account is kept for, or for
 * whom (`pat`, `bot`, `stephen`), so an account out of rotation says why.
 *
 * Kept on the account's own record (accounts.json), so a rename keeps them and
 * a removal drops them with nothing else to keep in step. Tags never change
 * rotation; enabled or disabled still decides that.
 *
 * Pure: every rule about what a tag is lives here, and the commands, the
 * dashboard and `ccx state` take their answers from it.
 */

/** How many tags one account may carry. */
export const MAX_TAGS = 16;

/** How long one tag may be. */
const MAX_LENGTH = 32;

/** Letters, digits, dot, dash, underscore, starting with a letter or digit. */
const TAG = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * One tag as it is stored: trimmed and lowercased, so `Pat` and `pat` are one
 * tag. Anything else is refused with the tag named, never quietly changed into
 * something the person did not type.
 */
export function normalizeTag(raw: string): string {
  return normalizeLabel(raw, 'tag');
}

/**
 * The one rule for a label on an account: a tag, or the name of a pool
 * (accounts/pools), which is written the same way. `what` names which in
 * the refusal.
 */
export function normalizeLabel(raw: string, what: 'tag' | 'pool'): string {
  const label = raw.trim().toLowerCase();
  if (label === '') throw new TagError(`a ${what} cannot be empty`);
  if (label.length > MAX_LENGTH) throw new TagError(`"${raw}" is not a ${what}: at most ${MAX_LENGTH} characters`);
  if (!TAG.test(label)) {
    throw new TagError(`"${raw}" is not a ${what}: use letters, digits, dot, dash or underscore, starting with a letter or digit`);
  }
  return label;
}

/** Tags in one list: each normalized, once, sorted. */
function tidy(tags: Iterable<string>): string[] {
  return [...new Set([...tags].map(normalizeTag))].sort();
}

/**
 * A tag as a file holds it, in the form it is compared in. Stored tags are
 * only lowercased and trimmed, never checked: a hand-edited `b@d` stays what
 * it is, can be seen and removed, and does not stop a good tag being added.
 */
function storedTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** Stored tags, each in the form it is compared in, once, sorted. */
function tidyStored(tags: Iterable<string>): string[] {
  return [...new Set([...tags].map(storedTag).filter((t) => t !== ''))].sort();
}

/**
 * The `tags` field as accounts.json holds it, read into the form every rule
 * here compares: lowercased, trimmed, once each, sorted. Nothing is dropped
 * for not being a tag, so a later write keeps what was there; a lone string is
 * one tag, a number or boolean its text. Undefined for no tags, or for a value
 * that cannot be a list of tags, so a hand edit never makes the accounts
 * unreadable.
 */
export function storedTags(raw: unknown): string[] | undefined {
  const items = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (!items) return undefined;
  const text = items.flatMap((t) =>
    typeof t === 'string' ? [t] : typeof t === 'number' || typeof t === 'boolean' ? [String(t)] : [],
  );
  const tags = tidyStored(text);
  return tags.length > 0 ? tags : undefined;
}

/**
 * Tags typed as one string, as the dashboard's box takes them: spaces or commas
 * between, any case. Empty is no tags. One bad tag refuses the whole string.
 */
export function parseTags(text: string): string[] {
  return tidy(text.split(/[\s,]+/).filter((t) => t !== ''));
}

/**
 * `current` with `add` added. Only what is added is checked; what is already
 * stored is kept as it is (see storedTag). Refused when it would take the
 * account past MAX_TAGS, or further past it for one a hand edit put over.
 */
export function withTags(current: readonly string[] | undefined, add: readonly string[]): string[] {
  const before = tidyStored(current ?? []);
  const tags = [...new Set([...before, ...tidy(add)])].sort();
  if (tags.length > MAX_TAGS && tags.length > before.length) {
    throw new TagError(`an account can carry at most ${MAX_TAGS} tags`);
  }
  return tags;
}

/** `current` without the tags named in `remove`, matched in any case. */
export function withoutTags(current: readonly string[] | undefined, remove: readonly string[]): string[] {
  const gone = new Set(remove.map(storedTag));
  return tidyStored(current ?? []).filter((t) => !gone.has(t));
}

/** The accounts carrying EVERY tag in `tags`, in the order given. */
export function taggedAll<T extends { tags?: readonly string[] | undefined }>(
  accounts: readonly T[],
  tags: readonly string[],
): T[] {
  const wanted = tidy(tags);
  return accounts.filter((a) => {
    const carried = new Set(tidyStored(a.tags ?? []));
    return wanted.every((t) => carried.has(t));
  });
}

/** Every tag in use, sorted, with the accounts carrying it in the order given. */
export function tagIndex(
  accounts: ReadonlyArray<{ name: string; tags?: readonly string[] | undefined }>,
): Array<{ tag: string; accounts: string[] }> {
  const index = new Map<string, string[]>();
  for (const account of accounts) {
    for (const tag of tidyStored(account.tags ?? [])) index.set(tag, [...(index.get(tag) ?? []), account.name]);
  }
  return [...index.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([tag, names]) => ({ tag, accounts: names }));
}

/** Tags as a row or a line says them: `#bot #pat`, nothing when there are none. */
export function tagNote(tags: readonly string[] | undefined): string {
  return (tags ?? []).map((t) => `#${t}`).join(' ');
}
