import { describe, it, expect } from 'vitest';
import { lastResortStart } from './last-resort.js';

const pool = (names: string[]) => names.map((name) => ({ name, dir: '/d/' + name }));

describe('starting when everything looks spent', () => {
  it('still starts, rather than refusing, when every account is week-spent', () => {
    // The production failure: every account recorded as out of room meant ccx
    // would not launch Claude at all. The operator had usage the whole time,
    // and the only thing on screen was "every account has hit its limit".
    const start = lastResortStart({ usable: pool(['main', 'second']), active: 'main' });
    expect(start).not.toBeNull();
    expect(start!.account.name).toBe('main');
    expect(start!.message).toContain('letting the server decide');
  });

  it('says WHY the cached judgement might be wrong, so it is not just noise', () => {
    const start = lastResortStart({ usable: pool(['a']) });
    expect(start!.message).toContain('usage credits');
  });

  it('prefers the active account, so the session stays where it was', () => {
    const start = lastResortStart({ usable: pool(['a', 'b', 'c']), active: 'c' });
    expect(start!.account.name).toBe('c');
  });

  it('falls back to the first account when the active one cannot run', () => {
    const start = lastResortStart({ usable: pool(['a', 'b']), active: 'gone' });
    expect(start!.account.name).toBe('a');
  });

  it('keeps the model-only wording, which tells you to switch models', () => {
    const start = lastResortStart({
      usable: pool(['a']),
      modelOnly: { model: 'Fable', resetsAt: 1000 },
      formatTime: () => 'SOON',
    });
    expect(start!.message).toContain('every account is out of Fable');
    expect(start!.message).toContain('It frees up SOON.');
    expect(start!.message).toContain('/model');
  });

  it('refuses ONLY when there is no account with a login to start', () => {
    // The one honest refusal: nothing to launch. The caller's ending explains
    // which accounts need signing in.
    expect(lastResortStart({ usable: [] })).toBeNull();
  });
});
