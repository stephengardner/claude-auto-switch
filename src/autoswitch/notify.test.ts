import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkWebhook,
  clearWebhook,
  eventMessage,
  postToSlack,
  readWebhook,
  saveWebhook,
  webhookHost,
  webhookPath,
} from './notify.js';
import type { WatchEvent } from './pass.js';
import type { PathCtx } from '../config/paths.js';

const now = Date.parse('2030-01-15T12:00:00Z');
const quiet = { label: null, nameAccounts: false };
const named = { label: null, nameAccounts: true };

const switched = (over: Partial<Extract<WatchEvent, { type: 'switched' }>> = {}): WatchEvent => ({
  type: 'switched',
  kind: 'early',
  from: 'work',
  to: 'personal',
  by: 'service',
  pickRanOut: false,
  followers: [],
  ...over,
});

describe('the message a switch sends', () => {
  it('names no account unless asked to', () => {
    const line = eventMessage(switched(), quiet, now);
    expect(line).toBe('ccx auto-switch: the account in use was near its limit; moved to the next account');
    expect(line).not.toContain('work');
    expect(line).not.toContain('personal');
  });

  it('names them when the setting is on', () => {
    expect(eventMessage(switched(), named, now)).toBe('ccx auto-switch: work was near its limit; moved to personal');
  });

  it('says why in words, whatever kind of move it was', () => {
    const why = (kind: string) => eventMessage(switched({ kind: kind as never }), quiet, now);
    expect(why('burn')).toContain('was near its limit');
    expect(why('blind-high')).toContain('was near its limit');
    expect(why('spent')).toContain('was used up');
    expect(why('dead')).toContain('had its login refused');
    expect(why('blind')).toContain('could not be read after a refused turn');
  });

  it('says a move was asked for by hand, and by whom only when names are on', () => {
    const line = eventMessage(switched({ kind: 'forced', by: 'someone' }), quiet, now);
    expect(line).toBe('ccx auto-switch: moved to the next account, asked for by hand');
    // A user name on this machine is no more for the channel than an account name is.
    expect(line).not.toContain('someone');
    expect(eventMessage(switched({ kind: 'forced', by: 'someone' }), named, now)).toBe(
      'ccx auto-switch: moved from work to personal, asked by someone',
    );
  });

  it('says so when the account left was one picked by hand', () => {
    expect(eventMessage(switched({ kind: 'spent', pickRanOut: true }), quiet, now)).toBe(
      'ccx auto-switch: your pick was used up; moved on to the next account',
    );
    expect(eventMessage(switched({ kind: 'spent', pickRanOut: true }), named, now)).toBe(
      'ccx auto-switch: work, your pick, was used up; moved on to personal',
    );
  });

  it('counts the machines that followed, without naming them', () => {
    const followers = [
      { host: 'my-server', ok: true, detail: 'now on personal' },
      { host: 'laptop', ok: false, detail: 'could not reach it' },
    ];
    const line = eventMessage(switched({ followers }), quiet, now);
    expect(line).toBe(
      'ccx auto-switch: the account in use was near its limit; moved to the next account; 1 of 2 other machines followed',
    );
    expect(line).not.toContain('my-server');
    expect(eventMessage(switched({ followers: followers.slice(0, 1) }), quiet, now)).toContain('1 of 1 other machine followed');
  });

  it('starts with the label, to tell one machine from another', () => {
    expect(eventMessage(switched(), { label: 'my-server', nameAccounts: false }, now)).toMatch(/^\[my-server\] ccx auto-switch: /);
  });
});

