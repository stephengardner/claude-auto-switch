import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain JavaScript helper, shared with the CI script
import { isBodyFinding, bodyFindings, bodyFindingsAcknowledged, threadAnswered, remedyFor, BODY_ACK, reviewsArePaused } from './coderabbit-findings.mjs';

/**
 * These decide whether a pull request may merge, so both directions matter:
 * missing a finding waves a problem through, and matching ordinary prose blocks
 * work for no reason. Both have already happened here.
 */

const isReviewer = (login: string) => login.toLowerCase().startsWith('coderabbitai');

describe('spotting a finding in a review body', () => {
  it('matches the severity badges CodeRabbit actually uses', () => {
    for (const line of [
      '_🎯 Functional Correctness_ | _🟠 Major_ | _⚡ Quick win_',
      '_🩺 Stability & Availability_ | _🟠 Major_ | _🏗️ Heavy lift_',
      '_⚠️ Potential issue_ | _🔴 Critical_',
      '_🧹 Nitpick_',
      '_🟡 Minor_ | _⚡ Quick win_',
    ]) {
      expect(isBodyFinding(line), line).toBe(true);
    }
  });

  it('matches the headings it groups body findings under, in the shape they arrive', () => {
    expect(isBodyFinding('⚠️ Outside diff range comments (2)')).toBe(true);
    expect(isBodyFinding('🧹 Nitpick comments (3)')).toBe(true);
    // The real thing is wrapped in a blockquote and an HTML summary tag.
    expect(isBodyFinding('> <summary>⚠️ Outside diff range comments (2)</summary><blockquote>')).toBe(true);
    // The sections are often COMBINED. Missing this let every finding under that
    // heading through the gate silently.
    expect(isBodyFinding('🧹 Outside diff range and nitpick comments (5)')).toBe(true);
    expect(
      isBodyFinding('> <summary>🧹 Outside diff range and nitpick comments (5)</summary><blockquote>'),
    ).toBe(true);
  });

  it('does NOT match ordinary prose that merely mentions those words', () => {
    // Each of these blocked, or would have blocked, a real pull request.
    for (const line of [
      'no security issue found',
      'No major concerns with this change.',
      'Security review passed.',
      'This is a critical path in the code, and it is handled correctly.',
      'Reviewed 3 files; nothing to report.',
      '',
      '   ',
      // Formatted reassurance: italics containing a severity word is not a badge.
      '_No major concerns_',
      '_no critical issues found_',
      '_Minor wording only, nothing to change_',
      // A heading only counts when it starts the line.
      'This review has no nitpick comments to report.',
      'See the outside diff range comments section above for context.',
    ]) {
      expect(isBodyFinding(line), line).toBe(false);
    }
  });

  it('collects every finding in a body and ignores the rest', () => {
    const body = [
      '**Actionable comments posted: 2**',
      'no security issue found',
      '_⚠️ Potential issue_ | _🟠 Major_',
      'some explanation of the problem',
      '_🧹 Nitpick_',
    ].join('\n');
    expect(bodyFindings(body)).toEqual(['_⚠️ Potential issue_ | _🟠 Major_', '_🧹 Nitpick_']);
  });

  it('treats missing or odd input as no finding, never as one', () => {
    expect(isBodyFinding(undefined)).toBe(false);
    expect(isBodyFinding(null)).toBe(false);
    expect(bodyFindings(undefined)).toEqual([]);
  });
});

describe('answering body findings', () => {
  const ack = (at: number) => [{ author: 'stephengardner', body: `ok, ${BODY_ACK}`, at }];

  it('needs a human to say they read them, after they were raised', () => {
    expect(bodyFindingsAcknowledged([], isReviewer, 100)).toBe(false);
    expect(bodyFindingsAcknowledged(ack(200), isReviewer, 100)).toBe(true);
  });

  it('does NOT let an earlier acknowledgement clear findings raised later', () => {
    // Otherwise one comment, posted before any review, switches this off forever.
    expect(bodyFindingsAcknowledged(ack(100), isReviewer, 200)).toBe(false);
  });

  it('does not accept an acknowledgement with no usable time', () => {
    expect(
      bodyFindingsAcknowledged([{ author: 'stephengardner', body: BODY_ACK }], isReviewer, 200),
    ).toBe(false);
  });

  it('does not accept the reviewer acknowledging itself', () => {
    expect(
      bodyFindingsAcknowledged([{ author: 'coderabbitai[bot]', body: BODY_ACK, at: 999 }], isReviewer, 100),
    ).toBe(false);
  });
});

