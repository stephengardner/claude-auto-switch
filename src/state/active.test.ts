import { describe, it, expect } from 'vitest';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { activeSince, getActive, setActive } from './active.js';

function home() {
  return { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-active-')) } };
}

describe('active state', () => {
  it('defaults to null when unset', () => {
    expect(getActive(home())).toBeNull();
  });

  it('persists and reads back the active account', () => {
    const ctx = home();
    setActive('work-max', ctx);
    expect(getActive(ctx)).toBe('work-max');
  });

  it('can be cleared back to null', () => {
    const ctx = home();
    setActive('work-max', ctx);
    setActive(null, ctx);
    expect(getActive(ctx)).toBeNull();
  });

  it('keeps the time the account last CHANGED when the same account is set again', () => {
    const ctx = home();
    setActive('work-max', ctx);
    const file = path.join(ctx.env.CLAUDE_AUTO_SWITCH_HOME, 'active.json');
    const tenMinutesAgo = new Date(Date.now() - 600_000);
    utimesSync(file, tenMinutesAgo, tenMinutesAgo);

    // What every session does when it starts on the account already active.
    setActive('work-max', ctx);
    expect(Math.abs((activeSince(ctx) as number) - tenMinutesAgo.getTime())).toBeLessThan(2_000);

    setActive('personal', ctx);
    expect(Date.now() - (activeSince(ctx) as number)).toBeLessThan(5_000);
  });

  it('replaces a file that no longer loads', () => {
    const ctx = home();
    writeFileSync(path.join(ctx.env.CLAUDE_AUTO_SWITCH_HOME, 'active.json'), '{ not json');
    setActive('work-max', ctx);
    expect(getActive(ctx)).toBe('work-max');
  });

  it('knows when it was last set, and that it never was', () => {
    const ctx = home();
    expect(activeSince(ctx)).toBeNull();
    const before = Date.now();
    setActive('work-max', ctx);
    const since = activeSince(ctx);
    // A file's time can sit a little either side of the clock that was just read.
    expect(since).not.toBeNull();
    expect(Math.abs((since as number) - before)).toBeLessThan(5_000);
  });
});
