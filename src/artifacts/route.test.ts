import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { decideRoute, readCall, type RouteInput } from './route.js';
import type { Page } from './record.js';

const SESSION = 'e7a0c0de-0000-4000-8000-000000000001';
const FILE = path.resolve('pages', 'shape-lab.html');
const URL = 'https://claude.ai/artifact/BmhXcGdEGscNbm7Pk1YSPc';

const page = (over: Partial<Page> = {}): Page => ({
  key: 'BmhXcGdEGscNbm7Pk1YSPc',
  url: URL,
  id: '573916ad-1115-45ad-965e-2c91f5276edb',
  title: 'Shape Lab',
  owner: 'home',
  session: SESSION,
  file: FILE,
  firstAt: 1,
  at: 1,
  via: 'publish',
  deleted: false,
  sources: [{ session: SESSION, file: FILE, at: 1 }],
  ...over,
});

const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  call: readCall({ file_path: FILE }, null),
  settings: { home: 'home', updates: 'owner' },
  sessionId: SESSION,
  pages: [],
  registered: () => true,
  ...over,
});

describe('reading an Artifact call', () => {
  it('is a publish when no action is named, as most are', () => {
    expect(readCall({ file_path: FILE, icon: 'chart' }, null)).toEqual({
      action: 'publish',
      kind: 'publish',
      url: null,
      file: FILE,
      typeUrl: null,
    });
  });

  it('keeps the link of the page a call names, and the type a new page is made from', () => {
    expect(readCall({ action: 'read', url: URL }, null)).toMatchObject({ kind: 'read', url: URL, file: null });
    expect(readCall({ file_path: FILE, url: URL }, null).url).toBe(URL);
    expect(readCall({ type_url: 'https://claude.ai/artifact/type', title: 'Deck' }, null)).toMatchObject({
      kind: 'publish',
      typeUrl: 'https://claude.ai/artifact/type',
    });
  });

  it('resolves a relative file against the folder Claude is in', () => {
    const cwd = path.resolve('some', 'project');
    expect(readCall({ file_path: 'out/page.html' }, cwd).file).toBe(path.join(cwd, 'out', 'page.html'));
  });

  it('reads nothing from an input that is not an object', () => {
    const empty = { action: 'publish', kind: 'publish', url: null, file: null, typeUrl: null };
    expect(readCall(null, null)).toEqual(empty);
    expect(readCall('publish', null)).toEqual(empty);
    expect(readCall({ action: 7, url: 7, file_path: 7, type_url: 7 }, null)).toEqual(empty);
  });

  /**
   * Every action Claude Code 2.1.296's Artifact tool knows, copied from its
   * binary, in both of its spellings: the tool turns `publish` with `asset:
   * true` into `upload_asset` (or `copy_from` with `from_url`), `read` with
   * `path` into `read_file` or `read_asset`, `read` with `type_url` alone into
   * `describe_type`, `list` with a scope into `list_files`, `list_assets` or
   * `list_types`, and `delete` with `path` into `delete_asset`, and back again.
   */
  const ARTIFACT_ACTIONS_2_1_296: readonly string[] = [
    ...['publish', 'list', 'read', 'list_types', 'describe_type', 'quickstart', 'live-edit', 'sync', 'version'],
    ...['comments', 'reply', 'resolve', 'watch', 'unwatch', 'status', 'resume_replies', 'read_page_data'],
    ...['verify', 'read_db', 'write_db', 'room_send', 'upload_asset', 'list_assets', 'read_asset', 'delete_asset'],
    ...['copy_from', 'list_files', 'read_file', 'delete', 'preview', 'open', 'get_endpoints', 'call_endpoint'],
    ...['run_script', 'pin', 'unpin', 'share'],
  ];
  it('sorts every action the tool has, in either spelling', () => {
    const kind = (toolInput: Record<string, unknown>): string => readCall(toolInput, null).kind;
    const withUrl = (more: Record<string, unknown>): Record<string, unknown> => ({ url: URL, ...more });
    // Changing a page that is there.
    expect(kind(withUrl({ action: 'upload_asset', file_path: FILE }))).toBe('change');
    expect(kind(withUrl({ file_path: FILE, asset: true }))).toBe('change');
    expect(kind(withUrl({ action: 'publish', file_path: FILE, asset: true }))).toBe('change');
    expect(kind(withUrl({ action: 'copy_from', from_url: 'https://claude.ai/artifact/other', asset_ids: ['a'] }))).toBe('change');
    expect(kind(withUrl({ action: 'delete_asset', asset_id: 'a' }))).toBe('change');
    expect(kind(withUrl({ action: 'delete', path: 'a'.repeat(32) }))).toBe('change');
    expect(kind(withUrl({ action: 'share', mode: 'org', access: 'view' }))).toBe('change');
    // Deleting it.
    expect(kind(withUrl({ action: 'delete' }))).toBe('delete');
    // Reading it.
    const reads = ['read', 'read_file', 'read_asset', 'read_page_data', 'list_files', 'list_assets'];
    for (const action of reads) expect(kind(withUrl({ action })), action).toBe('read');
    expect(kind(withUrl({ action: 'read', path: 'index.html' }))).toBe('read');
    expect(kind(withUrl({ action: 'list', scope: 'files' }))).toBe('read');
    expect(kind(withUrl({ action: 'list', scope: 'assets' }))).toBe('read');
    // Left alone: the session's own account, the person's view, the comments,
    // data and check tools, a page's live code, and what this build refuses.
    const alone = [
      ...['list', 'list_types', 'describe_type', 'quickstart'],
      ...['open', 'pin', 'unpin'],
      ...['comments', 'reply', 'resolve', 'watch', 'unwatch', 'status', 'resume_replies'],
      ...['read_db', 'write_db', 'verify', 'preview'],
      ...['room_send', 'get_endpoints', 'call_endpoint', 'run_script'],
      ...['sync', 'version', 'live-edit'],
    ];
    for (const action of [...alone, 'something-new']) expect(kind(withUrl({ action })), action).toBe('other');
    // The whole of the binary's list, so a new action there is sorted on purpose.
    const sorted = new Set(['publish', 'upload_asset', 'copy_from', 'delete_asset', 'share', 'delete', ...reads, ...alone]);
    expect([...ARTIFACT_ACTIONS_2_1_296].filter((action) => !sorted.has(action))).toEqual([]);
    expect([...sorted].filter((action) => !ARTIFACT_ACTIONS_2_1_296.includes(action))).toEqual([]);
    expect(kind({ action: 'read', type_url: 'https://claude.ai/artifact/type' })).toBe('other');
    expect(kind(withUrl({ action: 'list', scope: 'mine' }))).toBe('other');
    // A page call that names no page cannot be sent to its owner.
    expect(kind({ action: 'read' })).toBe('other');
    expect(kind({ action: 'upload_asset', file_path: FILE })).toBe('other');
    expect(kind({ action: 'delete' })).toBe('other');
  });
});

