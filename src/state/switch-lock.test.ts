import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { switchLockPath, withSwitchLock } from './switch-lock.js';
import type { PathCtx } from '../config/paths.js';

describe('the switch lock', () => {
  let home: string;
  let ctx: PathCtx;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ccx-switch-lock-'));
    ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('is held while the switch runs, and let go after', () => {
    const during = withSwitchLock(ctx, { waitMs: 0 }, (held) => held && existsSync(switchLockPath(ctx)));
    expect(during).toBe(true);
    expect(existsSync(switchLockPath(ctx))).toBe(false);
  });

  it('is let go when the switch throws', () => {
    expect(() =>
      withSwitchLock(ctx, { waitMs: 0 }, () => {
        throw new Error('the switch failed');
      }),
    ).toThrow('the switch failed');
    expect(existsSync(switchLockPath(ctx))).toBe(false);
  });

  it('tells a second switch it is not held, without waiting, while the first is still going', () => {
    const second = withSwitchLock(ctx, { waitMs: 0 }, () => withSwitchLock(ctx, { waitMs: 0 }, (held) => held));
    expect(second).toBe(false);
  });

  it('leaves the lock with the switch that holds it', () => {
    const stillThere = withSwitchLock(ctx, { waitMs: 0 }, () => {
      withSwitchLock(ctx, { waitMs: 0 }, () => undefined);
      return existsSync(switchLockPath(ctx));
    });
    expect(stillThere).toBe(true);
  });

  it('takes over a lock whose holder has exited', () => {
    writeFileSync(switchLockPath(ctx), '4242');
    const isRunning = (pid: number): boolean => pid !== 4242;
    expect(withSwitchLock(ctx, { waitMs: 0, isRunning }, (held) => held)).toBe(true);
  });

  it('does not take a lock whose holder is still running', () => {
    writeFileSync(switchLockPath(ctx), '4242');
    const isRunning = (): boolean => true;
    expect(withSwitchLock(ctx, { waitMs: 0, isRunning }, (held) => held)).toBe(false);
    // Not ours, so not ours to remove.
    expect(existsSync(switchLockPath(ctx))).toBe(true);
  });

  it('makes the folder it needs', () => {
    const fresh: PathCtx = { env: { CLAUDE_AUTO_SWITCH_HOME: path.join(home, 'not', 'yet') } };
    expect(withSwitchLock(fresh, { waitMs: 0 }, (held) => held)).toBe(true);
  });
});
