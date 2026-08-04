import { describe, it, expect } from 'vitest';
import { windowIsOpen, bindsHarder } from './window-open.js';

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);

describe('windowIsOpen', () => {
  it('is open while the reset is still ahead', () => {
    expect(windowIsOpen(NOW + 1, NOW)).toBe(true);
  });

  it('is CLOSED once the reset has passed', () => {
    expect(windowIsOpen(NOW - 1, NOW)).toBe(false);
  });

  it('treats the reset moment itself as closed', () => {
    // At exactly the reset time the window has rolled over, so the recorded
    // number describes the window that just ended.
    expect(windowIsOpen(NOW, NOW)).toBe(false);
  });

  it('stands when there is no reset time, having no evidence it lifted', () => {
    expect(windowIsOpen(null, NOW)).toBe(true);
    expect(windowIsOpen(undefined, NOW)).toBe(true);
  });
});

describe('bindsHarder', () => {
  const HOUR = 3_600_000;
  const open = (used: number) => ({ used, resetsAt: NOW + HOUR });
  const expired = (used: number) => ({ used, resetsAt: NOW - HOUR });

  it('is decided by usage as it stands now', () => {
    expect(bindsHarder(open(0.9), open(0.2), NOW)).toBe(true);
    expect(bindsHarder(open(0.2), open(0.9), NOW)).toBe(false);
    // The expired one reads as empty, so it constrains less despite the number.
    expect(bindsHarder(expired(1), open(0.2), NOW)).toBe(false);
  });

  it('gives a TIE to the window that is still open', () => {
    // The case that matters: once expired windows read as empty, ties are the
    // normal situation rather than a corner.
    expect(bindsHarder(open(0), expired(1), NOW)).toBe(true);
    expect(bindsHarder(expired(1), open(0), NOW)).toBe(false);
  });

  it('does not prefer either when both are open, or both expired', () => {
    // Neither beats the other, so a reduce keeps whichever it already had.
    expect(bindsHarder(open(0.5), open(0.5), NOW)).toBe(false);
    expect(bindsHarder(expired(1), expired(1), NOW)).toBe(false);
  });

  it('treats an unread window as no constraint at all', () => {
    expect(bindsHarder({ used: null, resetsAt: null }, open(0.1), NOW)).toBe(false);
  });
});
