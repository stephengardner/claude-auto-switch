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
