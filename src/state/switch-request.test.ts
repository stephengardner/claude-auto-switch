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
  it('writes, reads back, and clears a request (seamless + restart modes)', () => {
    const c = ctx();
    expect(readSwitchRequest(c)).toBeNull();
    writeSwitchRequest('phx', 1234, 'seamless', c);
    expect(readSwitchRequest(c)).toEqual({ account: 'phx', at: 1234, mode: 'seamless' });
    writeSwitchRequest('phx', 5, 'restart', c);
    expect(readSwitchRequest(c)?.mode).toBe('restart');
    clearSwitchRequest(c);
    expect(readSwitchRequest(c)).toBeNull();
  });

  it('never throws when the home cannot be resolved', () => {
    // A missing/garbage location must not crash a live session's poll.
    expect(() => readSwitchRequest({ env: { CLAUDE_AUTO_SWITCH_HOME: 'C:/nope/does/not/exist' } })).not.toThrow();
  });

  it('keeps a per-session request separate from the broadcast one', () => {
    const c = ctx();
    // A targeted request for one pid does not appear as the broadcast request,
    // and a session reading its own pid does not see another pid's request.
    writeSwitchRequest('phx', 1, 'seamless', c, 4242);
    expect(readSwitchRequest(c)).toBeNull(); // broadcast is still empty
    expect(readSwitchRequest(c, 4242)).toEqual({ account: 'phx', at: 1, mode: 'seamless' });
    expect(readSwitchRequest(c, 9999)).toBeNull(); // a different session sees nothing

    // The broadcast request and a per-session one coexist without colliding.
    writeSwitchRequest('main', 2, 'restart', c);
    expect(readSwitchRequest(c)?.account).toBe('main');
    expect(readSwitchRequest(c, 4242)?.account).toBe('phx');

    // Clearing one leaves the other in place.
    clearSwitchRequest(c, 4242);
    expect(readSwitchRequest(c, 4242)).toBeNull();
    expect(readSwitchRequest(c)?.account).toBe('main');
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
