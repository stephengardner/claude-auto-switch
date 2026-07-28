import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  writeSwitchRequest,
  readSwitchRequest,
  clearSwitchRequest,
  decideSwitch,
} from './switch-request.js';

function ctx() {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-switch-'));
  return { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
}

describe('switch-request file', () => {
  it('writes, reads back, and clears a request', () => {
    const c = ctx();
    expect(readSwitchRequest(c)).toBeNull();
    writeSwitchRequest('phx', 1234, c);
    expect(readSwitchRequest(c)).toEqual({ account: 'phx', at: 1234 });
    clearSwitchRequest(c);
    expect(readSwitchRequest(c)).toBeNull();
  });

  it('treats a malformed request as absent (never throws)', () => {
    const c = ctx();
    // A partial/garbage file must not crash a live session.
    writeSwitchRequest('x', 1, c);
    expect(() => readSwitchRequest({ env: { CLAUDE_AUTO_SWITCH_HOME: 'C:/nope/does/not/exist' } })).not.toThrow();
  });
});

describe('decideSwitch (pure lifecycle)', () => {
  const canUseAll = () => true;

  it('does nothing when there is no request', () => {
    expect(decideSwitch(null, 'main', canUseAll)).toEqual({ switchTo: null, consume: false });
  });

  it('consumes without switching when already on the requested account', () => {
    expect(decideSwitch({ account: 'main', at: 1 }, 'main', canUseAll)).toEqual({
      switchTo: null,
      consume: true,
    });
  });

  it('consumes without switching when the target cannot be used (logged out/unknown)', () => {
    expect(decideSwitch({ account: 'ghost', at: 1 }, 'main', () => false)).toEqual({
      switchTo: null,
      consume: true,
    });
  });

  it('switches to a usable, different account and consumes the request', () => {
    expect(decideSwitch({ account: 'phx', at: 1 }, 'main', canUseAll)).toEqual({
      switchTo: 'phx',
      consume: true,
    });
  });
});
