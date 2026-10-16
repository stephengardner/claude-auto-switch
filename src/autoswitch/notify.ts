import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import type { PathCtx } from '../config/paths.js';
import { writeSecretFile } from '../util/secret-file.js';
import { CasError } from '../util/errors.js';
import { inWords, type WatchEvent } from './pass.js';
import { watchDir } from './state.js';

/**
 * The message a switch sends, and where it goes.
 *
 * One line per switch and one per incident, to a Slack incoming webhook of the
 * user's own. Nothing is sent until they give one.
 *
 * The line leaves the machine, so by default it says what happened without
 * saying which accounts are involved: "moved to the next account". Naming them
 * is a setting (`autoSwitch.nameAccounts`), for a channel only the user reads.
 */

export interface MessageSettings {
  /** Put in front, to tell one machine's messages from another's. */
  label: string | null;
  nameAccounts: boolean;
}

/**
 * Something the watchdog on another machine has to say about the watcher it
 * looks after. No host is carried: a host as typed for ssh can be a user name
 * and an address, and the label already says which machine is speaking.
 */
export type WatchdogEvent = { type: 'watcher-down' } | { type: 'watcher-unreachable'; forMs: number };

const WHAT_HAPPENED: Record<string, string> = {
  early: 'was near its limit',
  burn: 'was near its limit',
  'blind-high': 'was near its limit',
  spent: 'was used up',
  dead: 'had its login refused',
  blind: 'could not be read after a refused turn',
};

/** The line for one event. Pure, so the wording is tested without a network. */
export function eventMessage(event: WatchEvent | WatchdogEvent, settings: MessageSettings, now: number): string {
  const front = `${settings.label ? `[${settings.label}] ` : ''}ccx auto-switch: `;
  return front + body(event, settings.nameAccounts, now);
}

function body(event: WatchEvent | WatchdogEvent, names: boolean, now: number): string {
  switch (event.type) {
    case 'no-room': {
      const when = event.until !== null ? ` (the soonest opens ${inWords(event.until - now)})` : '';
      return `no account has room${when}; staying on ${names ? event.account : 'the account in use'}`;
    }
    case 'watcher-down':
      return 'the watcher this machine looks after was not running; a pass was run there from here';
    case 'watcher-unreachable':
      return `the machine the watcher runs on has not answered for ${Math.round(event.forMs / 60_000)} min`;
    default: {
      const to = names ? event.to : 'the next account';
      const followed = followersWords(event.followers);
      if (event.kind === 'forced') {
        // Who asked is a user name on this machine, which is as much theirs as an account name is.
        return names
          ? `moved from ${event.from} to ${to}, asked by ${event.by}${followed}`
          : `moved to ${to}, asked for by hand${followed}`;
      }
      const what = WHAT_HAPPENED[event.kind] ?? 'could not go on';
      if (event.pickRanOut) {
        return `${names ? `${event.from}, your pick,` : 'your pick'} ${what}; moved on to ${to}${followed}`;
      }
      return `${names ? event.from : 'the account in use'} ${what}; moved to ${to}${followed}`;
    }
  }
}

/** How many of the machines that follow this one did. Counts only: a host name says nothing a reader can act on here. */
function followersWords(followers: readonly { ok: boolean }[]): string {
  if (followers.length === 0) return '';
  const ok = followers.filter((f) => f.ok).length;
  return `; ${ok} of ${followers.length} other machine${followers.length === 1 ? '' : 's'} followed`;
}

/** The three characters Slack reads as markup in a message's text. */
function slackEscape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export interface PostResult {
  ok: boolean;
  detail?: string;
}

/**
 * Post one line to a Slack incoming webhook. Never throws and never waits
 * past eight seconds: a message that cannot be sent must not hold up the
 * switch it is about.
 */
export async function postToSlack(
  webhookUrl: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: slackEscape(text) }),
      signal: controller.signal,
    });
    return res.ok ? { ok: true } : { ok: false, detail: `status ${res.status}` };
  } catch (err) {
    // The name of the failure only: an error's message can carry the address, which is a secret.
    return { ok: false, detail: (err as Error).name === 'AbortError' ? 'timed out' : 'could not reach it' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where the webhook address is kept: a file of its own, readable only by its
 * owner, and not in config.json. Anyone holding the address can post to the
 * channel, so it is kept as a login is, and `ccx config` never shows it.
 */
export function webhookPath(c: PathCtx = {}): string {
  return path.join(watchDir(c), 'slack-webhook');
}

/** A webhook address ccx will post to: https, and nothing a shell or a log would trip on. */
export function checkWebhook(address: string): string {
  const trimmed = address.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CasError('that is not an address; a Slack incoming webhook starts with https://hooks.slack.com/');
  }
  if (url.protocol !== 'https:') throw new CasError('a webhook address starts with https://');
  if (url.username !== '' || url.password !== '') throw new CasError('a webhook address carries no user name or password');
  return url.toString();
}

export function saveWebhook(address: string, c: PathCtx = {}): void {
  writeSecretFile(webhookPath(c), `${checkWebhook(address)}\n`);
}

/** The saved address, or null when none is set or the file no longer holds one. */
export function readWebhook(c: PathCtx = {}): string | null {
  try {
    return checkWebhook(readFileSync(webhookPath(c), 'utf8'));
  } catch {
    return null;
  }
}

export function clearWebhook(c: PathCtx = {}): void {
  rmSync(webhookPath(c), { force: true });
}

/** Where messages go, without the part that is the secret: the host alone. */
export function webhookHost(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return 'an address that does not parse';
  }
}
