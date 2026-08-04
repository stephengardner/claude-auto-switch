import { describe, it, expect } from 'vitest';
import {
  freshMirrorState,
  shouldCheck,
  beginCheck,
  finishCheck,
  abandonCheck,
} from './mirror-state.js';

/**
 * Both ways of getting this wrong have happened, so both are pinned here as
 * behaviour rather than as the shape of the code that implements it.
 */

/** One full cycle: decide, look up, record. Returns the state and whether it looked. */
function tick(state: ReturnType<typeof freshMirrorState>, stamp: string, outcome?: 'settled' | 'retry') {
  if (!shouldCheck(state, stamp)) return { state, looked: false };
  const busy = beginCheck(state, stamp);
  const done = outcome ? finishCheck(busy, stamp, outcome) : abandonCheck(busy, stamp);
  return { state: done, looked: true };
}

describe('deciding whether the session login needs looking at', () => {
  it('looks at a credential it has not seen', () => {
    expect(shouldCheck(freshMirrorState(), 'abc')).toBe(true);
  });

  it('does not look when there is no credential at all', () => {
    expect(shouldCheck(freshMirrorState(), '')).toBe(false);
  });

  it('NEVER looks at a refused credential twice', () => {
    // The freeze. A refusal is a settled answer: nothing about that credential
    // can change until the file does, so asking again can only produce the same
    // refusal. Re-asking cost a network call twice a second for the whole
    // session and locked the machine up.
    let s = freshMirrorState();
    let looks = 0;
    for (let i = 0; i < 50; i += 1) {
      const r = tick(s, 'refused-cred', 'settled');
      s = r.state;
      if (r.looked) looks += 1;
    }
    expect(looks).toBe(1);
  });

  it('never looks at a saved credential twice either', () => {
    let s = freshMirrorState();
    let looks = 0;
    for (let i = 0; i < 10; i += 1) {
      const r = tick(s, 'saved-cred', 'settled');
      s = r.state;
      if (r.looked) looks += 1;
    }
    expect(looks).toBe(1);
  });

  it('RETRIES after a failed disk write, so a refreshed token is not lost', () => {
    // The opposite mistake. Treating a local write failure as settled would
    // leave a refreshed token unsaved until the process exits, and lost if it is
    // interrupted.
    let s = freshMirrorState();
    const first = tick(s, 'cred', 'retry');
    s = first.state;
    const second = tick(s, 'cred', 'settled');
    expect(first.looked).toBe(true);
    expect(second.looked).toBe(true); // tried again
    expect(tick(s = second.state, 'cred', 'settled').looked).toBe(false); // then settled
  });

  it('retries when the lookup could not reach the API', () => {
    // Nothing was decided, so nothing is settled.
    let s = freshMirrorState();
    s = tick(s, 'cred').state; // abandoned
    expect(shouldCheck(s, 'cred')).toBe(true);
  });

  it('does not start a second lookup for a credential already in flight', () => {
    // The poll runs every 400ms and the lookup is a network call, so without
    // this the same credential would be asked about several times over.
    const s = beginCheck(freshMirrorState(), 'cred');
    expect(shouldCheck(s, 'cred')).toBe(false);
  });

  it('looks at a NEW credential even while another lookup is in flight', () => {
    const s = beginCheck(freshMirrorState(), 'old');
    expect(shouldCheck(s, 'new')).toBe(true);
  });

  it('a late answer about an old credential does not release a newer lookup', () => {
    // Answers can arrive out of order. Clearing the wrong one would let the
    // newer credential be asked about twice.
    let s = beginCheck(freshMirrorState(), 'new');
    s = finishCheck(s, 'old', 'settled');
    expect(s.checking).toBe('new');
  });

  it('looks again once the credential changes', () => {
    const s = finishCheck(beginCheck(freshMirrorState(), 'v1'), 'v1', 'settled');
    expect(shouldCheck(s, 'v1')).toBe(false);
    expect(shouldCheck(s, 'v2')).toBe(true);
  });
});