describe('answering an inline comment', () => {
  const thread = (over: Record<string, unknown> = {}) => ({
    isResolved: false,
    comments: { nodes: [{ author: { login: 'coderabbitai[bot]' }, body: 'a finding' }] },
    ...over,
  });

  it('resolved counts as answered', () => {
    expect(threadAnswered(thread({ isResolved: true }), isReviewer)).toBe(true);
  });

  it('a human reply counts as answered, including a disagreement', () => {
    const answered = thread({
      comments: {
        nodes: [
          { author: { login: 'coderabbitai[bot]' }, body: 'a finding' },
          { author: { login: 'stephengardner' }, body: 'not a bug, because...' },
        ],
      },
    });
    expect(threadAnswered(answered, isReviewer)).toBe(true);
  });

  it('the reviewer talking to itself does NOT count', () => {
    const stillOpen = thread({
      comments: {
        nodes: [
          { author: { login: 'coderabbitai[bot]' }, body: 'a finding' },
          { author: { login: 'coderabbitai[bot]' }, body: 'still here in the new review' },
        ],
      },
    });
    expect(threadAnswered(stillOpen, isReviewer)).toBe(false);
  });

  it('an untouched thread is not answered', () => {
    expect(threadAnswered(thread(), isReviewer)).toBe(false);
    expect(threadAnswered(undefined, isReviewer)).toBe(false);
  });
});

describe('what it tells you to do', () => {
  it('says the right thing for each kind, not always "reply inline"', () => {
    expect(remedyFor('inline')).toContain('reply on that inline comment');
    expect(remedyFor('review-body')).toContain(BODY_ACK);
    expect(remedyFor('summary-comment')).toContain(BODY_ACK);
  });
});

/**
 * CodeRabbit pauses itself on a busy branch and says so in a comment, while
 * still leaving a green "Review completed" status on the head from its previous
 * pass. On PR 15 that pair made the gate report CLEAR with the newest two
 * commits never looked at, so these assert the exact wording it posted.
 */
const REVIEWER = 'coderabbitai[bot]';
const PAUSED_COMMENT = [
  '> [!TIP]',
  '> It looks like this branch is under active development. To avoid overwhelming',
  '> you with review comments due to an influx of new commits, CodeRabbit has',
  '> automatically paused this review.',
  '',
  '<!-- end of auto-generated comment: review paused by coderabbit.ai -->',
].join('\n');

describe('reviewsArePaused', () => {
  it('sees the pause CodeRabbit actually posted', () => {
    expect(reviewsArePaused([{ author: REVIEWER, body: PAUSED_COMMENT }], isReviewer)).toBe(true);
  });

  it('sees it from the machine marker alone, not only the prose', () => {
    // The prose is wording that may change; the marker is structural.
    const body = '<!-- end of auto-generated comment: review paused by coderabbit.ai -->';
    expect(reviewsArePaused([{ author: REVIEWER, body }], isReviewer)).toBe(true);
  });

  it('is false for an ordinary review summary', () => {
    expect(
      reviewsArePaused(
        [
          { author: REVIEWER, body: 'Actionable comments posted: 2' },
          { author: REVIEWER, body: '<!-- walkthrough_start -->' },
        ],
        isReviewer,
      ),
    ).toBe(false);
  });

  it('ignores the same words from someone who is not the reviewer', () => {
    // Quoting the notice in a human comment must not stall the gate, nor steer it.
    expect(reviewsArePaused([{ author: 'stephengardner', body: PAUSED_COMMENT }], isReviewer)).toBe(
      false,
    );
  });

  it('is false with no comments, and survives a comment with no body', () => {
    expect(reviewsArePaused([], isReviewer)).toBe(false);
    expect(reviewsArePaused([{ author: REVIEWER }], isReviewer)).toBe(false);
  });
});
