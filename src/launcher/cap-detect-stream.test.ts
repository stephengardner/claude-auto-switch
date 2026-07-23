import { describe, it, expect } from 'vitest';
import { matchesCapText } from './cap-detect.js';

const ESC = String.fromCharCode(27);

describe('matchesCapText', () => {
  it('matches even when ANSI codes are interleaved (only passes after stripping)', () => {
    const interleaved = `Usage ${ESC}[31mlimit${ESC}[0m reached today`;
    expect(matchesCapText(interleaved)?.kind).toBe('capped');
  });

  it('returns null for normal TUI output', () => {
    expect(matchesCapText(`${ESC}[32mHello, how can I help?${ESC}[0m`)).toBeNull();
  });

  it('matches the confirmed live Fable per-model cap message', () => {
    const real =
      "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
    expect(matchesCapText(real)?.kind).toBe('capped');
  });

  it('extracts a reset time when present', () => {
    expect(matchesCapText('rate limit; resets 2026-07-22T15:00:00Z')?.resetAt).toBe(
      Date.parse('2026-07-22T15:00:00Z'),
    );
  });
});
