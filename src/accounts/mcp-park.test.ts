import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CREDENTIALS_LOCK_DIR } from '../claude/locks.js';
import { runBlocking } from '../util/steps.js';
import { credentialPath } from './credential-vault.js';
import type { KeychainIo } from './keychain-view.js';
import { parkMcpLoginsSteps } from './mcp-park.js';

const claude = (n: number) => ({
  accessToken: `a-${n}`,
  refreshToken: `r-${n}`,
  expiresAt: 1_800_000_000_000 + n,
});
const notion = (n: number) => ({
  'notion|1': { accessToken: `mcp-access-fake-${n}`, refreshToken: `mcp-refresh-fake-${n}` },
});
const datadog = (n: number) => ({
  'datadog|2': { accessToken: `dd-access-fake-${n}`, refreshToken: `dd-refresh-fake-${n}` },
});
const text = (value: unknown): string => JSON.stringify(value);
const mcpOf = (value: string | null): unknown =>
  (JSON.parse(value ?? 'null') as { mcpOAuth?: unknown } | null)?.mcpOAuth;

/** The Keychain as a map the steps reach, never the real one. */
const items = new Map<string, string>();
const io: KeychainIo = {
  read: (dir) => items.get(dir) ?? null,
  write: (dir, value) => {
    items.set(dir, value);
  },
  remove: (dir) => {
    items.delete(dir);
  },
};

beforeEach(() => {
  items.clear();
});

/** An account's folder, its saved login in the file when given. */
function account(saved: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-mcp-park-'));
  if (saved !== null) writeFileSync(credentialPath(dir), saved);
  return dir;
}
const savedIn = (dir: string): string => readFileSync(credentialPath(dir), 'utf8');
const park = (dir: string, ending: string, waitMs?: number): boolean =>
  runBlocking(parkMcpLoginsSteps(dir, ending, io, waitMs === undefined ? {} : { waitMs }));

