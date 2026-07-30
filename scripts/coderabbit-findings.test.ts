import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain JavaScript helper, shared with the CI script
import { isBodyFinding, bodyFindings, bodyFindingsAcknowledged, threadAnswered, remedyFor, BODY_ACK } from './coderabbit-findings.mjs';

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

  it('matches the headings it groups body findings under', () => {
    expect(isBodyFinding('⚠️ Outside diff range comments (2)')).toBe(true);
    expect(isBodyFinding('🧹 Nitpick comments (3)')).toBe(true);
  });

  it('does NOT match ordinary prose that merely mentions those words', () => {
    // The exact false positive CodeRabbit caught: this blocked a pull request.
    for (const line of [
      'no security issue found',
      'No major concerns with this change.',
      'Security review passed.',
      'This is a critical path in the code, and it is handled correctly.',
      'Reviewed 3 files; nothing to report.',
      '',
      '   ',
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
  it('needs a human to say they read them', () => {
    expect(bodyFindingsAcknowledged([], isReviewer)).toBe(false);
    expect(
      bodyFindingsAcknowledged([{ author: 'stephengardner', body: `ok, ${BODY_ACK}` }], isReviewer),
    ).toBe(true);
  });

  it('does not accept the reviewer acknowledging itself', () => {
    expect(
      bodyFindingsAcknowledged([{ author: 'coderabbitai[bot]', body: BODY_ACK }], isReviewer),
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