describe('the message for an incident', () => {
  it('says nothing has room, and when something will', () => {
    const event: WatchEvent = { type: 'no-room', account: 'work', until: now + 90 * 60_000 };
    expect(eventMessage(event, quiet, now)).toBe(
      'ccx auto-switch: no account has room (the soonest opens in 1h 30m); staying on the account in use',
    );
    expect(eventMessage(event, named, now)).toContain('staying on work');
    expect(eventMessage({ ...event, until: null }, quiet, now)).toBe(
      'ccx auto-switch: no account has room; staying on the account in use',
    );
  });

  it('says when the watcher on another machine had stopped, or its machine went quiet, naming no host', () => {
    expect(eventMessage({ type: 'watcher-down' }, quiet, now)).toBe(
      'ccx auto-switch: the watcher this machine looks after was not running; a pass was run there from here',
    );
    expect(eventMessage({ type: 'watcher-unreachable', forMs: 5 * 60_000 }, { label: 'laptop', nameAccounts: true }, now)).toBe(
      '[laptop] ccx auto-switch: the machine the watcher runs on has not answered for 5 min',
    );
  });
});

describe('posting to Slack', () => {
  const HOOK = 'https://hooks.slack.example/services/T000/B000/XXXX';

  it('sends the line as JSON, with Slack\'s three markup characters escaped', async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as typeof fetch;

    expect(await postToSlack(HOOK, '[a<b>&c] moved', fakeFetch)).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(HOOK);
    expect(sent[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ text: '[a&lt;b&gt;&amp;c] moved' });
  });

  it('reports a refusal by its status', async () => {
    const fakeFetch = (() => Promise.resolve(new Response('no_service', { status: 404 }))) as typeof fetch;
    expect(await postToSlack(HOOK, 'moved', fakeFetch)).toEqual({ ok: false, detail: 'status 404' });
  });

  it('never throws, and never repeats the address in what went wrong', async () => {
    const fakeFetch = (() => Promise.reject(new Error(`connect ECONNREFUSED ${HOOK}`))) as typeof fetch;
    const result = await postToSlack(HOOK, 'moved', fakeFetch);
    expect(result).toEqual({ ok: false, detail: 'could not reach it' });
    expect(JSON.stringify(result)).not.toContain('XXXX');
  });
});

describe('the webhook address', () => {
  let home: string;
  let ctx: PathCtx;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ccx-autoswitch-notify-'));
    ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('must be https, and carry no user name or password', () => {
    expect(checkWebhook(' https://hooks.slack.example/services/T/B/X ')).toBe('https://hooks.slack.example/services/T/B/X');
    expect(() => checkWebhook('http://hooks.slack.example/services/T/B/X')).toThrow('https://');
    expect(() => checkWebhook('hooks.slack.example/services')).toThrow('not an address');
    expect(() => checkWebhook('https://me:secret@hooks.slack.example/x')).toThrow('no user name or password');
  });

  it('is nothing until one is saved', () => {
    expect(readWebhook(ctx)).toBeNull();
  });

  it('is kept in a file of its own that only its owner can read', () => {
    saveWebhook('https://hooks.slack.example/services/T/B/X', ctx);
    expect(readWebhook(ctx)).toBe('https://hooks.slack.example/services/T/B/X');
    expect(webhookPath(ctx)).toBe(path.join(home, 'autoswitch', 'slack-webhook'));
    if (process.platform !== 'win32') expect(statSync(webhookPath(ctx)).mode & 0o777).toBe(0o600);
  });

  it('is refused before anything is written when it is not one ccx will post to', () => {
    expect(() => saveWebhook('http://insecure.example/x', ctx)).toThrow();
    expect(readWebhook(ctx)).toBeNull();
  });

  it('can be cleared, and clearing twice is fine', () => {
    saveWebhook('https://hooks.slack.example/services/T/B/X', ctx);
    clearWebhook(ctx);
    clearWebhook(ctx);
    expect(readWebhook(ctx)).toBeNull();
  });

  it('reads a file edited into something else as no address', () => {
    saveWebhook('https://hooks.slack.example/services/T/B/X', ctx);
    writeFileSync(webhookPath(ctx), 'not an address\n');
    expect(readWebhook(ctx)).toBeNull();
  });

  it('is shown by its host alone', () => {
    expect(webhookHost('https://hooks.slack.example/services/T/B/X')).toBe('hooks.slack.example');
  });
});
