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
