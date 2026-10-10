import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  writeSwitchRequest,
  readSwitchRequest,
  clearSwitchRequest,
  decideSwitch,
  requestMoves,
  sweepDeadSwitchRequests,
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

describe('requestMoves', () => {
  it('asks each session not already there by its own request, never the shared one', () => {
    const c = ctx();
    const sessions = [
      { pid: 11, account: 'a' },
      { pid: 12, account: 'b' },
      { pid: 13, account: 'a' },
    ];
    const asked = requestMoves('b', sessions, 'restart', c, 5);
    expect(asked.map((s) => s.pid)).toEqual([11, 13]);
    expect(readSwitchRequest(c, 11)).toEqual({ account: 'b', at: 5, mode: 'restart' });
    expect(readSwitchRequest(c, 13)).toEqual({ account: 'b', at: 5, mode: 'restart' });
    expect(readSwitchRequest(c, 12)).toBeNull();
    expect(readSwitchRequest(c)).toBeNull();
  });
});

describe('requests left for sessions that are gone', () => {
  const requestsDir = (c: { env: { CLAUDE_AUTO_SWITCH_HOME: string } }): string =>
    path.join(c.env.CLAUDE_AUTO_SWITCH_HOME, 'switch-requests');

  it('removes the request of a session whose process is gone, and no other', () => {
    // A session clears its own request as it ends. One that is killed never
    // does, and nothing read that file again unless its pid came round.
    const c = ctx();
    writeSwitchRequest('phx', 1, 'seamless', c, 4242);
    writeSwitchRequest('phx', 1, 'seamless', c, 4243);
    writeSwitchRequest('phx', 1, 'seamless', c);

    expect(sweepDeadSwitchRequests(c, (pid) => pid === 4243)).toBe(1);
    expect(readSwitchRequest(c, 4242)).toBeNull();
    // A running session's request, and the one any session may take, stay.
    expect(readSwitchRequest(c, 4243)).toEqual({ account: 'phx', at: 1, mode: 'seamless' });
    expect(readSwitchRequest(c)).toEqual({ account: 'phx', at: 1, mode: 'seamless' });
  });

  it('touches nothing that is not a session request', () => {
    const c = ctx();
    writeSwitchRequest('phx', 1, 'seamless', c, 4242);
    writeFileSync(path.join(requestsDir(c), 'notes.json'), '{}', 'utf8');
    writeFileSync(path.join(requestsDir(c), '12abc.json'), '{}', 'utf8');
    expect(sweepDeadSwitchRequests(c, () => false)).toBe(1);
    expect(readdirSync(requestsDir(c)).sort()).toEqual(['12abc.json', 'notes.json']);
  });

  it('does nothing when no request was ever made', () => {
    const c = ctx();
    expect(sweepDeadSwitchRequests(c, () => false)).toBe(0);
    expect(existsSync(requestsDir(c))).toBe(false);
  });
});
