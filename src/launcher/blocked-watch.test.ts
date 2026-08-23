import { describe, it, expect } from 'vitest';
import { createBlockedWatch } from './blocked-watch.js';

const SECOND = 1_000;
const MINUTE = 60_000;

describe('deciding a session is blocked', () => {
  it('needs recurrence over MINUTES, not a burst', () => {
    // A resumed conversation replays its old cap message within seconds of
    // starting, and the resume picker paints history on screen. Acting on that
    // is how text alone used to cap healthy accounts.
    const watch = createBlockedWatch();
    let fired = false;
    for (let i = 0; i < 10; i += 1) {
      if (watch.sawLimitText(i * 6 * SECOND)) fired = true;
    }
    expect(fired).toBe(false); // ten episodes, but only a minute of them
  });

  it('fires once the same wall keeps coming back over minutes', () => {
    const watch = createBlockedWatch();
    expect(watch.sawLimitText(0)).toBe(false);
    expect(watch.sawLimitText(1 * MINUTE)).toBe(false);
    expect(watch.sawLimitText(2 * MINUTE)).toBe(true);
  });

  it('counts one episode per message, not one per repaint', () => {
    // The terminal repaints its whole frame, so one message on screen matches
    // on every render. Counting those reaches any threshold in seconds.
    const watch = createBlockedWatch();
    for (let ms = 0; ms <= 4 * SECOND; ms += 200) watch.sawLimitText(ms);
    expect(watch.count()).toBe(1);
  });

  it('says so only once, so one wall moves the session once', () => {
    const watch = createBlockedWatch();
    watch.sawLimitText(0);
    watch.sawLimitText(1 * MINUTE);
    expect(watch.sawLimitText(2 * MINUTE)).toBe(true);
    expect(watch.sawLimitText(3 * MINUTE)).toBe(false);
    expect(watch.count()).toBe(1);
  });

  it('starts again once something actually changed', () => {
    // A rotation or a model change makes the pattern describe a situation that
    // no longer exists.
    const watch = createBlockedWatch();
    watch.sawLimitText(0);
    watch.sawLimitText(1 * MINUTE);
    watch.changed();
    expect(watch.sawLimitText(2 * MINUTE)).toBe(false);
    expect(watch.count()).toBe(1);
  });

  it('takes no reason and no verdict, so no guard can veto it', () => {
    // The whole point. refusal-watch sat downstream of every guard and was
    // keyed on the WORDING of the refusal, so a session refused for varying
    // reasons never reached the threshold and stayed stuck. This one is told
    // only that a wall appeared.
    const watch = createBlockedWatch();
    expect(watch.sawLimitText.length).toBe(1); // (now) and nothing else
    expect(watch.sawLimitText(0)).toBe(false);
    expect(watch.sawLimitText(3 * MINUTE)).toBe(false);
    expect(watch.sawLimitText(6 * MINUTE)).toBe(true);
  });
});

describe('against timings actually observed in production', () => {
  const SECOND = 1_000;

  /**
   * These are not invented numbers. They are the gaps between limit-refusal
   * events in a real ccx event log, where the median gap between walls was
   * about two minutes and a quarter of them were under 41 seconds.
   *
   * The thresholds were chosen before that log was examined, so this is the
   * check that they answer real cadence rather than the fake's.
   */
  it('fires within about three minutes at the cadence a stuck session really has', () => {
    // Taken from a stuck stretch: walls at roughly 0s, 71s, 99s, 165s.
    const watch = createBlockedWatch();
    const walls = [0, 71, 99, 165].map((s) => s * SECOND);
    // Every wall asserted, so the exact boundary is pinned. Stopping at the
    // first true would have passed whether it fired on the first wall or the
    // third, which cannot protect the thresholds this test is named for.
    expect(watch.sawLimitText(walls[0]!)).toBe(false); // 0s, first wall
    expect(watch.sawLimitText(walls[1]!)).toBe(false); // 71s, count not met
    expect(watch.sawLimitText(walls[2]!)).toBe(false); // 99s, count met, span not
    expect(watch.sawLimitText(walls[3]!)).toBe(true); // 165s, both met
  });

  it('does not fire on someone who hits a wall twice an hour', () => {
    // The far tail of the same log: gaps of half an hour. Two walls that far
    // apart is an operator who went away and came back, not one sitting there
    // blocked, and moving their session on that evidence would be acting on
    // idleness. The count is what tells those apart, which is why raising the
    // spread instead would not do.
    const watch = createBlockedWatch();
    expect(watch.sawLimitText(0)).toBe(false);
    expect(watch.sawLimitText(30 * 60 * SECOND)).toBe(false);
    expect(watch.count()).toBe(2);
  });

  it('is not fooled by the burst a resumed conversation makes', () => {
    // The other end of the same distribution: the minimum observed gap was
    // 25 seconds, but a replay renders its old message several times within a
    // second or two of starting.
    const watch = createBlockedWatch();
    let fired = false;
    for (let ms = 0; ms <= 3 * SECOND; ms += 100) if (watch.sawLimitText(ms)) fired = true;
    expect(fired).toBe(false);
    expect(watch.count()).toBe(1);
  });
});
