import { describe, it, expect } from 'vitest';
import { createCheckBackoff, REFUTE_BACKOFF_MS } from './check-backoff.js';

describe('the pause after a check that did not confirm a limit', () => {
  it('holds refusals back for its length from the pause, and not before it', () => {
    const backoff = createCheckBackoff(1_000);
    expect(backoff.paused(5_000)).toBe(false);
    backoff.pause(5_000);
    expect(backoff.paused(5_000)).toBe(true);
    expect(backoff.paused(5_999)).toBe(true);
    expect(backoff.paused(6_000)).toBe(false);
  });

  it('runs from the latest pause', () => {
    const backoff = createCheckBackoff(1_000);
    backoff.pause(5_000);
    backoff.pause(5_500);
    expect(backoff.paused(6_200)).toBe(true);
    expect(backoff.paused(6_500)).toBe(false);
  });

  it('lasts 20 s unless told otherwise', () => {
    const backoff = createCheckBackoff();
    backoff.pause(0);
    expect(REFUTE_BACKOFF_MS).toBe(20_000);
    expect(backoff.paused(REFUTE_BACKOFF_MS - 1)).toBe(true);
    expect(backoff.paused(REFUTE_BACKOFF_MS)).toBe(false);
  });
});
