#!/usr/bin/env node
/**
 * Refuse to merge while ANY CodeRabbit comment is still unanswered.
 *
 * Usage:  node scripts/coderabbit-guard.mjs <pr-number> [--json]
 * Exit:   0 = clear to merge, 1 = blocked, 2 = could not tell
 *
 * Two lessons are built into this on purpose, both learned the hard way:
 *
 * 1. Findings hide in the review BODY, not only in inline comments. A review
 *    whose inline comments are all answered can still carry unaddressed items in
 *    its "outside diff range" section, which is how a pull request once merged
 *    with seven of them.
 * 2. An incremental re-review does NOT close earlier comments. A finding counts
 *    as handled only when the thread is resolved or someone has replied to it,
 *    so "waiting for a re-review" never clears this gate.
 *
 * Exit code 2 (could not tell) is deliberately distinct from 1 (blocked): not
 * knowing must never be reported as approval.
 */

import { execFileSync } from 'node:child_process';

const REVIEWER = 'coderabbitai';

/**
 * EVERY comment counts, not only the ones marked serious.
 *
 * Severity is the reviewer's guess. A "nitpick" that turns out to be a real bug
 * still ships the bug, and deciding which comments deserve an answer is how
 * comments go unanswered. So the rule is simple: every comment gets resolved or
 * gets a reply saying why it is wrong.
 */

/**
 * Headings CodeRabbit uses when it raises something inside a review body, where
 * GitHub offers no "resolve" button. Kept narrow so ordinary summary prose does
 * not read as a finding; widen it in LESSONS.md when a real review proves it too
 * narrow.
 */
const BODY_FINDING = /(potential issue|refactor suggestion|nitpick|possible bug|security|outside diff range)/i;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function ghJson(args) {
  const out = gh(args).trim();
  return out.length > 0 ? JSON.parse(out) : null;
}

function repoSlug() {
  const { owner, name } = ghJson(['repo', 'view', '--json', 'owner,name']);
  return { owner: owner.login, name };
}

function isReviewer(login = '') {
  return login.toLowerCase().startsWith(REVIEWER);
}

/**
 * Review threads with their resolution state. GraphQL is the only place GitHub
 * exposes whether a thread was resolved, which is exactly what decides this.
 */
function reviewThreads(owner, name, pr) {
  const query = `
    query($owner:String!, $name:String!, $pr:Int!) {
      repository(owner:$owner, name:$name) {
        pullRequest(number:$pr) {
          reviewThreads(first:100) {
            nodes {
              isResolved
              isOutdated
              comments(first:50) {
                nodes { author { login } body path line }
              }
            }
          }
        }
      }
    }`;
  const data = ghJson([
    'api', 'graphql',
    '-f', `query=${query}`,
    '-F', `owner=${owner}`,
    '-F', `name=${name}`,
    '-F', `pr=${pr}`,
  ]);
  return data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
}

/** Review bodies, where "outside diff range" findings live. */
function reviewBodies(owner, name, pr) {
  const reviews = ghJson(['api', `repos/${owner}/${name}/pulls/${pr}/reviews`, '--paginate']) ?? [];
  return reviews
    .filter((r) => isReviewer(r.user?.login))
    .map((r) => ({ id: r.id, body: r.body ?? '' }))
    .filter((r) => r.body.length > 0);
}

/** Issue-level comments, where CodeRabbit also posts summaries. */
function issueComments(owner, name, pr) {
  const comments = ghJson(['api', `repos/${owner}/${name}/issues/${pr}/comments`, '--paginate']) ?? [];
  return comments.filter((c) => isReviewer(c.user?.login)).map((c) => c.body ?? '');
}

function main() {
  const pr = Number(process.argv[2]);
  const asJson = process.argv.includes('--json');
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error('usage: node scripts/coderabbit-guard.mjs <pr-number> [--json]');
    process.exit(2);
  }

  let owner, name, threads, bodies, summaries;
  try {
    ({ owner, name } = repoSlug());
    threads = reviewThreads(owner, name, pr);
    bodies = reviewBodies(owner, name, pr);
    summaries = issueComments(owner, name, pr);
  } catch (err) {
    // Could not ask GitHub. Not knowing is not the same as being clear.
    console.error(`coderabbit-guard: could not read PR #${pr}: ${err.message.split('\n')[0]}`);
    process.exit(2);
  }

  const blockers = [];

  for (const thread of threads) {
    const comments = thread.comments?.nodes ?? [];
    const first = comments[0];
    if (!first || !isReviewer(first.author?.login)) continue;
    // Resolved, or answered by a human reply: handled either way.
    const answered = thread.isResolved || comments.slice(1).some((c) => !isReviewer(c.author?.login));
    if (answered) continue;
    blockers.push({
      kind: 'inline',
      where: `${first.path ?? '?'}:${first.line ?? '?'}`,
      excerpt: (first.body ?? '').split('\n').find((l) => l.trim().length > 0)?.slice(0, 140) ?? '',
    });
  }

  // Body findings cannot be "resolved" in GitHub's UI, so they are reported for
  // a human to confirm rather than silently ignored.
  for (const review of bodies) {
    for (const line of review.body.split('\n')) {
      if (BODY_FINDING.test(line) && line.trim().length > 0) {
        blockers.push({ kind: 'review-body', where: `review ${review.id}`, excerpt: line.trim().slice(0, 140) });
      }
    }
  }
  for (const body of summaries) {
    for (const line of body.split('\n')) {
      if (BODY_FINDING.test(line) && line.trim().length > 0) {
        blockers.push({ kind: 'summary-comment', where: 'summary', excerpt: line.trim().slice(0, 140) });
      }
    }
  }

  const reviewed = threads.length > 0 || bodies.length > 0 || summaries.length > 0;
  if (asJson) {
    console.log(JSON.stringify({ schemaVersion: 1, pr, reviewed, blockers }, null, 2));
  }

  if (!reviewed) {
    console.error(`coderabbit-guard: PR #${pr} has no CodeRabbit review yet; nothing to clear.`);
    process.exit(2);
  }
  if (blockers.length === 0) {
    console.log(`coderabbit-guard: PR #${pr} is clear (every CodeRabbit comment is resolved or answered).`);
    process.exit(0);
  }

  console.error(`coderabbit-guard: PR #${pr} BLOCKED by ${blockers.length} unanswered comment(s):`);
  for (const b of blockers) console.error(`  [${b.kind}] ${b.where}  ${b.excerpt}`);
  console.error('');
  console.error('Fix each one, push, then REPLY on that inline comment with the fix SHA.');
  console.error('If a finding is wrong, reply saying why. A re-review does not clear these.');
  process.exit(1);
}

main();
