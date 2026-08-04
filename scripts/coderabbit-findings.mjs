/**
 * Deciding what counts as a CodeRabbit finding, and when one has been answered.
 *
 * Kept separate from the command so it can be tested directly: this is the part
 * that decides whether a pull request is allowed to merge, and getting it wrong
 * either waves problems through or blocks work forever.
 */

/**
 * A CodeRabbit finding raised inside a review body.
 *
 * Matching bare words does not work: a summary line reading "no security issue
 * found" is not a finding, and treating it as one blocks a pull request over
 * ordinary prose. CodeRabbit marks real findings with an italic severity badge
 * (`_🟠 Major_`) or collects them under headings that name the section, so those
 * are what we look for.
 */
/**
 * A badge is the WHOLE italic label, like `_🟠 Major_`: an icon, a space, the
 * word, nothing else. Allowing other words inside meant `_No major concerns_`
 * counted as a finding, which blocks a merge over reassurance.
 */
const SEVERITY_BADGE = /_[^\w_\n]*(critical|major|minor|nitpick)[^\w_\n]*_/i;

/**
 * A heading STARTS the line (after markdown, a blockquote marker, an HTML
 * summary tag, or an icon), so a sentence that merely mentions "nitpick
 * comments" is not mistaken for the section that contains them.
 *
 * Words are allowed between the phrase and "comments", because the sections are
 * often combined: "Outside diff range and nitpick comments (5)". Requiring
 * "comments" to follow immediately let every finding under that heading through,
 * which is the worse kind of mistake: missing findings is silent, where blocking
 * wrongly at least complains.
 */
const SECTION_HEADING = /^[\s>*_#-]*(?:<summary>)?[^\w<\n]*(?:outside diff range|nitpick)\b[\w\s]*\bcomments?\b/i;

/** Does this single line of a review body raise something? */
export function isBodyFinding(line) {
  const text = String(line ?? '').trim();
  if (text.length === 0) return false;
  return SEVERITY_BADGE.test(text) || SECTION_HEADING.test(text);
}

/** Every finding raised in a block of review-body text. */
export function bodyFindings(body) {
  return String(body ?? '')
    .split('\n')
    .filter((line) => isBodyFinding(line))
    .map((line) => line.trim());
}

/**
 * The phrase that marks review-body findings as dealt with.
 *
 * Findings in a review body cannot be resolved: GitHub offers no button for
 * them, and no reply attaches to them. Without a way to answer them they would
 * block a pull request forever, so answering them is explicit: say once, in a
 * comment, that you have been through them.
 */
export const BODY_ACK = 'guard-ack: body findings reviewed';

/**
 * Has a human said they went through the review-body findings raised at
 * `findingsAt`?
 *
 * The acknowledgement has to come AFTER those findings. Accepting any past one
 * meant a single comment, posted before a review even ran, cleared every body
 * finding from then on: an off switch disguised as a confirmation.
 */
export function bodyFindingsAcknowledged(comments, isReviewer, findingsAt = 0) {
  const cutoff = Number(findingsAt) || 0;
  return (comments ?? []).some((c) => {
    if (isReviewer(c.author ?? '')) return false;
    if (!String(c.body ?? '').toLowerCase().includes(BODY_ACK)) return false;
    const at = Number(c.at) || 0;
    // Without a usable timestamp, treat it as not covering these findings: too
    // permissive here means findings vanish silently.
    return at > cutoff;
  });
}

/**
 * Is an inline thread dealt with? Resolved counts, and so does a human reply:
 * "you are wrong, because..." is a legitimate answer to a review comment.
 *
 * A later review from the reviewer does NOT count. Incremental reviews only
 * cover new changes, so they never close earlier comments.
 */
export function threadAnswered(thread, isReviewer) {
  if (thread?.isResolved) return true;
  const comments = thread?.comments?.nodes ?? [];
  return comments.slice(1).some((c) => !isReviewer(c.author?.login ?? ''));
}

/** What to do about a blocker, worded for the kind of blocker it is. */
export function remedyFor(kind) {
  if (kind === 'inline') {
    return 'Fix it, push, then reply on that inline comment with the fix SHA. If it is wrong, reply saying why.';
  }
  return `Read the findings in the review body, then comment "${BODY_ACK}" on the pull request.`;
}

/**
 * Has CodeRabbit stopped reviewing this branch by itself?
 *
 * It pauses automatic reviews when a branch takes several commits in a row, and
 * says so in a comment of its own. While paused it still leaves a green
 * "Review completed" status on the head from its LAST pass, so the status alone
 * reads exactly like a clean review of the current commit. That pair is a hole
 * to merge unreviewed work through, and it is why this exists.
 *
 * Only the reviewer's own comments count. A human quoting the notice must not
 * be able to stall the gate, or to steer it.
 */
export function reviewsArePaused(comments, isReviewer) {
  const list = comments ?? [];
  // The notice lives in a comment CodeRabbit edits in place, so it stays in the
  // thread for good. Its age has to come from the last edit, not from when the
  // comment first appeared.
  const notices = list.filter(
    (c) =>
      isReviewer(c.author ?? '') &&
      /review paused by coderabbit|automatically paused this review/i.test(c.body ?? ''),
  );
  if (notices.length === 0) return false;
  const pausedAt = Math.max(0, ...notices.map((c) => c.updatedAt ?? c.at ?? 0));
  // A notice with no usable time cannot be shown to have been lifted, and
  // guessing "lifted" would merge unreviewed work. Stay paused.
  if (pausedAt === 0) return true;

  // Asking it to resume or to review lifts the pause. Without this the gate
  // would block forever once a branch had ever been paused, because the notice
  // never leaves the thread, and a gate that cannot be satisfied gets switched
  // off rather than obeyed.
  const liftedAt = Math.max(
    0,
    ...list
      .filter((c) => !isReviewer(c.author ?? '') && /@coderabbitai\s+(resume|review)\b/i.test(c.body ?? ''))
      .map((c) => c.updatedAt ?? c.at ?? 0),
  );
  return pausedAt > liftedAt;
}

/**
 * Has the reviewer actually reviewed THIS commit?
 *
 * Two things that look alike have to be told apart:
 *
 * - a real review, which carries the commit it was written against and has a
 *   body
 * - a record created merely by replying to an inline comment, which has NO body
 *   and is stamped with whatever the head happened to be at that moment
 *
 * Counting the second would mean answering an old finding makes the newest
 * commits look reviewed, which is the false green this exists to stop, arriving
 * by a different route from the paused-review one.
 */
export function hasSubstantiveReviewFor(reviews, sha, isReviewer) {
  if (!sha) return false;
  return (reviews ?? []).some(
    (r) =>
      isReviewer(r.user?.login ?? '') &&
      r.commit_id === sha &&
      String(r.body ?? '').trim().length > 0,
  );
}

