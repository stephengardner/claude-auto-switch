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
const SEVERITY_BADGE = /_[^_\n]*\b(critical|major|minor|nitpick)\b[^_\n]*_/i;
const SECTION_HEADING = /(outside diff range|nitpick)\s+comments?/i;

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

/** Has a human said they went through the review-body findings? */
export function bodyFindingsAcknowledged(comments, isReviewer) {
  return (comments ?? []).some(
    (c) => !isReviewer(c.author ?? '') && String(c.body ?? '').toLowerCase().includes(BODY_ACK),
  );
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
