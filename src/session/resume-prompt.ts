import { readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { writeSecretFile } from '../util/secret-file.js';

/**
 * A prompt a session arms for its OWN relaunch.
 *
 * When ccx swaps accounts by ending Claude and resuming the conversation, the
 * resumed session opens idle at its prompt. An operator at the keyboard types
 * "continue" and nothing is lost; an unattended session, an autonomous loop
 * running for hours, simply stops there until someone comes back. The account
 * switch was seamless and the work still stopped.
 *
 * So a session can say, ahead of time, what it wants to be told when it comes
 * back. The prompt lives in the session's own directory (`sessions/<pid>`, the
 * `CLAUDE_CONFIG_DIR` Claude runs with), so it belongs to exactly one running
 * session, a session can arm it from inside itself, and it is gone with the
 * session's directory when that session ends. Nothing is armed by default.
 *
 * The prompt becomes ONE command-line argument to Claude, so it is held to one
 * line of printable text: control characters and line breaks become spaces,
 * whitespace collapses, and the ends are trimmed. A prompt that would read as a
 * flag, an empty one, or one longer than the cap is REFUSED rather than altered,
 * because quietly changing what a prompt asks for is worse than saying no.
 */

export const RESUME_PROMPT_FILE = 'resume-prompt.txt';

/** Long enough for a real instruction, short enough to stay a sane argument. */
export const RESUME_PROMPT_MAX_CHARS = 2000;

/**
 * The longest start prompt taken. It becomes one argument on Claude's command
 * line, Windows caps a whole command line at 32,767 characters, and a quote in
 * the text takes two once it is escaped: 15,000 fits, with room for the rest.
 */
export const START_PROMPT_MAX_CHARS = 15_000;

/**
 * A start prompt is somebody's own message, so it is kept exactly as written,
 * lines and all, or refused with the reason: never trimmed into something else.
 */
export function checkStartPrompt(text: string): { ok: true } | { ok: false; reason: string } {
  if (text.trim() === '') return { ok: false, reason: 'it is empty' };
  if (text.includes('\0')) return { ok: false, reason: 'it contains a NUL character' };
  if (text.length > START_PROMPT_MAX_CHARS) {
    return {
      ok: false,
      reason: `it is ${text.length} characters, more than the ${START_PROMPT_MAX_CHARS} one command line can carry`,
    };
  }
  return { ok: true };
}

export type ResumePromptCheck = { ok: true; prompt: string } | { ok: false; reason: string };

export type ResumePromptRead = { armed: true; prompt: string } | { armed: false; invalid?: string };

export function resumePromptPath(sessionDir: string): string {
  return path.join(sessionDir, RESUME_PROMPT_FILE);
}

/** Hold a prompt to the rules above: normalise it, or say why it cannot be used. */
export function checkResumePrompt(raw: string): ResumePromptCheck {
  const prompt = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (prompt === '') return { ok: false, reason: 'the prompt is empty' };
  if (prompt.startsWith('-')) {
    return { ok: false, reason: 'the prompt starts with "-", which Claude would read as a flag' };
  }
  if (prompt.length > RESUME_PROMPT_MAX_CHARS) {
    return {
      ok: false,
      reason: `the prompt is ${prompt.length} characters, longer than the ${RESUME_PROMPT_MAX_CHARS} allowed`,
    };
  }
  return { ok: true, prompt };
}

/**
 * The prompt this session armed, read fresh every time it is asked.
 *
 * Never throws: a relaunch must happen whatever state this file is in. A file
 * that fails the rules (it can only get that way by hand, since the command
 * refuses such text) reads as NOT armed, with the reason, so the relaunch can
 * record why it went ahead without one.
 */
export function readResumePrompt(sessionDir: string): ResumePromptRead {
  let raw: string;
  try {
    raw = readFileSync(resumePromptPath(sessionDir), 'utf8');
  } catch {
    return { armed: false };
  }
  const checked = checkResumePrompt(raw);
  return checked.ok
    ? { armed: true, prompt: checked.prompt }
    : { armed: false, invalid: checked.reason };
}

/** Arm (or re-arm) a session. An invalid prompt is refused and changes nothing. */
export function writeResumePrompt(sessionDir: string, raw: string): ResumePromptCheck {
  const checked = checkResumePrompt(raw);
  if (!checked.ok) return checked;
  // Atomic and owner-only: a relaunch reading while the prompt is re-armed must
  // see the old prompt or the new one, never a truncated file that reads as
  // unarmed and sends the session back to sitting idle.
  writeSecretFile(resumePromptPath(sessionDir), `${checked.prompt}\n`);
  // Arming again undoes a --clear.
  rmSync(path.join(sessionDir, RESUME_PROMPT_OFF_FILE), { force: true });
  return checked;
}

/**
 * Disarm a session, and keep the default (config `resume`) off it too: a
 * session told to resume without a prompt means exactly that. Returns whether
 * a prompt of its own was armed.
 */
export function clearResumePrompt(sessionDir: string): boolean {
  const file = resumePromptPath(sessionDir);
  const was = existsSync(file);
  rmSync(file, { force: true });
  try {
    writeSecretFile(path.join(sessionDir, RESUME_PROMPT_OFF_FILE), 'off\n');
  } catch {
    /* the session folder is gone; nothing will resume it */
  }
  return was;
}

/** Marks a session that resumes without any prompt, its own or the default. */
export const RESUME_PROMPT_OFF_FILE = 'resume-prompt.off';

/** Whether a session was told to resume without a prompt (see clearResumePrompt). */
export function resumePromptOff(sessionDir: string): boolean {
  return existsSync(path.join(sessionDir, RESUME_PROMPT_OFF_FILE));
}
