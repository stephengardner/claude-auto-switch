import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getActive, setActive } from './active.js';

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
});
