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
  sources: [{ session: SESSION, file: FILE, at: 1 }],
  ...over,
});

const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  call: readCall({ file_path: FILE }, null),
  settings: { home: 'home', updates: 'owner' },
  sessionAccount: 'work',
  sessionId: SESSION,
  pages: [],
  registered: () => true,
  ...over,
});

describe('reading an Artifact call', () => {
  it('is a publish when no action is named, as most are', () => {
    expect(readCall({ file_path: FILE, icon: 'chart' }, null)).toEqual({
      action: 'publish',
      url: null,
      file: FILE,
    });
  });

  it('keeps the link of the page a call names', () => {
    expect(readCall({ action: 'read', url: URL }, null)).toEqual({ action: 'read', url: URL, file: null });
    expect(readCall({ file_path: FILE, url: URL }, null).url).toBe(URL);
  });

  it('resolves a relative file against the folder Claude is in', () => {
    const cwd = path.resolve('some', 'project');
    expect(readCall({ file_path: 'out/page.html' }, cwd).file).toBe(path.join(cwd, 'out', 'page.html'));
  });

  it('reads nothing from an input that is not an object', () => {
    expect(readCall(null, null)).toEqual({ action: 'publish', url: null, file: null });
    expect(readCall('publish', null)).toEqual({ action: 'publish', url: null, file: null });
    expect(readCall({ action: 7, url: 7, file_path: 7 }, null)).toEqual({ action: 'publish', url: null, file: null });
  });
});

describe('where a call goes', () => {
  describe('a new page', () => {
    it('goes to the home account, whatever account the session is on', () => {
      expect(decideRoute(input())).toEqual({ kind: 'hop', to: 'home', why: 'home', page: null });
    });

    it('needs no move when the session is already on the home account', () => {
      expect(decideRoute(input({ sessionAccount: 'home' }))).toEqual({ kind: 'stay', account: 'home', why: 'home' });
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

    it('made from a type, with no file at all, goes home too', () => {
      const call = readCall({ type_url: 'https://claude.ai/artifact/type', title: 'Deck' }, null);
      expect(decideRoute(input({ call }))).toMatchObject({ kind: 'hop', to: 'home' });
    });
  });

  describe('an update that names its page', () => {
    const call = readCall({ file_path: FILE, url: URL }, null);

    it('goes to the account that owns the page', () => {
      const pages = [page({ owner: 'personal' })];
      expect(decideRoute(input({ call, pages }))).toEqual({ kind: 'hop', to: 'personal', why: 'owner', page: pages[0] });
    });

    it('goes to the owner, not to the home account, when the two differ', () => {
      expect(decideRoute(input({ call, pages: [page({ owner: 'personal' })] }))).toMatchObject({ to: 'personal' });
    });

    it('needs no move when this session is on the account that owns the page', () => {
      expect(decideRoute(input({ call, pages: [page({ owner: 'work' })] }))).toEqual({
        kind: 'stay',
        account: 'work',
        why: 'owner',
      });
    });

    it('is left alone when updates are not routed and the page is on some other account', () => {
      const settings = { home: 'home', updates: 'off' } as const;
      expect(decideRoute(input({ call, settings, pages: [page({ owner: 'personal' })] }))).toEqual({ kind: 'none' });
    });

    it('follows a page to the home account with only that set, or the session that made it could never change it', () => {
      const settings = { home: 'home', updates: 'off' } as const;
      const pages = [page({ owner: 'home' })];
      expect(decideRoute(input({ call, settings, pages }))).toEqual({ kind: 'hop', to: 'home', why: 'home', page: pages[0] });
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

    it('covers an upload to a page, which names the page the same way', () => {
      const upload = readCall({ url: URL, file_path: path.resolve('logo.png'), asset: true }, null);
      expect(decideRoute(input({ call: upload, pages: [page({ owner: 'personal' })] }))).toMatchObject({
        kind: 'hop',
        to: 'personal',
        why: 'owner',
      });
    });
  });

  describe('an update that names only its file', () => {
    it('goes to the owner of the page this conversation published that file to', () => {
      const pages = [page({ owner: 'personal' })];
      expect(decideRoute(input({ pages }))).toEqual({ kind: 'hop', to: 'personal', why: 'owner', page: pages[0] });
    });

    it('is a new page for another conversation, which never published it', () => {
      const pages = [page({ owner: 'personal' })];
      expect(decideRoute(input({ pages, sessionId: 'another' }))).toMatchObject({ kind: 'hop', to: 'home', why: 'home' });
    });

    it('is left alone when updates are not routed and the page is on some other account: it is not a new page', () => {
      const settings = { home: 'home', updates: 'off' } as const;
      expect(decideRoute(input({ settings, pages: [page({ owner: 'personal' })] }))).toEqual({ kind: 'none' });
    });

    it('follows the page it published a moment ago to the home account, with only that set', () => {
      const settings = { home: 'home', updates: 'off' } as const;
      expect(decideRoute(input({ settings, pages: [page({ owner: 'home' })] }))).toMatchObject({
        kind: 'hop',
        to: 'home',
        why: 'home',
      });
    });

    it('goes through unchanged when the page is recorded with no owner', () => {
      expect(decideRoute(input({ pages: [page({ owner: null })] }))).toEqual({ kind: 'unknown-owner', url: URL });
    });
  });

  describe('reading a page', () => {
    const call = readCall({ action: 'read', url: URL }, null);

    it('goes to its owner, since nobody else can read a private page', () => {
      expect(decideRoute(input({ call, pages: [page({ owner: 'personal' })] }))).toMatchObject({
        kind: 'hop',
        to: 'personal',
        why: 'owner',
      });
    });

    it('is left alone, in silence, for a page nothing is recorded about: it may be somebody else’s', () => {
      expect(decideRoute(input({ call }))).toEqual({ kind: 'none' });
    });

    it('is left alone when updates are not routed, unless the page is on the home account', () => {
      const settings = { home: 'home', updates: 'off' } as const;
      expect(decideRoute(input({ call, settings, pages: [page({ owner: 'personal' })] }))).toEqual({ kind: 'none' });
      expect(decideRoute(input({ call, settings, pages: [page({ owner: 'home' })] }))).toMatchObject({
        kind: 'hop',
        to: 'home',
      });
    });
  });

  it('leaves every other action alone', () => {
    for (const action of ['list', 'delete', 'open', 'pin', 'unpin', 'quickstart', 'something-new']) {
      const call = readCall({ action, url: URL }, null);
      expect(decideRoute(input({ call, pages: [page({ owner: 'personal' })] })), action).toEqual({ kind: 'none' });
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
