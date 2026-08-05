import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain JavaScript helper, shared with the CI script
import { isBodyFinding, bodyFindings, bodyFindingsAcknowledged, threadAnswered, remedyFor, BODY_ACK, reviewsArePaused, hasSubstantiveReviewFor, reviewerCommentCovers, commitIsCovered, isReviewerLogin } from './coderabbit-findings.mjs';

/**
 * These decide whether a pull request may merge, so both directions matter:
 * missing a finding waves a problem through, and matching ordinary prose blocks
 * work for no reason. Both have already happened here.
 */

// The real identity check, not a copy of it: a duplicate here would keep passing
// after the real one changed, which is how a gate's tests stop testing the gate.
const isReviewer = isReviewerLogin;
const REVIEWER = 'coderabbitai[bot]';

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
const PAUSED_COMMENT = [
  '> [!TIP]',
  '> It looks like this branch is under active development. To avoid overwhelming',
  '> you with review comments due to an influx of new commits, CodeRabbit has',
  '> automatically paused this review.',
  '',
  '<!-- end of auto-generated comment: review paused by coderabbit.ai -->',
].join('\n');

describe('isReviewerLogin', () => {
  it('accepts BOTH spellings GitHub uses for the same bot', () => {
    // Not decoration: REST renders this actor as "coderabbitai[bot]" and
    // GraphQL renders it as "coderabbitai". Inline findings are read through
    // GraphQL, so allowing only the REST form would silently stop counting them,
    // which fails in the direction that merges bugs.
    expect(isReviewerLogin('coderabbitai[bot]')).toBe(true);
    expect(isReviewerLogin('coderabbitai')).toBe(true);
    expect(isReviewerLogin('CodeRabbitAI[bot]')).toBe(true);
  });

  it('REJECTS a login that merely starts with the reviewer name', () => {
    // GitHub logins are first come, first served, so this was registerable. A
    // prefix test would have let it satisfy the gate, or block it with a forged
    // pause notice.
    expect(isReviewerLogin('coderabbitai-fake')).toBe(false);
    expect(isReviewerLogin('coderabbitai-bot')).toBe(false);
    expect(isReviewerLogin('coderabbitai2')).toBe(false);
    expect(isReviewerLogin('coderabbitai[bot]x')).toBe(false);
  });

  it('rejects anyone else, and missing input', () => {
    expect(isReviewerLogin('notcoderabbitai')).toBe(false);
    expect(isReviewerLogin('stephengardner')).toBe(false);
    expect(isReviewerLogin('')).toBe(false);
    expect(isReviewerLogin(undefined)).toBe(false);
    expect(isReviewerLogin(null)).toBe(false);
  });
});

describe('hasSubstantiveReviewFor', () => {
  const HEAD = 'bb086dcaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const OLD = '15e4087bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const review = (over: Record<string, unknown> = {}) => ({
    user: { login: REVIEWER },
    commit_id: HEAD,
    body: 'Actionable comments posted: 1',
    ...over,
  });

  it('counts a real review of this commit', () => {
    expect(hasSubstantiveReviewFor([review()], HEAD, isReviewer)).toBe(true);
  });

  it('does NOT count an empty record, which is what a reply leaves behind', () => {
    // Replying to an inline comment creates a review record with no body,
    // stamped with whatever the head is at that moment. Counting it would mean
    // answering an old finding makes the newest commits look reviewed.
    expect(hasSubstantiveReviewFor([review({ body: '' })], HEAD, isReviewer)).toBe(false);
    expect(hasSubstantiveReviewFor([review({ body: '   ' })], HEAD, isReviewer)).toBe(false);
    expect(hasSubstantiveReviewFor([review({ body: null })], HEAD, isReviewer)).toBe(false);
  });

  it('does NOT count a real review of an EARLIER commit', () => {
    expect(hasSubstantiveReviewFor([review({ commit_id: OLD })], HEAD, isReviewer)).toBe(false);
  });

  it('does not count a review by anyone other than the reviewer', () => {
    expect(
      hasSubstantiveReviewFor([review({ user: { login: 'stephengardner' } })], HEAD, isReviewer),
    ).toBe(false);
  });

  it('says no rather than yes when there is nothing to go on', () => {
    // Not knowing must never read as approval.
    expect(hasSubstantiveReviewFor([], HEAD, isReviewer)).toBe(false);
    expect(hasSubstantiveReviewFor(undefined, HEAD, isReviewer)).toBe(false);
    expect(hasSubstantiveReviewFor([review()], '', isReviewer)).toBe(false);
    expect(hasSubstantiveReviewFor([review()], undefined, isReviewer)).toBe(false);
  });
});

