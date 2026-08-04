import { describe, it, expect } from 'vitest';
import { windowIsOpen } from './window-open.js';

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
