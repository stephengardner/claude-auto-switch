import { existsSync, readFileSync, statSync } from 'node:fs';
import { writeFileAtomic } from '../util/atomic-write.js';
import path from 'node:path';

/**
 * What Claude itself says about the session running in a directory.
 *
 * ccx otherwise has to infer both of these, and both inferences have been
 * wrong in ways that cost the operator a session:
 *
 * - WHICH CONVERSATION. Resuming after a swap used "the most recent one in this
 *   directory", which is a different thread whenever two sessions share a
 *   project.
 * - WHICH MODEL. ccx remembered the model it chose at launch, so after the
 *   operator changed it with `/model` the two disagreed, and a real limit on
 *   the model actually running was dismissed as "that is a limit on a model
 *   you are not using". The session then sat there refusing to rotate.
 *
 * Claude passes both to the status line on every render, so they are recorded
 * there and read back as ground truth. Per session directory, because each
 * terminal has its own and two sessions must not overwrite each other.
 */

const FILE = 'claude-report.json';

export interface ClaudeReport {
  /** The conversation this session is in. */
  id?: string;
  /** The model this session is actually running, as Claude names it. */
  model?: string;
}

function fileIn(sessionDir: string): string {
  return path.join(sessionDir, FILE);
}

/** Record what Claude just reported. Merges, so one render cannot erase the other field. */
export function rememberReport(sessionDir: string, report: ClaudeReport): void {
  try {
    const current = readReport(sessionDir);
    const merged: ClaudeReport = {
      ...current,
      ...(report.id ? { id: report.id } : {}),
      ...(report.model ? { model: report.model } : {}),
    };
    // Written on every status line render, which is constant. Skip the write
    // when nothing changed rather than churning the disk for no reason.
    if (merged.id === current.id && merged.model === current.model) return;
    // Atomic, because this is written on every status line render and read in
    // the middle of a cap decision. A reader catching a truncated file would
    // fall back to the model ccx merely BELIEVES it is running, which is the
    // stale answer this file exists to replace.
    writeFileAtomic(fileIn(sessionDir), `${JSON.stringify(merged)}\n`);
  } catch {
    /* ccx still works on what it inferred; this only makes it exact */
  }
}

/** What was last recorded for this session. Empty when nothing has been. */
export function readReport(sessionDir: string): ClaudeReport {
  try {
    const file = fileIn(sessionDir);
    if (!existsSync(file) || !statSync(file).isFile()) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const { id, model } = parsed as { id?: unknown; model?: unknown };
    return {
      ...(typeof id === 'string' && id !== '' ? { id } : {}),
      ...(typeof model === 'string' && model !== '' ? { model } : {}),
    };
  } catch {
    return {};
  }
}

/** The conversation to resume, when Claude has told us which one. */
export function readConversation(sessionDir: string): string | null {
  return readReport(sessionDir).id ?? null;
}

/** The model actually running, when Claude has told us which one. */
export function readRunningModel(sessionDir: string): string | null {
  return readReport(sessionDir).model ?? null;
}