describe('where a call goes', () => {
  describe('a new page', () => {
    it('goes to the home account, whatever account the session is on', () => {
      expect(decideRoute(input())).toEqual({ kind: 'go', to: 'home', why: 'home', page: null });
    });

    it('is left alone when no home account is set, even with updates routed', () => {
      expect(decideRoute(input({ settings: { home: null, updates: 'owner' } }))).toEqual({ kind: 'none' });
    });

    it('is refused when the home account is not one of the accounts, never published where the session is', () => {
      const route = decideRoute(input({ registered: () => false }));
      expect(route.kind).toBe('refuse');
      expect(route.kind === 'refuse' && route.reason).toContain('artifacts.home');
      expect(route.kind === 'refuse' && route.reason).toContain('"home"');
      expect(route.kind === 'refuse' && route.reason).toContain('ccx config artifacts.home');
    });

    it('made from a type is always new, even from a file this conversation published before', () => {
      const pages = [page({ owner: 'personal' })];
      const call = readCall({ type_url: 'https://claude.ai/artifact/type', file_path: FILE, title: 'Deck' }, null);
      expect(decideRoute(input({ call, pages }))).toEqual({ kind: 'go', to: 'home', why: 'home', page: null });
      expect(decideRoute(input({ call: readCall({ type_url: 'https://claude.ai/artifact/type' }, null) }))).toMatchObject({
        kind: 'go',
        to: 'home',
      });
    });
  });

  describe('an update that names its page', () => {
    const call = readCall({ file_path: FILE, url: URL }, null);

    it('goes to the account that owns the page', () => {
      const pages = [page({ owner: 'personal' })];
      expect(decideRoute(input({ call, pages }))).toEqual({ kind: 'go', to: 'personal', why: 'owner', page: pages[0] });
    });

    it('goes to the owner, not to the home account, when the two differ', () => {
      expect(decideRoute(input({ call, pages: [page({ owner: 'personal' })] }))).toMatchObject({ to: 'personal' });
    });

    it('is left alone when updates are not routed and the page is on some other account', () => {
      const settings = { home: 'home', updates: 'off' } as const;
      expect(decideRoute(input({ call, settings, pages: [page({ owner: 'personal' })] }))).toEqual({ kind: 'none' });
    });

    it('follows a page to the home account with only that set, or the session that made it could never change it', () => {
      const settings = { home: 'home', updates: 'off' } as const;
      const pages = [page({ owner: 'home' })];
      expect(decideRoute(input({ call, settings, pages }))).toEqual({ kind: 'go', to: 'home', why: 'home', page: pages[0] });
    });

    it('says nothing about an unknown owner when updates are not routed', () => {
      const settings = { home: 'home', updates: 'off' } as const;
      expect(decideRoute(input({ call, settings }))).toEqual({ kind: 'none' });
    });

    it('goes through unchanged when nothing recorded who owns the page, and says so', () => {
      expect(decideRoute(input({ call }))).toEqual({ kind: 'unknown-owner', url: URL });
      expect(decideRoute(input({ call, pages: [page({ owner: null })] }))).toEqual({ kind: 'unknown-owner', url: URL });
    });

    it('is refused when its owner is not an account any more', () => {
      const gone = decideRoute(input({ call, pages: [page({ owner: 'personal' })], registered: () => false }));
      expect(gone.kind === 'refuse' && gone.reason).toContain('"personal"');
      expect(gone.kind === 'refuse' && gone.reason).toContain('ccx artifacts scan');
    });

    it('covers every change to a page, in both spellings, and a delete', () => {
      const pages = [page({ owner: 'personal' })];
      for (const toolInput of [
        { url: URL, file_path: path.resolve('logo.png'), asset: true },
        { action: 'upload_asset', url: URL, file_path: path.resolve('logo.png') },
        { action: 'copy_from', url: URL, from_url: 'https://claude.ai/artifact/other', asset_ids: ['a'] },
        { action: 'delete_asset', url: URL, asset_id: 'a' },
        { action: 'share', url: URL, mode: 'org', access: 'view' },
        { action: 'delete', url: URL },
      ]) {
        expect(decideRoute(input({ call: readCall(toolInput, null), pages })), JSON.stringify(toolInput)).toMatchObject({
          kind: 'go',
          to: 'personal',
          why: 'owner',
        });
      }
    });
  });

  describe('an update that names only its file', () => {
    it('goes to the owner of the page this conversation published that file to', () => {
      const pages = [page({ owner: 'personal' })];
      expect(decideRoute(input({ pages }))).toEqual({ kind: 'go', to: 'personal', why: 'owner', page: pages[0] });
    });

    it('is a new page for another conversation, which never published it', () => {
      const pages = [page({ owner: 'personal' })];
      expect(decideRoute(input({ pages, sessionId: 'another' }))).toMatchObject({ kind: 'go', to: 'home', why: 'home' });
    });

    it('is a new page once the page that file went to has been deleted', () => {
      const pages = [page({ owner: 'personal', deleted: true })];
      expect(decideRoute(input({ pages }))).toEqual({ kind: 'go', to: 'home', why: 'home', page: null });
    });

    it('is left alone when updates are not routed and the page is on some other account: it is not a new page', () => {
      const settings = { home: 'home', updates: 'off' } as const;
      expect(decideRoute(input({ settings, pages: [page({ owner: 'personal' })] }))).toEqual({ kind: 'none' });
    });

    it('follows the page it published a moment ago to the home account, with only that set', () => {
      const settings = { home: 'home', updates: 'off' } as const;
      expect(decideRoute(input({ settings, pages: [page({ owner: 'home' })] }))).toMatchObject({
        kind: 'go',
        to: 'home',
        why: 'home',
      });
    });

    it('goes through unchanged when the page is recorded with no owner', () => {
      expect(decideRoute(input({ pages: [page({ owner: null })] }))).toEqual({ kind: 'unknown-owner', url: URL });
    });
  });

  describe('reading a page', () => {
    it('goes to its owner, since nobody else can read a private page, in every spelling', () => {
      const pages = [page({ owner: 'personal' })];
      for (const toolInput of [
        { action: 'read', url: URL },
        { action: 'read', url: URL, path: 'index.html' },
        { action: 'read_file', url: URL, path: 'index.html' },
        { action: 'read_asset', url: URL, asset_id: 'a' },
        { action: 'read_page_data', url: URL, schema: 's' },
        { action: 'list_files', url: URL },
        { action: 'list', url: URL, scope: 'assets' },
      ]) {
        expect(decideRoute(input({ call: readCall(toolInput, null), pages })), JSON.stringify(toolInput)).toMatchObject({
          kind: 'go',
          to: 'personal',
          why: 'owner',
        });
      }
    });

    it('is left alone, in silence, for a page nothing is recorded about: it may be somebody else’s', () => {
      expect(decideRoute(input({ call: readCall({ action: 'read', url: URL }, null) }))).toEqual({ kind: 'none' });
    });

    it('is left alone when updates are not routed, unless the page is on the home account', () => {
      const call = readCall({ action: 'read', url: URL }, null);
      const settings = { home: 'home', updates: 'off' } as const;
      expect(decideRoute(input({ call, settings, pages: [page({ owner: 'personal' })] }))).toEqual({ kind: 'none' });
      expect(decideRoute(input({ call, settings, pages: [page({ owner: 'home' })] }))).toMatchObject({
        kind: 'go',
        to: 'home',
      });
    });

    it('is left alone for a page that has been deleted', () => {
      const call = readCall({ action: 'read', url: URL }, null);
      expect(decideRoute(input({ call, pages: [page({ owner: 'personal', deleted: true })] }))).toEqual({ kind: 'none' });
    });
  });

  it('leaves every other action alone, however it is spelled, and any it does not know', () => {
    const pages = [page({ owner: 'personal' })];
    for (const action of ['list', 'open', 'pin', 'unpin', 'quickstart', 'sync', 'run_script', 'teleport']) {
      const call = readCall({ action, url: URL }, null);
      expect(decideRoute(input({ call, pages })), action).toEqual({ kind: 'none' });
    }
  });

  it('does nothing at all with both settings off', () => {
    const settings = { home: null, updates: 'off' } as const;
    const pages = [page({ owner: 'personal' })];
    for (const toolInput of [{ file_path: FILE }, { file_path: FILE, url: URL }, { action: 'read', url: URL }]) {
      expect(decideRoute(input({ settings, pages, call: readCall(toolInput, null) }))).toEqual({ kind: 'none' });
    }
  });
});
