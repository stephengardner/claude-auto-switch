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
  const tag = raw.trim().toLowerCase();
  if (tag === '') throw new TagError('a tag cannot be empty');
  if (tag.length > MAX_LENGTH) throw new TagError(`"${raw}" is not a tag: at most ${MAX_LENGTH} characters`);
  if (!TAG.test(tag)) {
    throw new TagError(`"${raw}" is not a tag: use letters, digits, dot, dash or underscore, starting with a letter or digit`);
  }
  return tag;
}

/** Tags in one list: each normalized, once, sorted. */
function tidy(tags: Iterable<string>): string[] {
  return [...new Set([...tags].map(normalizeTag))].sort();
}

/**
 * Tags typed as one string, as the dashboard's box takes them: spaces or commas
 * between, any case. Empty is no tags. One bad tag refuses the whole string.
 */
export function parseTags(text: string): string[] {
  return tidy(text.split(/[\s,]+/).filter((t) => t !== ''));
}

/** `current` with `add` added. Refused past MAX_TAGS. */
export function withTags(current: readonly string[] | undefined, add: readonly string[]): string[] {
  const tags = tidy([...(current ?? []), ...add]);
  if (tags.length > MAX_TAGS) throw new TagError(`an account can carry at most ${MAX_TAGS} tags`);
  return tags;
}

/** `current` without the tags named in `remove`, matched in any case. */
export function withoutTags(current: readonly string[] | undefined, remove: readonly string[]): string[] {
  const gone = new Set(remove.map((t) => t.trim().toLowerCase()));
  return (current ?? []).filter((t) => !gone.has(t));
}

/** The accounts carrying EVERY tag in `tags`, in the order given. */
export function taggedAll<T extends { tags?: readonly string[] | undefined }>(
  accounts: readonly T[],
  tags: readonly string[],
): T[] {
  const wanted = tidy(tags);
  return accounts.filter((a) => wanted.every((t) => (a.tags ?? []).includes(t)));
}

/** Every tag in use, sorted, with the accounts carrying it in the order given. */
export function tagIndex(
  accounts: ReadonlyArray<{ name: string; tags?: readonly string[] | undefined }>,
): Array<{ tag: string; accounts: string[] }> {
  const index = new Map<string, string[]>();
  for (const account of accounts) {
    for (const tag of account.tags ?? []) index.set(tag, [...(index.get(tag) ?? []), account.name]);
  }
  return [...index.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([tag, names]) => ({ tag, accounts: names }));
}

/** Tags as a row or a line says them: `#bot #pat`, nothing when there are none. */
export function tagNote(tags: readonly string[] | undefined): string {
  return (tags ?? []).map((t) => `#${t}`).join(' ');
}
