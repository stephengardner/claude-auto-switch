import { describe, it, expect } from 'vitest';
import { numberSessions, parseSessionChoice, sessionQuestion } from './session-choice.js';
import type { SessionLease } from '../session/lease.js';

const lease = (pid: number, account: string, cwd?: string, at = 1): SessionLease => ({
  pid,
  account,
  configDir: `/s/${pid}`,
  at,
  ...(cwd ? { cwd } : {}),
});

describe('numbering the running sessions', () => {
  it('numbers one per process by pid, named by folder, with the account it is on', () => {
    const numbered = numberSessions([lease(900, 'b', '/work/web'), lease(120, 'a', '/work/api')]);
    expect(numbered).toEqual([
      { number: 1, pid: 120, account: 'a', where: 'api' },
      { number: 2, pid: 900, account: 'b', where: 'web' },
    ]);
  });

  it("keeps a process's freshest lease when it holds two after a move", () => {
    // Leases arrive oldest first.
    const numbered = numberSessions([lease(120, 'old', '/work/api', 1), lease(120, 'new', '/work/api', 2)]);
    expect(numbered).toEqual([{ number: 1, pid: 120, account: 'new', where: 'api' }]);
  });

  it('tells two sessions in one folder apart by pid, and names one with no folder by its pid', () => {
    const numbered = numberSessions([lease(1, 'a', '/x/app'), lease(2, 'b', '/y/app'), lease(3, 'c')]);
    expect(numbered.map((s) => s.where)).toEqual(['app (1)', 'app (2)', '3']);
  });

  it('strips control characters from what it will draw', () => {
    const [s] = numberSessions([lease(5, 'evil\u001b[2Jname', '/w/pro\u0007ject')]);
    expect(s?.account).toBe('evil[2Jname');
    expect(s?.where).toBe('project');
  });
});

describe('reading which sessions to move', () => {
  const sessions = numberSessions([lease(1, 'a', '/w/api'), lease(2, 'b', '/w/web'), lease(3, 'c', '/w/cli')]);

  it('takes numbers in any order and separated any way, once each', () => {
    expect(parseSessionChoice('3, 1 3', sessions).map((s) => s.pid)).toEqual([3, 1]);
  });

  it('takes a or all for every one, and nothing for none', () => {
    expect(parseSessionChoice('a', sessions)).toHaveLength(3);
    expect(parseSessionChoice(' ALL ', sessions)).toHaveLength(3);
    expect(parseSessionChoice('  ', sessions)).toEqual([]);
  });

  it('refuses what is not one of them, saying what is', () => {
    expect(() => parseSessionChoice('4', sessions)).toThrow('"4" is not one of the sessions: 1 to 3, or a for all');
    expect(() => parseSessionChoice('web', sessions)).toThrow('"web" is not one of the sessions');
  });

  it('asks the question with each session, where it is, and its account', () => {
    expect(sessionQuestion('x', sessions.slice(0, 2))).toBe(
      'move which to "x"? 1 api (on a), 2 web (on b); a for all; enter alone for none:',
    );
  });
});
