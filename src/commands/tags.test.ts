import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTagsFromText, tagCommand, untagCommand, tagsCommand } from './tags.js';
import { enableCommand, disableCommand } from './account-config.js';
import { addAccount, getAccount, listAccounts } from '../accounts/registry.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

function setup(json = false): { c: CliContext; said: string[] } {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-tags-')) } };
  const said: string[] = [];
  const c: CliContext = { ctx, config: loadConfig(ctx), out: (m: string) => said.push(m), json, quiet: false };
  for (const name of ['work', 'lent', 'spare']) addAccount({ name, dir: `/${name}` }, ctx);
  return { c, said };
}
const tagsOf = (c: CliContext, name: string) => getAccount(name, c.ctx)?.tags;

describe('ccx tag', () => {
  it('adds tags to an account, lowercased, once each, and says what it now carries', () => {
    const { c, said } = setup();
    expect(tagCommand(c, 'lent', ['Pat', 'bot'])).toBe(0);
    expect(tagCommand(c, 'lent', ['pat'])).toBe(0);
    expect(tagsOf(c, 'lent')).toEqual(['bot', 'pat']);
    expect(said.at(-1)).toBe('"lent" is tagged #bot #pat');
  });

  it('refuses a bad tag and changes nothing', () => {
    const { c, said } = setup();
    expect(tagCommand(c, 'lent', ['pat', 'b@d'])).toBe(1);
    expect(tagsOf(c, 'lent')).toBeUndefined();
    expect(said.at(-1)).toContain('"b@d" is not a tag');
  });

  it('refuses an account that is not there, and a call with no tags', () => {
    const { c, said } = setup();
    expect(tagCommand(c, 'nobody', ['pat'])).toBe(1);
    expect(said.at(-1)).toBe('account "nobody" not found');
    expect(tagCommand(c, 'lent', [])).toBe(1);
  });
});

describe('ccx untag', () => {
  it('removes the tags named, or all of them', () => {
    const { c, said } = setup();
    tagCommand(c, 'lent', ['pat', 'bot', 'stephen']);
    expect(untagCommand(c, 'lent', ['BOT'])).toBe(0);
    expect(tagsOf(c, 'lent')).toEqual(['pat', 'stephen']);
    expect(untagCommand(c, 'lent', [], { all: true })).toBe(0);
    expect(tagsOf(c, 'lent')).toBeUndefined();
    expect(said.at(-1)).toBe('"lent" has no tags');
  });

  it('asks for the tags or --all, not both and not neither', () => {
    const { c } = setup();
    tagCommand(c, 'lent', ['pat']);
    expect(untagCommand(c, 'lent', [])).toBe(1);
    expect(untagCommand(c, 'lent', ['pat'], { all: true })).toBe(1);
    expect(tagsOf(c, 'lent')).toEqual(['pat']);
  });
});

describe('ccx tags', () => {
  it('lists every tag in use with its accounts, saying which are disabled', () => {
    const { c, said } = setup();
    tagCommand(c, 'lent', ['pat', 'bot']);
    tagCommand(c, 'spare', ['bot']);
    disableCommand(c, 'lent');
    said.length = 0;
    expect(tagsCommand(c)).toBe(0);
    expect(said).toEqual(['#bot  lent (disabled), spare', '#pat  lent (disabled)']);
  });

  it('says how to start when nothing is tagged', () => {
    const { c, said } = setup();
    expect(tagsCommand(c)).toBe(0);
    expect(said).toEqual(['no account has a tag yet (ccx tag <account> <tag>)']);
  });

  it('as JSON, gives each tag with its accounts', () => {
    const { c, said } = setup(true);
    tagCommand({ ...c, json: false, out: () => {} }, 'lent', ['pat']);
    expect(tagsCommand(c)).toBe(0);
    expect(JSON.parse(said.at(-1) ?? '')).toEqual({
      schemaVersion: 1,
      tags: [{ tag: 'pat', accounts: [{ name: 'lent', enabled: true }] }],
    });
  });
});

describe('ccx enable and disable, by tag', () => {
  it('act on every account carrying all the tags given', () => {
    const { c, said } = setup();
    tagCommand(c, 'lent', ['pat', 'bot']);
    tagCommand(c, 'spare', ['pat']);
    said.length = 0;
    expect(disableCommand(c, undefined, { tagged: ['pat'] })).toBe(0);
    expect(listAccounts(c.ctx).filter((a) => !a.enabled).map((a) => a.name)).toEqual(['lent', 'spare']);
    expect(said).toEqual(['disabled "lent"', 'disabled "spare"']);
    expect(enableCommand(c, undefined, { tagged: ['pat', 'bot'] })).toBe(0);
    expect(getAccount('lent', c.ctx)?.enabled).toBe(true);
    expect(getAccount('spare', c.ctx)?.enabled).toBe(false);
  });

  it('change nothing and name the tags in use when no account carries the tag', () => {
    const { c, said } = setup();
    tagCommand(c, 'lent', ['pat']);
    expect(disableCommand(c, undefined, { tagged: ['bob'] })).toBe(1);
    expect(listAccounts(c.ctx).every((a) => a.enabled)).toBe(true);
    expect(said.at(-1)).toBe('no account carries #bob (tags in use: #pat)');
  });

  it('take a name or --tagged, not both and not neither', () => {
    const { c } = setup();
    tagCommand(c, 'lent', ['pat']);
    expect(disableCommand(c, 'lent', { tagged: ['pat'] })).toBe(1);
    expect(disableCommand(c, undefined)).toBe(1);
    expect(getAccount('lent', c.ctx)?.enabled).toBe(true);
  });

  it('disable and tag in one step', () => {
    const { c, said } = setup();
    expect(disableCommand(c, 'lent', { tag: ['Pat'] })).toBe(0);
    expect(getAccount('lent', c.ctx)).toMatchObject({ enabled: false, tags: ['pat'] });
    expect(said.at(-1)).toBe('disabled "lent" (tagged #pat)');
  });

  it('refuse a bad tag before disabling anything', () => {
    const { c } = setup();
    expect(disableCommand(c, 'lent', { tag: ['b@d'] })).toBe(1);
    expect(getAccount('lent', c.ctx)?.enabled).toBe(true);
  });
});

describe("the dashboard's tags box", () => {
  it('replaces the tags with the ones typed, and clears them when empty', () => {
    const { c } = setup();
    tagCommand(c, 'lent', ['bot']);
    expect(setTagsFromText(c, 'lent', 'Pat, stephen')).toBe('"lent" is tagged #pat #stephen');
    expect(tagsOf(c, 'lent')).toEqual(['pat', 'stephen']);
    expect(setTagsFromText(c, 'lent', '  ')).toBe('"lent" has no tags');
    expect(tagsOf(c, 'lent')).toBeUndefined();
  });

  it('throws for a bad tag, so the box stays open with the reason, and changes nothing', () => {
    const { c } = setup();
    tagCommand(c, 'lent', ['bot']);
    expect(() => setTagsFromText(c, 'lent', 'pat b@d')).toThrow(/"b@d" is not a tag/);
    expect(tagsOf(c, 'lent')).toEqual(['bot']);
  });
});