describe('reviewsArePaused', () => {
  const paused = (at: number) => ({ author: REVIEWER, body: PAUSED_COMMENT, updatedAt: at });
  const asked = (at: number, what = 'review') => ({
    author: 'stephengardner',
    body: `@coderabbitai ${what}`,
    updatedAt: at,
  });

  it('is lifted by a later request to resume or review', () => {
    // The notice never leaves the thread, because it lives in a comment
    // CodeRabbit edits in place. Without this the gate would block forever on
    // any branch that had ever been paused, and a gate that cannot be satisfied
    // gets switched off rather than obeyed.
    expect(reviewsArePaused([paused(100), asked(200)], isReviewer)).toBe(false);
    expect(reviewsArePaused([paused(100), asked(200, 'resume')], isReviewer)).toBe(false);
  });

  it('is NOT lifted by a request that came before the pause', () => {
    expect(reviewsArePaused([asked(100), paused(200)], isReviewer)).toBe(true);
  });

  it('uses the last EDIT of the notice, not when the comment first appeared', () => {
    // The summary comment is old and rewritten constantly; created_at would say
    // the pause is ancient and always lifted.
    const editedLater = { author: REVIEWER, body: PAUSED_COMMENT, at: 100, updatedAt: 300 };
    expect(reviewsArePaused([editedLater, asked(200)], isReviewer)).toBe(true);
  });

  it('ignores a resume asked for by the reviewer itself', () => {
    // Its own auto-reply quotes the command back, which must not clear a pause
    // it has just declared.
    const selfAsk = { author: REVIEWER, body: '@coderabbitai resume', updatedAt: 200 };
    expect(reviewsArePaused([paused(100), selfAsk], isReviewer)).toBe(true);
  });

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

describe('reviewerCommentCovers', () => {
  const HEAD = '310568b853477099226d22d8b29636df7273b646';
  const OLD = 'b5b9bdcabef6319d14b45a2510363852b72e49b9';
  const isReviewer = (login: string) => isReviewerLogin(login);

  const summary = (from: string, to: string) => ({
    author: 'coderabbitai[bot]',
    body: `No actionable comments were generated in the recent review.\n\nReviewing files that changed from the base of the PR and between ${from} and ${to}.`,
  });

  it('counts a clean review, which posts no review object at all', () => {
    // The case that mattered: a review finding nothing says so in a comment and
    // creates no review record, so judging by records alone cannot tell
    // "reviewed and clean" from "never reviewed".
    expect(reviewerCommentCovers([summary(OLD, HEAD)], HEAD, isReviewer)).toBe(true);
  });

  it('does not count a comment about an EARLIER head', () => {
    expect(reviewerCommentCovers([summary('aaa', OLD)], HEAD, isReviewer)).toBe(false);
  });

  it('ignores a comment from anyone but the reviewer', () => {
    // Otherwise quoting a SHA in a reply would mark your own commit reviewed.
    expect(
      reviewerCommentCovers([{ author: 'stephengardner', body: `looks fine at ${HEAD}` }], HEAD, isReviewer),
    ).toBe(false);
  });

  it('refuses a login that merely LOOKS like the reviewer', () => {
    // Anyone can register a name starting with the reviewer's. Matching by
    // prefix would let them mark a commit reviewed by quoting its SHA.
    expect(
      reviewerCommentCovers([{ author: 'coderabbitai-fake', body: `at ${HEAD}` }], HEAD, isReviewer),
    ).toBe(false);
  });

  it('refuses a short or missing sha rather than matching loosely', () => {
    // A 7-character prefix appears inside plenty of unrelated text.
    expect(reviewerCommentCovers([summary(OLD, HEAD)], '310568b', isReviewer)).toBe(false);
    expect(reviewerCommentCovers([summary(OLD, HEAD)], '', isReviewer)).toBe(false);
  });

  it('survives an empty or absent comment list', () => {
    expect(reviewerCommentCovers([], HEAD, isReviewer)).toBe(false);
    expect(reviewerCommentCovers(undefined, HEAD, isReviewer)).toBe(false);
  });

  it('reads the login from either shape the APIs return', () => {
    // Comments come back as {author} from one helper and {user:{login}} raw.
    expect(
      reviewerCommentCovers([{ user: { login: 'coderabbitai' }, body: `at ${HEAD}` }], HEAD, isReviewer),
    ).toBe(true);
  });
});

describe('commitIsCovered', () => {
  /** Build the three lookups from plain sets, so a case reads as a picture. */
  const world = (opts: {
    reviewed?: string[];
    inBase?: string[];
    parents?: Record<string, string[]>;
  }) => ({
    reviewed: (sha: string) => (opts.reviewed ?? []).includes(sha),
    containedInBase: (sha: string) => (opts.inBase ?? []).includes(sha),
    parentsOf: (sha: string) => (opts.parents ?? {})[sha] ?? [],
  });

  it('counts a head the reviewer looked at', () => {
    expect(commitIsCovered('head', world({ reviewed: ['head'] }))).toBe(true);
  });

  it('refuses a head nobody reviewed', () => {
    // The false green this exists to stop.
    expect(commitIsCovered('head', world({ reviewed: ['older'] }))).toBe(false);
  });

  it('counts a merge that brings together a reviewed head and the base', () => {
    // Updating a branch from the base adds no reviewable change, and the
    // reviewer says so ("No files to review"). Without this the pull request
    // could never be covered again and would be unmergeable for good.
    const merge = world({
      reviewed: ['reviewed-head'],
      inBase: ['main-tip'],
      parents: { merge: ['reviewed-head', 'main-tip'] },
    });
    expect(commitIsCovered('merge', merge)).toBe(true);
  });

  it('refuses a merge whose other parent is neither reviewed nor in the base', () => {
    // Merging someone else's unreviewed branch must not inherit coverage.
    const merge = world({
      reviewed: ['reviewed-head'],
      inBase: [],
      parents: { merge: ['reviewed-head', 'stranger'] },
    });
    expect(commitIsCovered('merge', merge)).toBe(false);
  });

  it('does NOT let a plain commit inherit from its parent', () => {
    // The whole point. A normal commit adds work of its own, so inheriting
    // would let every later commit ride an old review.
    const plain = world({ reviewed: ['parent'], parents: { head: ['parent'] } });
    expect(commitIsCovered('head', plain)).toBe(false);
  });

  it('walks a chain of merges', () => {
    const chain = world({
      reviewed: ['reviewed-head'],
      inBase: ['main-1', 'main-2'],
      parents: { top: ['inner', 'main-2'], inner: ['reviewed-head', 'main-1'] },
    });
    expect(commitIsCovered('top', chain)).toBe(true);
  });

  it('stops rather than looping when history refers to itself', () => {
    const loop = world({ parents: { a: ['b', 'c'], b: ['a', 'c'], c: ['a', 'b'] } });
    expect(commitIsCovered('a', loop)).toBe(false);
  });

  it('refuses an empty sha instead of treating it as covered', () => {
    expect(commitIsCovered('', world({ reviewed: [''] }))).toBe(false);
  });
});
