import { describe, it, expect } from 'vitest';
import { createRefusalWatch } from './refusal-watch.js';

const MIN = 60_000;
const REASON = 'Fable is spent, but this session is running opus';

describe('refusals that stop being credible', () => {
  it('says nothing while a replay bursts through', () => {
    // A resumed conversation re-renders its old cap message several times
    // within seconds. That is not somebody hitting a wall, and acting on it
    // would end the session the moment it started, over and over.
    const watch = createRefusalWatch();
    const start = 1_000_000;
    for (const offset of [0, 200, 400, 900, 1500, 2000]) {
      expect(watch.refused(REASON, start + offset)).toBe(false);
    }
  });

  it('gives up refusing once the same limit keeps coming back over minutes', () => {
    // The failure this exists for: the API cannot account for a limit that is
    // genuinely happening, so ccx refuses forever and the operator sits
    // blocked. Persistence over time is the evidence the check itself lacked.
    const watch = createRefusalWatch();
    const start = 1_000_000;
    expect(watch.refused(REASON, start)).toBe(false);
    expect(watch.refused(REASON, start + 3 * MIN)).toBe(false);
    expect(watch.refused(REASON, start + 6 * MIN)).toBe(true);
  });

  it('needs BOTH the count and the spread, not either one', () => {
    // Two refusals an hour apart is not a pattern, and six in five seconds is
    // a replay. Only persistent recurrence is worth acting on.
    const spreadOnly = createRefusalWatch();
    expect(spreadOnly.refused(REASON, 0)).toBe(false);
    expect(spreadOnly.refused(REASON, 60 * MIN)).toBe(false); // long, but only two

    const countOnly = createRefusalWatch();
    for (const t of [0, 1, 2, 3, 4, 5]) {
      expect(countOnly.refused(REASON, t)).toBe(false); // many, but all at once
    }
  });

  it('counts each reason separately', () => {
    // Unrelated refusals must not add up to an escalation that no one of them
    // justified.
    const watch = createRefusalWatch();
    expect(watch.refused('one reason', 0)).toBe(false);
    expect(watch.refused('another reason', 3 * MIN)).toBe(false);
    expect(watch.refused('one reason', 6 * MIN)).toBe(false);
    expect(watch.count()).toBe(1);
  });

  it('fires once per pattern, not on every tick afterwards', () => {
    // Escalating rotates the session. Doing it again on the next render would
    // walk through every account in seconds.
    const watch = createRefusalWatch();
    expect(watch.refused(REASON, 0)).toBe(false);
    expect(watch.refused(REASON, 3 * MIN)).toBe(false);
    expect(watch.refused(REASON, 6 * MIN)).toBe(true);
    expect(watch.refused(REASON, 7 * MIN)).toBe(false);
    expect(watch.refused(REASON, 8 * MIN)).toBe(false);
  });

  it('forgets the pattern when something actually moved', () => {
    // A rotation or a model change means the refusals were about the state
    // ccx has just left.
    const watch = createRefusalWatch();
    watch.refused(REASON, 0);
    watch.refused(REASON, 3 * MIN);
    watch.reset();
    expect(watch.count()).toBe(0);
    expect(watch.refused(REASON, 6 * MIN)).toBe(false);
  });

  it('can be tuned, so the rule is not buried in the numbers', () => {
    const watch = createRefusalWatch({ after: 2, spreadMs: MIN });
    expect(watch.refused(REASON, 0)).toBe(false);
    expect(watch.refused(REASON, 2 * MIN)).toBe(true);
  });
});

describe('what the caller must key on', () => {
  const MINUTE = 60_000;

  it('never escalates when the reason keeps changing wording', () => {
    // The hazard this file has to be used carefully to avoid, and the one that
    // stranded a real session: the count resets whenever the key changes, so
    // keying on the REASON means every variation in wording starts over. The
    // net gets weaker the more ways ccx fails to explain the limit.
    const watch = createRefusalWatch();
    const reasons = [
      'fable is spent, but this session is running opus',
      'could not confirm usage limit',
      'fable is spent, but this session is running opus',
      'unknown',
      'fable is spent, but this session is running opus',
      'could not confirm usage limit',
    ];
    let fired = false;
    reasons.forEach((reason, i) => {
      if (watch.refused(reason, i * MINUTE)) fired = true;
    });
    expect(fired).toBe(false); // six refusals over five minutes, and nothing happens
  });

  it('escalates over the same span once the key is the SUBJECT, not the wording', () => {
    // The same six refusals, keyed on what is actually true of all of them:
    // this session, on this model, is blocked.
    const watch = createRefusalWatch();
    let firedAt = -1;
    for (let i = 0; i < 6; i += 1) {
      if (watch.refused('opus[1m]', i * MINUTE) && firedAt < 0) firedAt = i;
    }
    expect(firedAt).toBeGreaterThanOrEqual(0);
  });

  it('still starts a fresh count when the model actually changes', () => {
    // A /model change IS a different situation, so it should not inherit a
    // pattern gathered about a model no longer in use.
    const watch = createRefusalWatch();
    expect(watch.refused('fable', 0)).toBe(false);
    expect(watch.refused('fable', 4 * MINUTE)).toBe(false);
    expect(watch.refused('opus', 8 * MINUTE)).toBe(false);
    expect(watch.count()).toBe(1);
  });
});

describe('evidence that an all-clear should have thrown away', () => {
  const MINUTE = 60_000;

  it('does not escalate from a timestamp taken before the API reported room', () => {
    // An unverified refusal, then a conclusive "you have room", then two more
    // refusals. Counting the first one still would reach the spread on evidence
    // the all-clear already answered, and bench the account for it.
    const watch = createRefusalWatch();
    expect(watch.refused('fable', 0)).toBe(false);
    watch.reset(); // the API positively reported room at minute 3
    expect(watch.refused('fable', 4 * MINUTE)).toBe(false);
    expect(watch.refused('fable', 5 * MINUTE)).toBe(false);
    // Three refusals in total, but only two since the all-clear, and those two
    // are one minute apart rather than five.
    expect(watch.count()).toBe(2);
  });

  it('escalates once the refusals AFTER the all-clear earn it on their own', () => {
    const watch = createRefusalWatch();
    watch.refused('fable', 0);
    watch.reset();
    expect(watch.refused('fable', 10 * MINUTE)).toBe(false);
    expect(watch.refused('fable', 11 * MINUTE)).toBe(false);
    expect(watch.refused('fable', 13 * MINUTE)).toBe(true);
  });
});
