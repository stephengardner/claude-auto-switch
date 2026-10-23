import { describe, it, expect } from 'vitest';
import { durationWords, expiryWords, parseDuration } from './words.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('lengths of time as typed', () => {
  it('reads minutes, hours, days and seconds, alone or together', () => {
    expect(parseDuration('90m')).toBe(90 * MINUTE);
    expect(parseDuration('2h')).toBe(2 * HOUR);
    expect(parseDuration('1h30m')).toBe(90 * MINUTE);
    expect(parseDuration('1d')).toBe(24 * HOUR);
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration(' 2H ')).toBe(2 * HOUR);
  });

  it('reads a bare number as minutes', () => {
    expect(parseDuration('120')).toBe(120 * MINUTE);
  });

  it('refuses anything else', () => {
    for (const typed of ['', 'soon', '-5m', '1.5h', 'm', '30m2h'])
      expect(parseDuration(typed), typed).toBeNull();
  });
});

describe('lengths of time as said', () => {
  it('says hours and minutes, dropping what is zero', () => {
    expect(durationWords(2 * HOUR + 5 * MINUTE)).toBe('2h 5m');
    expect(durationWords(3 * HOUR)).toBe('3h');
    expect(durationWords(45 * MINUTE)).toBe('45m');
    expect(durationWords(20_000)).toBe('under a minute');
    expect(durationWords(-HOUR)).toBe('under a minute');
  });

  it('says when a token runs out, or that it has', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(expiryWords(now + 2 * HOUR, now)).toMatch(/^until .+ \(2h left\)$/);
    expect(expiryWords(now - MINUTE, now)).toMatch(/^expired at /);
    expect(expiryWords(0, now)).toBe('with no expiry recorded');
  });
});
