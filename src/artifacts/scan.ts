import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * `ccx artifacts scan`: asking each account for the pages it already has, so
 * the ones published before ccx kept a record get an owner.
 *
 * Only Claude's own Artifact tool can list an account's pages, so the scan is
 * one headless Claude told to list its pages once per account. The hook gives
 * each of those calls the next account in the plan and has the session moved
 * there for the length of it, the same way a page is published as another
 * account. What the plan and the results are kept in is a folder of the
 * scan's own, named to the hook in its environment.
 *
 * Best effort: a headless Claude only has the Artifact tool with an
 * undocumented variable set, and the scan depends on the model making the
 * calls it was asked for.
 */

/** Names the scan's folder to the hook Claude runs. Set only for the scan's own Claude. */
export const SCAN_ENV = 'CCX_ARTIFACT_SCAN';

/** One account's turn in the scan, by its place in the plan. */
export interface ScanTurn {
  index: number;
  account: string;
}

export type ScanResult =
  | { account: string; listed: number; total: number | null }
  | { account: string; error: string };

const planFile = (dir: string): string => path.join(dir, 'plan.json');
const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '');

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Start a scan in `dir`: the accounts to list, in order. */
export function writePlan(dir: string, accounts: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(planFile(dir), JSON.stringify({ accounts }), 'utf8');
}

export function readPlan(dir: string): string[] {
  const plan = readJson(planFile(dir)) as { accounts?: unknown } | null;
  return Array.isArray(plan?.accounts) ? plan.accounts.filter((a): a is string => typeof a === 'string') : [];
}

/**
 * Give call `id` the next account nobody has taken, or null when every one
 * has been. Taking is creating a file that must not exist yet, so two calls
 * made at once never get the same account.
 */
export function claimTurn(dir: string, id: string): ScanTurn | null {
  // A hook run twice for one call (it can be installed in two places) gets the turn it already has.
  const mine = turnOf(dir, id);
  if (mine) return mine;
  const accounts = readPlan(dir);
  for (let index = 0; index < accounts.length; index += 1) {
    try {
      writeFileSync(path.join(dir, `turn-${index}`), id, { encoding: 'utf8', flag: 'wx' });
    } catch {
      continue; // taken
    }
    const turn = { index, account: accounts[index] as string };
    writeFileSync(path.join(dir, `call-${safe(id)}.json`), JSON.stringify(turn), 'utf8');
    return turn;
  }
  return null;
}

/** The turn call `id` was given before it was made. */
export function turnOf(dir: string, id: string): ScanTurn | null {
  const turn = readJson(path.join(dir, `call-${safe(id)}.json`)) as { index?: unknown; account?: unknown } | null;
  return typeof turn?.index === 'number' && typeof turn.account === 'string'
    ? { index: turn.index, account: turn.account }
    : null;
}

export function writeResult(dir: string, index: number, result: ScanResult): void {
  try {
    writeFileSync(path.join(dir, `result-${index}.json`), JSON.stringify(result), 'utf8');
  } catch {
    /* the scan reports the account as not listed */
  }
}

/** What came of each account in the plan, in its order; null for one never reached. */
export function readResults(dir: string): Array<{ account: string; result: ScanResult | null }> {
  return readPlan(dir).map((account, index) => {
    const raw = readJson(path.join(dir, `result-${index}.json`)) as Record<string, unknown> | null;
    if (!raw || raw.account !== account) return { account, result: null };
    if (typeof raw.error === 'string') return { account, result: { account, error: raw.error } };
    if (typeof raw.listed === 'number') {
      return { account, result: { account, listed: raw.listed, total: typeof raw.total === 'number' ? raw.total : null } };
    }
    return { account, result: null };
  });
}

/** The pages in the Artifact tool's answer to `list`: each one's link and title. */
export function listedPages(response: unknown): { pages: Array<{ url: string; title: string | null }>; total: number | null } | null {
  if (typeof response !== 'object' || response === null) return null;
  const { artifacts, total } = response as { artifacts?: unknown; total?: unknown };
  if (!Array.isArray(artifacts)) return null;
  const pages: Array<{ url: string; title: string | null }> = [];
  for (const item of artifacts) {
    const url = (item as { url?: unknown } | null)?.url;
    const title = (item as { title?: unknown } | null)?.title;
    if (typeof url === 'string' && url.length > 0) {
      pages.push({ url, title: typeof title === 'string' && title.length > 0 ? title : null });
    }
  }
  return { pages, total: typeof total === 'number' ? total : null };
}
