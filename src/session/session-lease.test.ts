import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { leasePath, takeLease } from './lease.js';
import { sessionLease } from './session-lease.js';
import type { PathCtx } from '../config/paths.js';

function home(): { ctx: PathCtx; dir: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'cas-session-lease-'));
  return { ctx: { env: { CLAUDE_AUTO_SWITCH_HOME: root } }, dir: path.join(root, 'sessions', '4242') };
}

/** An announcement as another process would have written it. */
function announce(ctx: PathCtx, account: string, configDir: unknown, at: number, pid = process.pid): void {
  const file = leasePath(account, ctx, pid);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ account, pid, configDir, at }), 'utf8');
}

describe('the announcement for one session folder', () => {
  it('is the one naming that folder, among other sessions on other accounts', () => {
    const { ctx, dir } = home();
    takeLease('work', dir, ctx);
    announce(ctx, 'personal', path.join(path.dirname(dir), '9999'), Date.now());
    expect(sessionLease(dir, ctx)?.account).toBe('work');
  });

  it('is nothing for a folder no running session announced: plain claude, the editor, a dead session', () => {
    const { ctx, dir } = home();
    takeLease('work', path.join(path.dirname(dir), '9999'), ctx);
    expect(sessionLease(dir, ctx)).toBeNull();
    expect(sessionLease(dir, home().ctx)).toBeNull();
  });

  it('is nothing once the process that announced it is gone', () => {
    const { ctx, dir } = home();
    takeLease('work', dir, ctx);
    expect(sessionLease(dir, ctx, { isAlive: () => false })).toBeNull();
  });

  it('is the newer of two while a move is under way: the account moved onto is announced first', () => {
    const { ctx, dir } = home();
    const now = Date.now();
    announce(ctx, 'work', dir, now - 5_000);
    announce(ctx, 'home', dir, now);
    expect(sessionLease(dir, ctx)?.account).toBe('home');
  });

  it('matches the folder however its path is spelled', () => {
    const { ctx, dir } = home();
    takeLease('work', dir, ctx);
    expect(sessionLease(`${dir}${path.sep}`, ctx)?.account).toBe('work');
    expect(sessionLease(path.join(dir, '..', path.basename(dir)), ctx)?.account).toBe('work');
  });

  it('passes over an announcement with no folder in it', () => {
    const { ctx, dir } = home();
    announce(ctx, 'broken', 42, Date.now());
    takeLease('work', dir, ctx);
    expect(sessionLease(dir, ctx)?.account).toBe('work');
  });
});
