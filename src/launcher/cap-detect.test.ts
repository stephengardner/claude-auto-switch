import { describe, it, expect } from 'vitest';
import { classifyRun, matchesCapText } from './cap-detect.js';

describe('classifyRun', () => {
  it('classifies a clean exit as ok', () => {
    expect(classifyRun({ exitCode: 0, stderr: '' }).kind).toBe('ok');
  });

  it('classifies the usage-limit message as capped', () => {
    const r = classifyRun({ exitCode: 1, stderr: 'Usage limit reached. Try again later.' });
    expect(r.kind).toBe('capped');
    expect(r.reason).toContain('Usage limit reached');
  });

  it('matches several rate-limit phrasings', () => {
    for (const msg of [
      'rate limit exceeded',
      'Too Many Requests',
      '5-hour limit reached',
      'weekly limit hit',
      'quota exceeded',
    ]) {
      expect(classifyRun({ exitCode: 1, stderr: msg }).kind).toBe('capped');
    }
  });

  it('classifies other non-zero exits as error', () => {
    expect(classifyRun({ exitCode: 2, stderr: 'some other failure' }).kind).toBe('error');
  });

  it('extracts an ISO reset time when present', () => {
    const r = classifyRun({
      exitCode: 1,
      stderr: 'Usage limit reached. Resets at 2026-07-22T15:00:00Z.',
    });
    expect(r.kind).toBe('capped');
    expect(r.resetAt).toBe(Date.parse('2026-07-22T15:00:00Z'));
  });

  describe('the usage gauge is not a cap', () => {
    // Claude keeps a usage indicator on screen during a perfectly healthy
    // session. It contains the words "weekly limit", so it matched, and every
    // session looked like it had capped over and over. That trigger then sent
    // ccx to the usage API, which answered "limited" for an unrelated reason
    // (one model's window was spent), and ccx rotated a session that was
    // running fine, ending on "every account has hit its limit" while sitting
    // on an account with 92% of its five-hour window free.
    const gauges = [
      "You've used 74% of your weekly limit · resets Aug 12, 2pm (America/New_York)",
      "You've used 12% of your 5-hour limit",
      "You've used 100% of your weekly limit",
      'Approaching weekly limit',
    ];

    for (const line of gauges) {
      it(`does not treat "${line.slice(0, 40)}" as a cap`, () => {
        expect(matchesCapText(line)).toBeNull();
        expect(classifyRun({ exitCode: 1, stderr: line }).kind).not.toBe('capped');
      });
    }

    it('still finds a REAL cap in the same screenful as the gauge', () => {
      // Stripping the gauge must not hide a genuine announcement that arrives
      // beside it, which is the normal case: the indicator is always there.
      const together = ["You've used 74% of your weekly limit", 'Claude usage limit reached.'].join(
        '\n',
      );
      expect(matchesCapText(together)).not.toBeNull();
      expect(classifyRun({ exitCode: 1, stderr: together }).kind).toBe('capped');
    });

    it('still finds a REAL cap on the SAME LINE as the gauge', () => {
      // The pattern used to eat everything to the next period, so a line
      // holding the gauge, a dash, and a genuine announcement became
      // whitespace and the cap went unconfirmed. The separator is the em dash
      // the real render uses, written here as an escape.
      const sameLine = "You've used 74% of your weekly limit \u2014 Claude usage limit reached.";
      expect(matchesCapText(sameLine)).not.toBeNull();
      expect(classifyRun({ exitCode: 1, stderr: sameLine }).kind).toBe('capped');
    });

    it('finds a cap that follows the resets clause with no period between', () => {
      // The resets tail must stop at the value, not run to the next period:
      // an open-ended tail re-created the same-line bug one clause later.
      const line =
        "You've used 74% of your weekly limit resets 2026-08-12T15:00:00Z, Claude usage limit reached";
      expect(matchesCapText(line)).not.toBeNull();
      expect(classifyRun({ exitCode: 1, stderr: line }).kind).toBe('capped');
    });

    it('never reports punctuation the filter left behind as the reason', () => {
      // A gauge ending in a period leaves "." on its line, and "." is no
      // reason; the announcement below it is.
      const mixed = "You've used 12% of your 5-hour limit.\nUsage limit reached.";
      const result = classifyRun({ exitCode: 1, stderr: mixed });
      expect(result.kind).toBe('capped');
      expect(result.reason).toBe('Usage limit reached.');
    });

    it('reports the real announcement as the reason, not the gauge', () => {
      // The raw first line is the gauge, and recording that told the operator
      // "74% of your weekly limit" about an account that actually hit a cap.
      const mixed = ["You've used 74% of your weekly limit", 'Claude usage limit reached.'].join(
        '\n',
      );
      const result = classifyRun({ exitCode: 1, stderr: mixed });
      expect(result.kind).toBe('capped');
      expect(result.reason).toBe('Claude usage limit reached.');
    });

    it('still catches the wordings that mean a real stop', () => {
      for (const line of [
        "You've reached your Fable 5 limit.",
        'Claude usage limit reached.',
        'rate limit exceeded',
        'too many requests',
      ]) {
        expect(matchesCapText(line), line).not.toBeNull();
      }
    });
  });
});