describe("an ending folder's MCP sign-ins, parked in an account's saved login on their own", () => {
  it('joins them to those parked, server by server, and leaves the Claude login as it is', () => {
    const dir = account(text({ claudeAiOauth: claude(5), mcpOAuth: notion(1) }));

    expect(park(dir, text({ claudeAiOauth: claude(9), mcpOAuth: datadog(2) }))).toBe(true);

    const saved = JSON.parse(savedIn(dir)) as Record<string, unknown>;
    expect(saved.claudeAiOauth).toEqual(claude(5));
    expect(saved.mcpOAuth).toEqual({ ...notion(1), ...datadog(2) });
  });

  it('replaces the sign-in parked for a server it holds', () => {
    const dir = account(text({ claudeAiOauth: claude(5), mcpOAuth: notion(1) }));

    expect(park(dir, text({ mcpOAuth: notion(3) }))).toBe(true);

    expect(mcpOf(savedIn(dir))).toEqual(notion(3));
  });

  it('takes the Keychain item when the account keeps its login there, and leaves the file alone', () => {
    const dir = account(null);
    items.set(dir, text({ claudeAiOauth: claude(5), mcpOAuth: notion(1) }));

    expect(park(dir, text({ mcpOAuth: datadog(2) }))).toBe(true);

    expect(mcpOf(items.get(dir) ?? null)).toEqual({ ...notion(1), ...datadog(2) });
    expect(existsSync(credentialPath(dir))).toBe(false);
  });

  it('starts a saved login of their own when the account has none, which is no Claude login', () => {
    const dir = account(null);

    expect(park(dir, text({ mcpOAuth: notion(3) }))).toBe(true);

    expect(JSON.parse(savedIn(dir))).toEqual({ mcpOAuth: notion(3) });
  });

  it('writes nothing, and takes no lock, when the ending text holds none', () => {
    const saved = text({ claudeAiOauth: claude(5), mcpOAuth: notion(1) });
    const dir = account(saved);
    // Someone is changing the saved login: a store with nothing to park does not wait for them.
    mkdirSync(path.join(dir, CREDENTIALS_LOCK_DIR));

    expect(park(dir, text({ claudeAiOauth: claude(9) }), 0)).toBe(false);
    expect(park(dir, text({ claudeAiOauth: claude(9), mcpOAuth: {} }), 0)).toBe(false);

    expect(savedIn(dir)).toBe(saved);
  });

  it('writes nothing when the saved login holds them already', () => {
    const saved = `${JSON.stringify({ claudeAiOauth: claude(5), mcpOAuth: { ...notion(1), ...datadog(2) } }, null, 2)}\n`;
    const dir = account(saved);

    expect(park(dir, text({ mcpOAuth: datadog(2) }))).toBe(false);

    expect(savedIn(dir)).toBe(saved);
  });

  it("keeps a sign-in parked for a server when it expires later than the ending folder's", () => {
    const refreshed = { 'notion|1': { ...notion(2)['notion|1'], expiresAt: 1_900_003_600_000 } };
    const untouched = { 'notion|1': { ...notion(1)['notion|1'], expiresAt: 1_900_000_000_000 } };
    const saved = text({ claudeAiOauth: claude(5), mcpOAuth: refreshed });
    const dir = account(saved);

    expect(park(dir, text({ mcpOAuth: untouched }))).toBe(false);

    expect(savedIn(dir)).toBe(saved);
  });

  it("replaces a sign-in parked for a server when it expires earlier than the ending folder's", () => {
    const refreshed = { 'notion|1': { ...notion(2)['notion|1'], expiresAt: 1_900_003_600_000 } };
    const untouched = { 'notion|1': { ...notion(1)['notion|1'], expiresAt: 1_900_000_000_000 } };
    const dir = account(text({ claudeAiOauth: claude(5), mcpOAuth: untouched }));

    expect(park(dir, text({ mcpOAuth: refreshed }))).toBe(true);

    expect(mcpOf(savedIn(dir))).toEqual(refreshed);
  });

  it('merges with the saved login as it is when it is written, not as it was first read', () => {
    const dir = account(null);
    const first = text({ claudeAiOauth: claude(5), mcpOAuth: notion(1) });
    // The account's login is saved in the Keychain, and another store parks Datadog there just after it is first read.
    items.set(dir, first);
    let reads = 0;
    const racing: KeychainIo = {
      ...io,
      read: (item) => {
        reads += 1;
        if (reads === 2)
          items.set(
            item,
            text({ claudeAiOauth: claude(5), mcpOAuth: { ...notion(1), ...datadog(7) } }),
          );
        return items.get(item) ?? null;
      },
    };

    expect(runBlocking(parkMcpLoginsSteps(dir, text({ mcpOAuth: notion(3) }), racing))).toBe(true);

    expect(mcpOf(items.get(dir) ?? null)).toEqual({ ...notion(3), ...datadog(7) });
  });

  it('does not write back a login that was removed between its two reads', () => {
    const dir = account(null);
    const removedMeanwhile = text({ claudeAiOauth: claude(5), mcpOAuth: notion(1) });
    // The account's login is in the Keychain when first read, and gone by the time it is written.
    let reads = 0;
    const emptied: KeychainIo = { ...io, read: () => (++reads === 1 ? removedMeanwhile : null) };

    expect(runBlocking(parkMcpLoginsSteps(dir, text({ mcpOAuth: datadog(2) }), emptied))).toBe(
      true,
    );

    expect(JSON.parse(savedIn(dir))).toEqual({ mcpOAuth: datadog(2) });
  });

  it('throws, writing nothing, when the saved login is being changed by someone else', () => {
    const saved = text({ claudeAiOauth: claude(5), mcpOAuth: notion(1) });
    const dir = account(saved);
    mkdirSync(path.join(dir, CREDENTIALS_LOCK_DIR));

    expect(() => park(dir, text({ mcpOAuth: notion(3) }), 0)).toThrow();

    expect(savedIn(dir)).toBe(saved);
  });

  it('throws, writing nothing, when the saved login is not one that can hold them', () => {
    const dir = account('{"claudeAiOauth":');

    expect(() => park(dir, text({ mcpOAuth: notion(3) }))).toThrow();

    expect(savedIn(dir)).toBe('{"claudeAiOauth":');
  });

  it('lets go of the lock, whether it parked or threw', () => {
    const dir = account(text({ claudeAiOauth: claude(5) }));
    park(dir, text({ mcpOAuth: notion(3) }));
    expect(existsSync(path.join(dir, CREDENTIALS_LOCK_DIR))).toBe(false);

    const broken = account('not json');
    expect(() => park(broken, text({ mcpOAuth: notion(3) }))).toThrow();
    expect(existsSync(path.join(broken, CREDENTIALS_LOCK_DIR))).toBe(false);
  });
});
