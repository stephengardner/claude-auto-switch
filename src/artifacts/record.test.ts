import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendPage,
  compactRecord,
  findPage,
  findRepublished,
  pageKey,
  readPages,
  recordDeletion,
  recordPath,
  renamePageOwner,
  type PageRow,
} from './record.js';
import type { PathCtx } from '../config/paths.js';

function ctxOf(): PathCtx {
  return { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-artifact-record-')) } };
}

const row = (over: Partial<PageRow> = {}): PageRow => ({
  url: 'https://claude.ai/artifact/BmhXcGdEGscNbm7Pk1YSPc',
  id: '573916ad-1115-45ad-965e-2c91f5276edb',
  title: 'Shape Lab',
  owner: 'work',
  session: 'e7a0c0de-0000-4000-8000-000000000001',
  file: '/work/pages/shape-lab.html',
  at: 1_000,
  via: 'publish',
  ...over,
});

describe('the key a page is known by', () => {
  it('is what follows artifact/ in its link, in either form of link', () => {
    expect(pageKey('https://claude.ai/artifact/BmhXcGdEGscNbm7Pk1YSPc')).toBe('BmhXcGdEGscNbm7Pk1YSPc');
    expect(pageKey('https://claude.ai/code/artifact/573916ad-1115-45ad-965e-2c91f5276edb')).toBe(
      '573916ad-1115-45ad-965e-2c91f5276edb',
    );
    expect(pageKey('claude.ai/artifact/BmhXcGdEGscNbm7Pk1YSPc?x=1#top')).toBe('BmhXcGdEGscNbm7Pk1YSPc');
    expect(pageKey('https://claude.ai/artifact/BmhXcGdEGscNbm7Pk1YSPc/')).toBe('BmhXcGdEGscNbm7Pk1YSPc');
  });

  it('is nothing for a link that is not a page', () => {
    expect(pageKey('https://claude.ai/chat/1234')).toBeNull();
    expect(pageKey('')).toBeNull();
    expect(pageKey(undefined)).toBeNull();
  });
});

describe('recording published pages', () => {
  it('starts empty, with no file', () => {
    expect(readPages(ctxOf())).toEqual([]);
  });

  it('keeps a page with everything that was recorded about it', () => {
    const ctx = ctxOf();
    appendPage(row(), ctx);
    expect(readPages(ctx)).toEqual([
      {
        key: 'BmhXcGdEGscNbm7Pk1YSPc',
        url: 'https://claude.ai/artifact/BmhXcGdEGscNbm7Pk1YSPc',
        id: '573916ad-1115-45ad-965e-2c91f5276edb',
        title: 'Shape Lab',
        owner: 'work',
        session: 'e7a0c0de-0000-4000-8000-000000000001',
        file: '/work/pages/shape-lab.html',
        firstAt: 1_000,
        at: 1_000,
        via: 'publish',
        deleted: false,
        sources: [{ session: 'e7a0c0de-0000-4000-8000-000000000001', file: '/work/pages/shape-lab.html', at: 1_000 }],
      },
    ]);
  });

  it('folds an update into its page: the newest title and time, the first time kept', () => {
    const ctx = ctxOf();
    appendPage(row(), ctx);
    appendPage(row({ title: 'Shape Lab v2', at: 2_000 }), ctx);
    const pages = readPages(ctx);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ title: 'Shape Lab v2', firstAt: 1_000, at: 2_000 });
  });

  it('keeps the owner it knows when a later row could not tell', () => {
    const ctx = ctxOf();
    appendPage(row(), ctx);
    appendPage(row({ owner: null, at: 2_000 }), ctx);
    expect(readPages(ctx)[0]?.owner).toBe('work');
  });

  it('takes the newest owner anyone was sure of, so a listing of the account corrects a wrong one', () => {
    const ctx = ctxOf();
    appendPage(row({ owner: 'personal' }), ctx);
    appendPage(row({ owner: 'work', at: 2_000, via: 'scan', session: null, file: null }), ctx);
    const page = readPages(ctx)[0];
    expect(page?.owner).toBe('work');
    // A listing knows no file, and must not lose the one a publish recorded.
    expect(page?.file).toBe('/work/pages/shape-lab.html');
  });

  it('lists pages oldest update first', () => {
    const ctx = ctxOf();
    appendPage(row({ url: 'https://claude.ai/artifact/second', id: null, at: 3_000 }), ctx);
    appendPage(row({ url: 'https://claude.ai/artifact/first', id: null, at: 2_000 }), ctx);
    expect(readPages(ctx).map((p) => p.key)).toEqual(['first', 'second']);
  });

  it('skips a line it cannot read, rather than losing the rest', () => {
    const ctx = ctxOf();
    appendPage(row(), ctx);
    appendFileSync(recordPath(ctx), '{"url": "https://claude.ai/artifact/half\n42\n{"no":"url"}\n', 'utf8');
    appendPage(row({ url: 'https://claude.ai/artifact/after', id: null, at: 2_000 }), ctx);
    expect(readPages(ctx).map((p) => p.key)).toEqual(['BmhXcGdEGscNbm7Pk1YSPc', 'after']);
  });

  it('does not record a link that is not a page', () => {
    const ctx = ctxOf();
    appendPage(row({ url: 'https://example.com/x' }), ctx);
    expect(readPages(ctx)).toEqual([]);
  });

  it('writes one line per row, in a file only its owner can read', () => {
    const ctx = ctxOf();
    appendPage(row(), ctx);
    appendPage(row({ at: 2_000 }), ctx);
    expect(readFileSync(recordPath(ctx), 'utf8').trim().split('\n')).toHaveLength(2);
    if (process.platform !== 'win32') expect(statSync(recordPath(ctx)).mode & 0o077).toBe(0);
  });
});

