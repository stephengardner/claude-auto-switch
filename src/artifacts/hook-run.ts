import { readFileSync } from 'node:fs';
import { isSessionDir } from '../session/session-dir.js';
import { afterArtifactCall, beforeArtifactCall, type HookAnswer, type HookInput } from './hook.js';
import { SCAN_ENV } from './scan.js';

const EVENT_NAMES = { pre: 'PreToolUse', post: 'PostToolUse', fail: 'PostToolUseFailure' } as const;
type Event = keyof typeof EVENT_NAMES;

/**
 * What Claude reads from a hook's standard output. A refusal is only ever
 * given before the call. Nothing here ever approves one: with no decision in
 * it, Claude's own permission rules and questions apply as they would have.
 */
export function hookOutput(event: Event, answer: HookAnswer): string {
  if (answer === null) return '';
  const hookEventName = EVENT_NAMES[event];
  if ('deny' in answer) {
    return event === 'pre'
      ? JSON.stringify({
          hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason: answer.deny },
        })
      : '';
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: answer.context } });
}

/** One run of the hook: Claude's description of the call on standard input, the answer on standard output. */
export async function runArtifactHook(event: string | undefined, sessionDir: string): Promise<void> {
  if (event !== 'pre' && event !== 'post' && event !== 'fail') return;
  if (!isSessionDir(sessionDir)) return;
  let input: HookInput;
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
  } catch {
    return; // nothing to go on
  }
  if (typeof input !== 'object' || input === null) return;
  const env = { sessionDir, ctx: {}, scanDir: process.env[SCAN_ENV] || null };
  let answer: HookAnswer;
  try {
    answer =
      event === 'pre'
        ? await beforeArtifactCall(input, env)
        : await afterArtifactCall(input, env, event === 'fail');
  } catch {
    return;
  }
  const text = hookOutput(event, answer);
  if (text !== '') process.stdout.write(`${text}\n`);
}
