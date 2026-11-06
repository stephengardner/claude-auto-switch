import { getAccount, listAccounts, updateAccount } from '../accounts/registry.js';
import { normalizeTag, parseTags, tagIndex, tagNote, taggedAll, withTags, withoutTags } from '../accounts/tags.js';
import type { Account } from '../accounts/registry.schema.js';
import type { CliContext } from '../context.js';

/**
 * `ccx tag`, `ccx untag` and `ccx tags`, and the `--tagged` selection that
 * `ccx list`, `ccx enable` and `ccx disable` share. What a tag is, and how
 * tags match, is accounts/tags; this is only the commands around it.
 */

/** What a command acts on: one account by name, or every one carrying all of `tagged`. */
export interface Selection {
  name?: string | undefined;
  tagged?: readonly string[] | undefined;
}

/** The accounts a selection names, or why it names none, in words. */
export function selectAccounts(
  context: CliContext,
  selection: Selection,
): { accounts: Account[] } | { refusal: string } {
  const tagged = selection.tagged ?? [];
  if (selection.name !== undefined && tagged.length > 0) {
    return { refusal: 'give an account name or --tagged, not both' };
  }
  if (selection.name !== undefined) {
    const account = getAccount(selection.name, context.ctx);
    return account ? { accounts: [account] } : { refusal: `account "${selection.name}" not found` };
  }
  if (tagged.length === 0) return { refusal: 'name an account, or pick accounts with --tagged <tag>' };
  let wanted: string[];
  try {
    wanted = tagged.map(normalizeTag);
  } catch (err) {
    return { refusal: (err as Error).message };
  }
  const all = listAccounts(context.ctx);
  const accounts = taggedAll(all, wanted);
  if (accounts.length > 0) return { accounts };
  return { refusal: `no account carries ${tagNote(wanted)}${inUse(all)}` };
}

/** The tags there are, to say beside a selection that matched nothing. */
function inUse(accounts: readonly Account[]): string {
  const tags = tagIndex(accounts).map((t) => t.tag);
  return tags.length > 0 ? ` (tags in use: ${tagNote(tags)})` : ' (no account has a tag yet)';
}

/** An account's tags, as the commands report them. */
function carries(name: string, tags: readonly string[] | undefined): string {
  return tags && tags.length > 0 ? `"${name}" is tagged ${tagNote(tags)}` : `"${name}" has no tags`;
}

/** `ccx tag <account> <tag...>`: add tags. Nothing is written when one is not a tag. */
export function tagCommand(context: CliContext, name: string, tags: readonly string[]): number {
  const account = getAccount(name, context.ctx);
  if (!account) {
    context.out(`account "${name}" not found`);
    return 1;
  }
  if (tags.length === 0) {
    context.out('name at least one tag: ccx tag <account> <tag...>');
    return 1;
  }
  let next: string[];
  try {
    next = withTags(account.tags, tags);
  } catch (err) {
    context.out((err as Error).message);
    return 1;
  }
  updateAccount(name, { tags: next }, context.ctx);
  context.out(carries(name, next));
  return 0;
}

/** `ccx untag <account> <tag...>` or `ccx untag <account> --all`. */
export function untagCommand(
  context: CliContext,
  name: string,
  tags: readonly string[],
  options: { all?: boolean } = {},
): number {
  const account = getAccount(name, context.ctx);
  if (!account) {
    context.out(`account "${name}" not found`);
    return 1;
  }
  if (options.all === true && tags.length > 0) {
    context.out('name the tags to remove, or --all, not both');
    return 1;
  }
  if (options.all !== true && tags.length === 0) {
    context.out('name the tags to remove, or --all to remove every one');
    return 1;
  }
  const next = options.all === true ? [] : withoutTags(account.tags, tags);
  updateAccount(name, { tags: next }, context.ctx);
  context.out(carries(name, next));
  return 0;
}

/** `ccx tags`: every tag in use, with the accounts carrying it. */
export function tagsCommand(context: CliContext): number {
  const accounts = listAccounts(context.ctx);
  const enabled = new Map(accounts.map((a) => [a.name, a.enabled]));
  const index = tagIndex(accounts);
  if (context.json) {
    // Wrapped, with a schemaVersion, like every other machine-readable output.
    context.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          tags: index.map((t) => ({
            tag: t.tag,
            accounts: t.accounts.map((name) => ({ name, enabled: enabled.get(name) === true })),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (index.length === 0) {
    context.out('no account has a tag yet (ccx tag <account> <tag>)');
    return 0;
  }
  const width = Math.max(...index.map((t) => t.tag.length + 1));
  for (const t of index) {
    const names = t.accounts.map((name) => (enabled.get(name) === true ? name : `${name} (disabled)`));
    context.out(`${`#${t.tag}`.padEnd(width)}  ${names.join(', ')}`);
  }
  return 0;
}

/**
 * The dashboard's tags box (`g`): the account's tags become exactly the ones
 * typed, spaces or commas between; an empty box clears them. Throws for a bad
 * tag, so the box stays open with the reason, as rename does.
 */
export function setTagsFromText(context: CliContext, name: string, text: string): string {
  const tags = withTags([], parseTags(text));
  updateAccount(name, { tags }, context.ctx);
  return carries(name, tags);
}