describe('an account that is renamed', () => {
  it('keeps its pages: they are the new name\'s from then on', () => {
    const ctx = ctxOf();
    appendPage(row({ owner: 'work' }), ctx);
    appendPage(row({ url: 'https://claude.ai/artifact/other', id: null, owner: 'personal', at: 1_500 }), ctx);
    renamePageOwner('work', 'day-job', ctx, 2_000);
    expect(readPages(ctx).map((p) => [p.key, p.owner])).toEqual([
      ['BmhXcGdEGscNbm7Pk1YSPc', 'day-job'],
      ['other', 'personal'],
    ]);
  });

  it('does not take the pages of an account given the old name afterwards', () => {
    const ctx = ctxOf();
    appendPage(row({ owner: 'work' }), ctx);
    renamePageOwner('work', 'day-job', ctx, 2_000);
    appendPage(row({ url: 'https://claude.ai/artifact/later', id: null, owner: 'work', at: 3_000 }), ctx);
    expect(readPages(ctx).map((p) => [p.key, p.owner])).toEqual([
      ['BmhXcGdEGscNbm7Pk1YSPc', 'day-job'],
      ['later', 'work'],
    ]);
  });

  it('writes nothing when no page is recorded at all', () => {
    const ctx = ctxOf();
    renamePageOwner('work', 'day-job', ctx, 2_000);
    expect(() => readFileSync(recordPath(ctx))).toThrow();
  });
});

describe('finding the page a call is about', () => {
  it('by its link, in either form', () => {
    const ctx = ctxOf();
    appendPage(row(), ctx);
    const pages = readPages(ctx);
    expect(findPage(pages, 'https://claude.ai/artifact/BmhXcGdEGscNbm7Pk1YSPc')?.owner).toBe('work');
    expect(findPage(pages, 'https://claude.ai/code/artifact/573916ad-1115-45ad-965e-2c91f5276edb')?.owner).toBe(
      'work',
    );
    expect(findPage(pages, 'https://claude.ai/artifact/someoneElses')).toBeNull();
    expect(findPage(pages, undefined)).toBeNull();
  });

  it('by the session publishing the same file again, which is how most updates look', () => {
    const ctx = ctxOf();
    appendPage(row(), ctx);
    appendPage(row({ url: 'https://claude.ai/artifact/other', id: null, file: '/work/pages/other.html', at: 2_000 }), ctx);
    const pages = readPages(ctx);
    const session = 'e7a0c0de-0000-4000-8000-000000000001';
    expect(findRepublished(pages, session, '/work/pages/shape-lab.html')?.key).toBe('BmhXcGdEGscNbm7Pk1YSPc');
    expect(findRepublished(pages, session, '/work/pages/other.html')?.key).toBe('other');
  });

  it('not for another session publishing that file, which makes a page of its own', () => {
    const ctx = ctxOf();
    appendPage(row(), ctx);
    expect(findRepublished(readPages(ctx), 'another-session', '/work/pages/shape-lab.html')).toBeNull();
    expect(findRepublished(readPages(ctx), null, '/work/pages/shape-lab.html')).toBeNull();
    expect(findRepublished(readPages(ctx), 'e7a0c0de-0000-4000-8000-000000000001', null)).toBeNull();
  });

  it('takes the page the session last published that file to, when it has published it to two', () => {
    const ctx = ctxOf();
    appendPage(row(), ctx);
    appendPage(row({ url: 'https://claude.ai/artifact/newer', id: null, at: 5_000 }), ctx);
    const found = findRepublished(readPages(ctx), 'e7a0c0de-0000-4000-8000-000000000001', '/work/pages/shape-lab.html');
    expect(found?.key).toBe('newer');
  });

  it('still finds it after another session updated the same page from another file', () => {
    const ctx = ctxOf();
    appendPage(row(), ctx);
    appendPage(row({ session: 'another-session', file: '/elsewhere/copy.html', at: 2_000 }), ctx);
    const pages = readPages(ctx);
    expect(findRepublished(pages, 'e7a0c0de-0000-4000-8000-000000000001', '/work/pages/shape-lab.html')?.key).toBe(
      'BmhXcGdEGscNbm7Pk1YSPc',
    );
    expect(findRepublished(pages, 'another-session', '/elsewhere/copy.html')?.key).toBe('BmhXcGdEGscNbm7Pk1YSPc');
  });
});

