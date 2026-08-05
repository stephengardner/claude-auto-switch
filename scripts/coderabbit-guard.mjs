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
import {
  bodyFindings,
  bodyFindingsAcknowledged,
  threadAnswered,
  remedyFor,
  reviewsArePaused,
  hasSubstantiveReviewFor,
  reviewerCommentCovers,
  commitIsCovered,
  isReviewerLogin,
} from './coderabbit-findings.mjs';

/**
 * This gate's own check name. It has to be excluded when looking for the
 * reviewer's signal, because it also contains the word "coderabbit": without
 * this, the gate reads ITSELF as the reviewer, sees its own success, and decides
 * the review is finished. It did exactly that on its first real run.
 */
const OWN_CHECK = 'coderabbit findings resolved';

/**
 * EVERY comment counts, not only the ones marked serious.
 *
 * Severity is the reviewer's guess. A "nitpick" that turns out to be a real bug
 * still ships the bug, and deciding which comments deserve an answer is how
 * comments go unanswered. So the rule is simple: every comment gets resolved or
 * gets a reply saying why it is wrong.
 */


/** The first non-empty line of a block of text, shortened for one-line output. */
function firstLine(text, limit = 140) {
  const lines = String(text ?? '').split(/\r?\n/);
  return (lines.find((l) => l.trim().length > 0) ?? '').slice(0, limit);
}

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

// Exact identity, not a prefix: see isReviewerLogin for why a prefix was unsafe
// and why two spellings are required.
const isReviewer = isReviewerLogin;

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
    .map((r) => ({ id: r.id, body: r.body ?? '', at: Date.parse(r.submitted_at ?? '') || 0 }))
    .filter((r) => r.body.length > 0);
}

/**
 * What CodeRabbit is doing about the CURRENT commit.
 *
 * It posts its own check per commit, so that check is the honest answer to "has
 * this version been reviewed". Both states matter and both must block:
 *
 * - 'working': a review is running right now. Answered comments from an EARLIER
 *   commit do not cover the code being merged, and clearing on them would merge
 *   in the window before the new review lands.
 * - 'absent': no review, and no reviewer working on one.
 */
function reviewerState(owner, name, pr) {
  try {
    const pull = ghJson(['api', `repos/${owner}/${name}/pulls/${pr}`]);
    const sha = pull?.head?.sha;
    if (!sha) return 'absent';

    const isReviewerSignal = (label = '') => {
      const text = label.toLowerCase();
      return text.includes('coderabbit') && !text.includes(OWN_CHECK);
    };

    // CodeRabbit reports through the commit STATUS api, which is a different
    // list from check runs. Looking in the wrong one made this gate think the
    // review had finished while it was still pending.
    const status = ghJson(['api', `repos/${owner}/${name}/commits/${sha}/status`]);
    const statuses = (status?.statuses ?? []).filter((s) => isReviewerSignal(s.context));
    if (statuses.some((s) => s.state === 'pending')) return 'working';
    if (statuses.length > 0) return 'done';

    // Some setups report as a check run instead; same question, other list.
    const runs = ghJson(['api', `repos/${owner}/${name}/commits/${sha}/check-runs`, '--paginate']);
    const checks = (runs?.check_runs ?? []).filter((r) => isReviewerSignal(r.name));
    if (checks.length === 0) return 'absent';
    return checks.every((r) => r.status === 'completed') ? 'done' : 'working';
  } catch {
    // Cannot tell. Say so rather than assume the happy answer.
    return 'unknown';
  }
}

/** Every comment on the pull request, with who wrote it. */
function allComments(owner, name, pr) {
  const comments = ghJson(['api', `repos/${owner}/${name}/issues/${pr}/comments`, '--paginate']) ?? [];
  return comments.map((c) => ({
    author: c.user?.login ?? '',
    body: c.body ?? '',
    at: Date.parse(c.created_at ?? '') || 0,
    // CodeRabbit edits its summary comment in place, so when it last CHANGED is
    // a different question from when it appeared, and the pause notice lives in
    // that comment.
    updatedAt: Date.parse(c.updated_at ?? c.created_at ?? '') || 0,
  }));
}

