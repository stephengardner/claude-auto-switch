import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearHandPick, readHandPick, recordHandPick } from './hand-pick.js';
import type { PathCtx } from '../config/paths.js';

describe('the account somebody chose by hand', () => {
  let home: string;
  let ctx: PathCtx;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ccx-hand-pick-'));
    ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('is nothing until somebody picks', () => {
    expect(readHandPick(ctx)).toBeNull();
  });

  it('is the last account picked, with when', () => {
    recordHandPick('work', ctx, 1000);
    recordHandPick('personal', ctx, 2000);
    expect(readHandPick(ctx)).toEqual({ account: 'personal', at: 2000 });
  });

  it('can be forgotten, and forgetting twice is fine', () => {
    recordHandPick('work', ctx, 1000);
    clearHandPick(ctx);
    clearHandPick(ctx);
    expect(readHandPick(ctx)).toBeNull();
  });

  it('reads a damaged file as no pick rather than failing the caller', () => {
    writeFileSync(path.join(home, 'hand-pick.json'), '{ not json');
    expect(readHandPick(ctx)).toBeNull();
    writeFileSync(path.join(home, 'hand-pick.json'), JSON.stringify({ account: 7 }));
    expect(readHandPick(ctx)).toBeNull();
  });
});
