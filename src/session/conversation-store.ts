import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Which conversation a session is actually in, according to Claude itself.
 *
 * `planConversation` can name the conversation up front for a fresh start, but
 * not when the operator asked for `--continue` or picked one from the list:
 * only Claude knows which thread that turned out to be. It tells us on every
 * status line render, so the answer is recorded there and read back when a swap
 * needs to resume.
 *
 * Ground truth, so it also corrects the planned id if Claude ever hands the
 * conversation a different one than it was asked for.
 */

const FILE = 'conversation.json';

function fileIn(sessionDir: string): string {
  return path.join(sessionDir, FILE);
}

/** Record the conversation this session turned out to be in. */
export function rememberConversation(sessionDir: string, id: string): void {
  try {
    const file = fileIn(sessionDir);
    // Written on every status line render, which is often. Skip the write when
    // it would change nothing rather than churning the disk for no reason.
    if (readConversation(sessionDir) === id) return;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ id })}\n`, 'utf8');
  } catch {
    /* the planned id still works; this only makes it exact */
  }
}

/** The conversation recorded for this session, if one is. */
export function readConversation(sessionDir: string): string | null {
  try {
    const file = fileIn(sessionDir);
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const id = (parsed as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}
