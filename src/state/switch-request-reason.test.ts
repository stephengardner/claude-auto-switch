import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSwitchRequest, requestMoves, writeSwitchRequest } from './switch-request.js';

function home() {
  return {
    env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-switch-reason-')) },
  };
}

/** The folder per-session requests live in, found by writing one: its name is the module's to choose. */
function requestDir(c: ReturnType<typeof home>): string {
  writeSwitchRequest('x', 0, 'seamless', c, 1);
  const root = c.env.CLAUDE_AUTO_SWITCH_HOME;
  const found = readdirSync(root).find(
    (n) => n.startsWith('switch-') && statSync(path.join(root, n)).isDirectory(),
  );
  if (!found) throw new Error('no per-session request folder was written');
  return path.join(root, found);
}

/** Why a move is asked for travels with the request, so the session can record it with the move. */
describe('the reason on a switch request', () => {
  it('is kept when it is not asked, which a request without one means', () => {
    const c = home();
    writeSwitchRequest('b', 1, 'seamless', c, 41, 'proactive');
    writeSwitchRequest('c', 2, 'seamless', c, 42);
    expect(readSwitchRequest(c, 41)).toEqual({
      account: 'b',
      at: 1,
      mode: 'seamless',
      reason: 'proactive',
    });
    expect(readSwitchRequest(c, 42)).toEqual({ account: 'c', at: 2, mode: 'seamless' });
  });

  it('goes on each request asked of several sessions', () => {
    const c = home();
    const asked = requestMoves(
      'b',
      [
        { pid: 7, account: 'a' },
        { pid: 8, account: 'b' },
      ],
      'seamless',
      c,
      3,
      'proactive',
    );
    expect(asked.map((s) => s.pid)).toEqual([7]);
    expect(readSwitchRequest(c, 7)?.reason).toBe('proactive');
  });

  it('reads as absent when a newer ccx wrote one this version does not know, and the move is still made', () => {
    const c = home();
    writeSwitchRequest('b', 5, 'seamless', c, 11, 'proactive');
    const file = path.join(requestDir(c), '11.json');
    writeFileSync(
      file,
      JSON.stringify({ account: 'b', at: 5, mode: 'seamless', reason: 'pooled' }),
      'utf8',
    );
    expect(readSwitchRequest(c, 11)).toEqual({ account: 'b', at: 5, mode: 'seamless' });
  });

  it('is absent from a request an older ccx wrote, which is still read', () => {
    const c = home();
    const dir = requestDir(c);
    writeFileSync(
      path.join(dir, '9.json'),
      JSON.stringify({ account: 'b', at: 4, mode: 'seamless' }),
      'utf8',
    );
    const request = readSwitchRequest(c, 9);
    expect(request?.account).toBe('b');
    expect(request?.reason).toBeUndefined();
  });
});
