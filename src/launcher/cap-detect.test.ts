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

    it('keeps the reset timestamp when the gauge and the cap share a line', () => {
      // The filter removes the resets clause, and the timestamp went with it:
      // classified as capped, but with no reset recorded, so the ledger fell
      // back to a fixed backoff.
      const line =
        "You've used 74% of your weekly limit resets 2026-08-12T15:00:00Z, Claude usage limit reached";
      const result = classifyRun({ exitCode: 1, stderr: line });
      expect(result.kind).toBe('capped');
      expect(result.resetAt).toBe(Date.parse('2026-08-12T15:00:00Z'));
      expect(matchesCapText(line)?.resetAt).toBe(Date.parse('2026-08-12T15:00:00Z'));
    });

    it('takes the reason from the stream that carries the cap', () => {
      // A stdout-only cap used to report the generic "usage cap", and an
      // unrelated stderr line could stand in as the evidence.
      const result = classifyRun({
        exitCode: 1,
        stderr: 'some unrelated warning',
        stdout: 'Claude usage limit reached.',
      });
      expect(result.kind).toBe('capped');
      expect(result.reason).toBe('Claude usage limit reached.');
    });

    it('reports the cap LINE as the reason, not whatever line came first', () => {
      const result = classifyRun({
        exitCode: 1,
        stderr: 'an unrelated warning came first\nUsage limit reached.',
      });
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

/**
 * Claude 2.1.302's own words, from its binary, filled in as it fills them. Its
 * message at a limit of the account's own is made one way, "You've hit your
 * <limit><details>", with the limit's name ("session limit", "Opus limit", or
 * just "limit") and a reset time or what to do.
 */
describe("Claude 2.1.302's words at a limit", () => {
  const capped = (line: string): void => {
    expect(matchesCapText(line)?.kind).toBe('capped');
    expect(classifyRun({ exitCode: 1, stderr: line })).toMatchObject({ kind: 'capped', reason: line });
    expect(classifyRun({ exitCode: 1, stderr: '', stdout: line })).toMatchObject({
      kind: 'capped',
      reason: line,
    });
  };
  const notCapped = (line: string): void => {
    expect(matchesCapText(line)).toBeNull();
    expect(classifyRun({ exitCode: 1, stderr: line }).kind).toBe('error');
  };

  describe('the account out of one of its limits', () => {
    for (const line of [
      // Usage credits were tried and turned away: the limit has no name.
      "You've hit your limit · resets 9pm (America/New_York)",
      "You've hit your session limit · resets 6pm (America/New_York)",
      "You've hit your Opus limit · resets Oct 22, 1pm (America/New_York)",
      "You've hit your Sonnet limit · resets Oct 22, 1pm (America/New_York)",
      "You've hit your Fable limit · resets Oct 22, 1pm (America/New_York)",
      "You've hit your usage limit · resets 6pm (America/New_York)",
      "You've hit your usage limit · contact your admin to increase it",
    ]) {
      it(`takes "${line}" for a limit`, () => capped(line));
    }
  });

  describe('a spend limit on usage credits, met as a turn is refused', () => {
    // Usage credits would carry the account past its plan, and the spend
    // limit stops them; the usage check reads a spent plan window as out then.
    for (const line of [
      "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 6pm (America/New_York)",
      "You've hit your channel's monthly spend limit · an org owner or channel manager can raise it in the channel's Claude settings · your session limit resets 6pm (America/New_York)",
      "You've hit your org's monthly spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage",
      "You've hit your team's shared budget · raise it at https://claude.ai/admin-settings/usage",
      // A model that runs only on usage credits.
      "You've hit your monthly spend limit. Switch to another model to continue.",
      "You've hit your channel's monthly spend limit. Switch to another model to continue.",
    ]) {
      it(`takes "${line.slice(0, 60)}" for a limit`, () => capped(line));
    }
  });

  describe('fast mode, which Claude leaves for standard speed and carries on', () => {
    for (const line of [
      // The notification.
      'Fast limit reached and temporarily disabled · resets in 4m 12s',
      // The /fast picker.
      "You've hit your fast limit · resets in 4m 12s",
      // Usage credits stopping fast mode.
      'Fast mode disabled · usage credit limit reached',
      'Fast mode disabled · usage credits exhausted',
    ]) {
      it(`asks nothing about "${line}"`, () => notCapped(line));
    }

    it('still finds the account out of its own limit beside it', () => {
      // On the retry at standard speed, an account that is out says so.
      const screen = [
        'Fast limit reached and temporarily disabled · resets in 4m 12s',
        "You've hit your session limit · resets 6pm (America/New_York)",
      ].join('\n');
      expect(matchesCapText(screen)?.kind).toBe('capped');
      expect(classifyRun({ exitCode: 1, stderr: screen })).toMatchObject({
        kind: 'capped',
        reason: "You've hit your session limit · resets 6pm (America/New_York)",
      });
    });
  });

  it("asks nothing about the usage-credits panel's monthly limit", () => {
    // Shown when the panel is opened, about the credits; a refused turn brings its own line.
    const dash = String.fromCharCode(0x2014);
    notCapped(`You've hit your monthly limit ${dash} raise it below, or it resets next month.`);
  });

  describe('its gauge, which still is not a limit', () => {
    for (const line of [
      "You've used 90% of your session limit · resets 6pm (America/New_York)",
      // The hint at its end, past a reset with a comma in it.
      "You've used 90% of your weekly limit · resets Oct 22, 1pm (America/New_York) · /usage-credits to keep using Claude Code",
      'Approaching session limit · resets 6pm (America/New_York) · Run /usage-credits to turn on extra usage for your org',
      "You've used 95% of your usage credits · Run /usage-credits to raise the cap",
      "You're close to your usage credit limit",
    ]) {
      it(`asks nothing about "${line.slice(0, 60)}"`, () => notCapped(line));
    }
  });
});