describe('a page that is deleted', () => {
  it('is marked deleted, by either form of its link, and found by nothing that routes calls', () => {
    const ctx = ctxOf();
    appendPage(row(), ctx);
    recordDeletion('https://claude.ai/code/artifact/573916ad-1115-45ad-965e-2c91f5276edb', ctx, 2_000);
    const pages = readPages(ctx);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.deleted).toBe(true);
    expect(findPage(pages, 'https://claude.ai/artifact/BmhXcGdEGscNbm7Pk1YSPc')).toBeNull();
    expect(findRepublished(pages, 'e7a0c0de-0000-4000-8000-000000000001', '/work/pages/shape-lab.html')).toBeNull();
  });

  it('is back when a listing of its account shows it again', () => {
    const ctx = ctxOf();
    appendPage(row(), ctx);
    recordDeletion('https://claude.ai/artifact/BmhXcGdEGscNbm7Pk1YSPc', ctx, 2_000);
    appendPage(row({ via: 'scan', session: null, file: null, at: 3_000 }), ctx);
    expect(readPages(ctx)[0]?.deleted).toBe(false);
  });

  it('records nothing for a link that is not a page', () => {
    const ctx = ctxOf();
    recordDeletion('https://example.com/x', ctx, 2_000);
    expect(readPages(ctx)).toEqual([]);
  });
});

describe('keeping the record small', () => {
  it('folds it to what each page needs, leaving what is read from it exactly as it was', () => {
    const ctx = ctxOf();
    for (let i = 0; i < 40; i += 1) {
      appendPage(row({ title: `Shape Lab ${i}`, at: 1_000 + i }), ctx);
      appendPage(row({ url: 'https://claude.ai/artifact/second', id: null, session: 'other', file: '/b.html', at: 1_000 + i }), ctx);
    }
    appendPage(row({ url: 'https://claude.ai/artifact/gone', id: null, at: 5_000 }), ctx);
    recordDeletion('https://claude.ai/artifact/gone', ctx, 6_000);
    renamePageOwner('work', 'day-job', ctx, 7_000);
    const before = readPages(ctx).filter((p) => !p.deleted);
    const linesBefore = readFileSync(recordPath(ctx), 'utf8').trim().split('\n').length;
    compactRecord(ctx);
    const linesAfter = readFileSync(recordPath(ctx), 'utf8').trim().split('\n').length;
    expect(linesBefore).toBe(83);
    // One line per place each page was published from, and the deleted page gone.
    expect(linesAfter).toBe(2);
    expect(readPages(ctx)).toEqual(before);
    expect(readPages(ctx).map((p) => p.owner)).toEqual(['day-job', 'day-job']);
  });

  it('folds by itself once the file passes its size, so the hooks never read a long one', () => {
    const ctx = ctxOf();
    for (let i = 0; i < 30; i += 1) appendPage(row({ title: 'x'.repeat(200), at: 1_000 + i }), ctx, { compactAtBytes: 2_000 });
    expect(readFileSync(recordPath(ctx), 'utf8').trim().split('\n').length).toBeLessThan(10);
    expect(readPages(ctx)).toHaveLength(1);
  });
});
