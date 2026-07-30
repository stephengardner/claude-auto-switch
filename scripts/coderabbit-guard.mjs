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
} from './coderabbit-findings.mjs';

const REVIEWER = 'coderabbitai';
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
  }));
}

function main() {
  const pr = Number(process.argv[2]);
  const asJson = process.argv.includes('--json');
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error('usage: node scripts/coderabbit-guard.mjs <pr-number> [--json]');
    process.exit(2);
  }

  let owner, name, threads, bodies, summaries, humanComments;
  try {
    ({ owner, name } = repoSlug());
    threads = reviewThreads(owner, name, pr);
    bodies = reviewBodies(owner, name, pr);
    const comments = allComments(owner, name, pr);
    humanComments = comments;
    summaries = comments.filter((c) => isReviewer(c.author));
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
    if (threadAnswered(thread, isReviewer)) continue;
    blockers.push({
      kind: 'inline',
      where: `${first.path ?? '?'}:${first.line ?? '?'}`,
      excerpt: (first.body ?? '').split('\n').find((l) => l.trim().length > 0)?.slice(0, 140) ?? '',
    });
  }

  // Findings raised inside a review body cannot be resolved and cannot be
  // replied to, so they are answered once, explicitly, by a comment saying they
  // have been read. Without that they would block the pull request forever.
  const raised = [
    ...bodies.map((r) => ({ kind: 'review-body', where: `review ${r.id}`, at: r.at, findings: bodyFindings(r.body) })),
    ...summaries.map((c) => ({ kind: 'summary-comment', where: 'summary', at: c.at, findings: bodyFindings(c.body) })),
  ].filter((r) => r.findings.length > 0);

  // The acknowledgement must be newer than the newest finding it is clearing.
  const newestFinding = raised.reduce((newest, r) => Math.max(newest, r.at), 0);
  const acknowledged = bodyFindingsAcknowledged(humanComments, isReviewer, newestFinding);
  if (!acknowledged) {
    for (const source of raised) {
      for (const finding of source.findings) {
        blockers.push({ kind: source.kind, where: source.where, excerpt: finding.slice(0, 140) });
      }
    }
  }

  const reviewed = threads.length > 0 || bodies.length > 0 || summaries.length > 0;
  const state = reviewerState(owner, name, pr);
  if (asJson) {
    console.log(JSON.stringify({ schemaVersion: 1, pr, reviewed, reviewerState: state, blockers }, null, 2));
  }

  // A review still running is not a passed review, even when every comment from
  // the previous commit has been answered: those answers were about older code.
  if (state === 'working') {
    console.error(`coderabbit-guard: PR #${pr} BLOCKED: CodeRabbit is still reviewing this commit.`);
    console.error('Answered comments from an earlier commit do not cover this one. Wait for it to finish.');
    process.exit(1);
  }
  if (!reviewed) {
    if (state === 'done') {
      console.error(`coderabbit-guard: PR #${pr} BLOCKED: CodeRabbit has not posted its review yet.`);
      console.error('Wait for the review, answer every comment, then this clears.');
      process.exit(1);
    }
    console.error(`coderabbit-guard: PR #${pr} has no CodeRabbit review, and CodeRabbit does not appear to be reviewing this repo.`);
    process.exit(2);
  }
  if (blockers.length === 0) {
    console.log(`coderabbit-guard: PR #${pr} is clear (every CodeRabbit comment is resolved or answered).`);
    process.exit(0);
  }

  console.error(`coderabbit-guard: PR #${pr} BLOCKED by ${blockers.length} unanswered comment(s):`);
  for (const b of blockers) console.error(`  [${b.kind}] ${b.where}  ${b.excerpt}`);
  console.error('');
  for (const kind of [...new Set(blockers.map((b) => b.kind))]) {
    console.error(`  ${kind}: ${remedyFor(kind)}`);
  }
  console.error('');
  console.error('A later review does not clear these; it only covers new changes.');
  process.exit(1);
}

main();