function sleepSeconds(seconds) {
  // Synchronous on purpose: this script is a gate, not a server.
  execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${Math.round(seconds * 1000)})`]);
}

/**
 * How long to wait for a review that is still running, in seconds.
 *
 * Without this the gate fails the moment it runs on a push (the review has not
 * landed yet) and then depends on something re-running it later. When that
 * re-run does not happen, the pull request can never merge: a gate that
 * deadlocks protects nothing and gets switched off.
 */
function waitSeconds() {
  const i = process.argv.indexOf('--wait');
  if (i === -1) return 0;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Has CodeRabbit posted an actual review OF the current head commit?
 *
 * Reviews carry the commit they were written against, so this answers a
 * different question from "is there a green status": a status can be left over
 * from an earlier pass, a review cannot.
 *
 * An EMPTY body does not count. Replying to inline comments creates review
 * records with no body of their own, stamped with whatever the head is at that
 * moment, so answering an old finding would otherwise look like a fresh review
 * of code nobody has read. That is the same false green this check exists to
 * stop, arriving by a different route.
 */
function hasReviewForHead(owner, name, pr) {
  try {
    const pull = ghJson(['api', `repos/${owner}/${name}/pulls/${pr}`]);
    const sha = pull?.head?.sha;
    const base = pull?.base?.ref;
    if (!sha) return false;

    const reviews = ghJson(['api', `repos/${owner}/${name}/pulls/${pr}/reviews`, '--paginate']) ?? [];
    const comments = allComments(owner, name, pr);
    const parents = new Map();

    return commitIsCovered(sha, {
      // A review that found NOTHING posts no review object, only a comment
      // naming the range it covered, so both shapes count.
      reviewed: (candidate) =>
        hasSubstantiveReviewFor(reviews, candidate, isReviewer) ||
        reviewerCommentCovers(comments, candidate, isReviewer),
      // Already on the base branch, so it arrived through its own pull request
      // and was reviewed there. "identical" or "behind" both mean contained.
      containedInBase: (candidate) => {
        if (!base) return false;
        try {
          const cmp = ghJson([
            'api',
            `repos/${owner}/${name}/compare/${base}...${candidate}`,
          ]);
          return cmp?.status === 'identical' || cmp?.status === 'behind';
        } catch {
          return false; // cannot tell, so do not claim it is covered
        }
      },
      parentsOf: (candidate) => {
        if (!parents.has(candidate)) {
          const commit = ghJson(['api', `repos/${owner}/${name}/commits/${candidate}`]);
          parents.set(candidate, (commit?.parents ?? []).map((p) => p.sha));
        }
        return parents.get(candidate);
      },
    });
  } catch {
    return false; // cannot tell, so do not claim it was reviewed
  }
}

/** Read everything the decision depends on, in one go. */
function readPullRequest(owner, name, pr) {
  const comments = allComments(owner, name, pr);
  return {
    threads: reviewThreads(owner, name, pr),
    bodies: reviewBodies(owner, name, pr),
    comments,
    summaries: comments.filter((c) => isReviewer(c.author)),
    paused: reviewsArePaused(comments, isReviewer),
  };
}

/** Everything still waiting for an answer, worked out from one snapshot. */
function collectBlockers(snapshot) {
  const blockers = [];

  for (const thread of snapshot.threads) {
    const first = thread.comments?.nodes?.[0];
    if (!first || !isReviewer(first.author?.login)) continue;
    if (threadAnswered(thread, isReviewer)) continue;
    blockers.push({
      kind: 'inline',
      where: `${first.path ?? '?'}:${first.line ?? '?'}`,
      excerpt: firstLine(first.body),
    });
  }

  // Findings raised inside a review body cannot be resolved and cannot be
  // replied to, so they are answered once, explicitly, by a comment.
  const raised = [
    ...snapshot.bodies.map((r) => ({ kind: 'review-body', where: `review ${r.id}`, at: r.at, findings: bodyFindings(r.body) })),
    ...snapshot.summaries.map((c) => ({ kind: 'summary-comment', where: 'summary', at: c.at, findings: bodyFindings(c.body) })),
  ].filter((r) => r.findings.length > 0);

  // The acknowledgement must be newer than the newest finding it clears.
  const newestFinding = raised.reduce((newest, r) => Math.max(newest, r.at), 0);
  if (!bodyFindingsAcknowledged(snapshot.comments, isReviewer, newestFinding)) {
    for (const source of raised) {
      for (const finding of source.findings) {
        blockers.push({ kind: source.kind, where: source.where, excerpt: finding.slice(0, 140) });
      }
    }
  }
  return blockers;
}

/**
 * Exit with the verdict stated in words on the LAST line.
 *
 * The exit code alone is not enough to rely on: a caller who pipes this command
 * (even `| head`, to shorten the output) reads the PIPE's exit code, not this
 * one, and a BLOCKED run then looks like a pass. That mistake merged a pull
 * request once and nearly did so again, so the verdict is also printed where it
 * cannot be mistaken for anything else.
 */
function verdict(code, label) {
  console.error(`coderabbit-guard: VERDICT ${label} (exit ${code})`);
  if (code !== 0) {
    console.error("If you piped this command, $? is the pipe's exit code, not this one.");
    console.error('Run it alone:  guard > out.txt; echo "GATE:$?"; cat out.txt');
  }
  process.exit(code);
}

function main() {
  const pr = Number(process.argv[2]);
  const asJson = process.argv.includes('--json');
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error('usage: node scripts/coderabbit-guard.mjs <pr-number> [--json] [--wait <seconds>]');
    process.exit(2);
  }
  const say = asJson ? console.error : console.log;

  let owner, name, snapshot, state;
  try {
    ({ owner, name } = repoSlug());
    snapshot = readPullRequest(owner, name, pr);
    state = reviewerState(owner, name, pr);
  } catch (err) {
    // Could not ask GitHub. Not knowing is not the same as being clear.
    console.error(`coderabbit-guard: could not read PR #${pr}: ${firstLine(err.message)}`);
    process.exit(2);
  }

  /**
   * Has this reviewer said anything about THIS commit yet?
   *
   * If it has reviewed the pull request before but has posted nothing about the
   * current commit, a review is expected and simply has not started. Reading the
   * older review as approval is how the moments right after a push become a hole
   * to merge through.
   */
  const expectsReview = () => state === 'absent' && snapshot.threads.length + snapshot.bodies.length > 0;
  if (expectsReview()) state = 'working';

  // A review in progress gets time to finish, and EVERYTHING is re-read after,
  // so the verdict is never a mix of old comments and a new review.
  const deadline = Date.now() + waitSeconds() * 1000;
  while (state === 'working' && Date.now() < deadline) {
    console.error('coderabbit-guard: CodeRabbit is still reviewing; waiting...');
    sleepSeconds(20);
    try {
      snapshot = readPullRequest(owner, name, pr);
      state = reviewerState(owner, name, pr);
      if (expectsReview()) state = 'working';
    } catch {
      break; // the checks below fail safe
    }
  }

  const blockers = collectBlockers(snapshot);
  const reviewed =
    snapshot.threads.length > 0 || snapshot.bodies.length > 0 || snapshot.summaries.length > 0;
  if (asJson) {
    console.log(JSON.stringify({ schemaVersion: 1, pr, reviewed, reviewerState: state, blockers }, null, 2));
  }

  if (state === 'working') {
    console.error(`coderabbit-guard: PR #${pr} BLOCKED: no finished CodeRabbit review for this commit.`);
    console.error('Answered comments from an earlier commit do not cover this one.');
    console.error('Wait for the review to appear and finish, then run this again.');
    verdict(1, 'BLOCKED');
  }
  // The head must have been REVIEWED, whatever the pause state says. Asking
  // this only while paused was a false green: commenting "@coderabbitai review"
  // lifts the pause the moment it is posted, so a run straight afterwards
  // reported CLEAR having checked nothing about the new head. The pause is only
  // ever the explanation for why coverage is missing, never a substitute for it.
  if (!hasReviewForHead(owner, name, pr)) {
    console.error(`coderabbit-guard: PR #${pr} BLOCKED: the head commit has not been reviewed.`);
    if (snapshot.paused) {
      console.error('CodeRabbit has PAUSED reviews on this branch, so the green status on the');
      console.error('head is from its last pass. Comment "@coderabbitai review", WAIT for the');
      console.error('review to land, then run this again.');
    } else {
      console.error('Wait for the review of this commit to finish, then run this again.');
    }
    verdict(1, 'BLOCKED');
  }
  if (!reviewed) {
    if (state === 'done') {
      console.error(`coderabbit-guard: PR #${pr} BLOCKED: CodeRabbit has not posted its review yet.`);
      verdict(1, 'BLOCKED');
    }
    console.error(`coderabbit-guard: PR #${pr} has no CodeRabbit review, and CodeRabbit does not appear to be reviewing this repo.`);
    verdict(2, 'UNKNOWN (stop and look)');
  }
  if (blockers.length === 0) {
    say(`coderabbit-guard: PR #${pr} is clear (every CodeRabbit comment is resolved or answered).`);
    verdict(0, 'CLEAR');
  }

  console.error(`coderabbit-guard: PR #${pr} BLOCKED by ${blockers.length} unanswered comment(s):`);
  for (const b of blockers) console.error(`  [${b.kind}] ${b.where}  ${b.excerpt}`);
  console.error('');
  for (const kind of [...new Set(blockers.map((b) => b.kind))]) {
    console.error(`  ${kind}: ${remedyFor(kind)}`);
  }
  console.error('');
  console.error('A later review does not clear these; it only covers new changes.');
  verdict(1, 'BLOCKED');
}

main();
