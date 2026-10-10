import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { configHome, type PathCtx } from '../config/paths.js';

/**
 * Which account owns each page Claude's Artifact tool published.
 *
 * Claude's answer to a publish names the page and not the account, and a page
 * can only be updated by the account that owns it, so ccx writes down the
 * account each one went out as. One line per publish, appended: several
 * sessions write here at once, and an append never rewrites another's line.
 */

export interface PageRow {
  /** The page's link, as Claude gave it. */
  url: string;
  /** Claude's own id for the page, which the other form of its link carries. */
  id: string | null;
  title: string | null;
  /** The account it was published as; null when that could not be told for certain. */
  owner: string | null;
  /** The conversation that published it. */
  session: string | null;
  /** The file it was published from. */
  file: string | null;
  at: number;
  /** A publish ccx saw, or a listing of the account's own pages (`ccx artifacts scan`). */
  via: 'publish' | 'scan';
}

/** One page, from every row about it. */
export interface Page {
  key: string;
  url: string;
  id: string | null;
  title: string | null;
  owner: string | null;
  /** Who published it last, and from what. */
  session: string | null;
  file: string | null;
  firstAt: number;
  at: number;
  via: 'publish' | 'scan';
  /** Each conversation and file it was published from, with when that last was. */
  sources: Array<{ session: string; file: string; at: number }>;
}

export function recordPath(c: PathCtx = {}): string {
  return path.join(configHome(c), 'artifacts.jsonl');
}

/**
 * What follows `artifact/` in a page's link: `claude.ai/artifact/<id>` and
 * `claude.ai/code/artifact/<uuid>` are both links to a page. Null for anything
 * else.
 */
export function pageKey(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const match = /(?:^|[/.])claude\.ai\/(?:[a-z]+\/)*artifact\/([A-Za-z0-9_-]+)/.exec(url);
  return match?.[1] ?? null;
}

/** Write down one publish. Never throws: a page that could not be recorded is only an unknown one later. */
export function appendPage(row: PageRow, c: PathCtx = {}): void {
  if (pageKey(row.url) === null) return;
  try {
    const file = recordPath(c);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* best effort */
  }
}

/**
 * An account was renamed: the pages recorded as its own are the new name's
 * from here on. One more line, so nobody's rows are rewritten under them.
 */
export function renamePageOwner(from: string, to: string, c: PathCtx = {}, at: number = Date.now()): void {
  try {
    const file = recordPath(c);
    if (!existsSync(file)) return;
    appendFileSync(file, `${JSON.stringify({ renamed: { from, to }, at })}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* best effort: `ccx artifacts scan` names the owners again */
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

type Line = { row: PageRow } | { renamed: { from: string; to: string }; at: number };

function lineOf(line: string): Line | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // a line cut short, or not ours
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  const renamed = r.renamed as { from?: unknown; to?: unknown } | undefined;
  if (typeof renamed === 'object' && renamed !== null) {
    const from = text(renamed.from);
    const to = text(renamed.to);
    return from && to && typeof r.at === 'number' ? { renamed: { from, to }, at: r.at } : null;
  }
  const row = rowOf(r);
  return row ? { row } : null;
}

function rowOf(r: Record<string, unknown>): PageRow | null {
  if (pageKey(r.url) === null || typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  return {
    url: r.url as string,
    id: text(r.id),
    title: text(r.title),
    owner: text(r.owner),
    session: text(r.session),
    file: text(r.file),
    at: r.at,
    via: r.via === 'scan' ? 'scan' : 'publish',
  };
}

/** Every recorded page, the least recently published first. */
export function readPages(c: PathCtx = {}): Page[] {
  let lines: string[];
  try {
    lines = readFileSync(recordPath(c), 'utf8').split('\n');
  } catch {
    return []; // nothing recorded yet
  }
  const pages = new Map<string, Page>();
  /** A page's two names, so a row that knows only one of them finds it. */
  const byId = new Map<string, string>();
  const whenOf = (line: Line): number => ('row' in line ? line.row.at : line.at);
  const read = lines
    .map((line) => (line.trim() === '' ? null : lineOf(line)))
    .filter((l): l is Line => l !== null)
    .sort((a, b) => whenOf(a) - whenOf(b));
  for (const line of read) {
    if (!('row' in line)) {
      for (const page of pages.values()) if (page.owner === line.renamed.from) page.owner = line.renamed.to;
      continue;
    }
    const { row } = line;
    const named = pageKey(row.url) as string;
    const key = pages.has(named) ? named : (byId.get(named) ?? (row.id ? byId.get(row.id) : undefined) ?? named);
    const page = pages.get(key);
    if (!page) {
      pages.set(key, {
        key,
        url: row.url,
        id: row.id,
        title: row.title,
        owner: row.owner,
        session: row.session,
        file: row.file,
        firstAt: row.at,
        at: row.at,
        via: row.via,
        sources: row.session && row.file ? [{ session: row.session, file: row.file, at: row.at }] : [],
      });
      if (row.id) byId.set(row.id, key);
      continue;
    }
    page.at = row.at;
    page.via = row.via;
    page.id = row.id ?? page.id;
    page.title = row.title ?? page.title;
    // The newest owner anyone was sure of. A row that could not tell says
    // nothing against the one before it.
    page.owner = row.owner ?? page.owner;
    page.session = row.session ?? page.session;
    page.file = row.file ?? page.file;
    if (row.id) byId.set(row.id, key);
    if (row.session && row.file) {
      const source = page.sources.find((s) => s.session === row.session && sameFile(s.file, row.file as string));
      if (source) source.at = row.at;
      else page.sources.push({ session: row.session, file: row.file, at: row.at });
    }
  }
  return [...pages.values()].sort((a, b) => a.at - b.at);
}

function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  if (process.platform !== 'win32') return false;
  const fold = (p: string): string => p.split('\\').join('/').toLowerCase();
  return fold(a) === fold(b);
}

/** The recorded page a link names, by either form of its link. */
export function findPage(pages: readonly Page[], url: unknown): Page | null {
  const key = pageKey(url);
  if (key === null) return null;
  return pages.find((p) => p.key === key || p.id === key || pageKey(p.url) === key) ?? null;
}

/**
 * The page this conversation last published this file to. Claude sends an
 * update to a page it made earlier in the conversation with the file alone
 * and no link, so this is the only way most updates can be told from a new
 * page.
 */
export function findRepublished(pages: readonly Page[], session: string | null, file: string | null): Page | null {
  if (!session || !file) return null;
  let found: { page: Page; at: number } | null = null;
  for (const page of pages) {
    for (const source of page.sources) {
      if (source.session !== session || !sameFile(source.file, file)) continue;
      if (!found || source.at > found.at) found = { page, at: source.at };
    }
  }
  return found?.page ?? null;
}
