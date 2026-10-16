import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  beat,
  emptyState,
  lastBeat,
  loadState,
  pause,
  readControls,
  resume,
  saveState,
  setEarlyMoves,
  statePath,
  watchDir,
} from './state.js';
import type { PathCtx } from '../config/paths.js';

describe("the watcher's files", () => {
  let home: string;
  let ctx: PathCtx;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ccx-autoswitch-state-'));
    ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('live in their own folder inside the config home', () => {
    expect(watchDir(ctx)).toBe(path.join(home, 'autoswitch'));
  });

  describe('its state', () => {
    it('starts empty', () => {
      expect(loadState(ctx)).toEqual(emptyState());
      expect(loadState(ctx)).toMatchObject({ account: null, reads: [], none: null, lastSwitch: null });
    });

    it('reads back what was saved', () => {
      const state = { ...emptyState(), account: { name: 'work', since: 1000 }, reads: [{ used: 0.5, wide: 0.4, at: 2000 }] };
      saveState(state, ctx);
      expect(loadState(ctx)).toEqual(state);
    });

    it('starts over from a file that is damaged or shaped for another build', () => {
      mkdirSync(watchDir(ctx), { recursive: true });
      writeFileSync(statePath(ctx), '{ not json');
      expect(loadState(ctx)).toEqual(emptyState());
      writeFileSync(statePath(ctx), JSON.stringify({ reads: 'many' }));
      expect(loadState(ctx)).toEqual(emptyState());
    });

    it('fills in what an older state file did not have', () => {
      mkdirSync(watchDir(ctx), { recursive: true });
      writeFileSync(statePath(ctx), JSON.stringify({ account: { name: 'work', since: 5 } }));
      expect(loadState(ctx)).toMatchObject({ account: { name: 'work', since: 5 }, reads: [], failed: {}, counts: {} });
    });
  });

  describe('what holds it back', () => {
    it('is nothing by default', () => {
      expect(readControls(ctx)).toEqual({ paused: null, earlyOff: false });
    });

    it('is a pause, with the reason it was given', () => {
      pause('upgrading the machine', ctx);
      expect(readControls(ctx)).toEqual({ paused: 'upgrading the machine', earlyOff: false });
    });

    it('says so when a pause was given no reason', () => {
      pause('', ctx);
      expect(readControls(ctx).paused).toBe('no reason given');
    });

    it('is early moves held, apart from a pause', () => {
      setEarlyMoves(false, ctx, 'someone');
      expect(readControls(ctx)).toEqual({ paused: null, earlyOff: true });
      setEarlyMoves(true, ctx);
      expect(readControls(ctx)).toEqual({ paused: null, earlyOff: false });
    });

    it('is all cleared by resume, whichever was set', () => {
      pause('for now', ctx);
      setEarlyMoves(false, ctx);
      resume(ctx);
      expect(readControls(ctx)).toEqual({ paused: null, earlyOff: false });
      resume(ctx);
      expect(readControls(ctx)).toEqual({ paused: null, earlyOff: false });
    });
  });

  describe('its heartbeat', () => {
    it('is nothing until a service pass has run', () => {
      expect(lastBeat(ctx)).toBeNull();
    });

    it('is when the last service pass started', () => {
      beat(ctx, 1234);
      beat(ctx, 5678);
      expect(lastBeat(ctx)).toBe(5678);
    });
  });
});
