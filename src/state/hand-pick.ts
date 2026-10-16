import path from 'node:path';
import { rmSync } from 'node:fs';
import { z } from 'zod';
import { configHome, type PathCtx } from '../config/paths.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';

/**
 * The account somebody chose by hand, so the auto-switch watcher can leave it
 * alone.
 *
 * The active account cannot say this by itself. It changes when a person picks
 * one (`ccx use`, enter in the dashboard, `/ccx`), and it changes just the same
 * when a session whose turn was refused moves on, or when the watcher moves.
 * Only the first of those is a choice the automation should respect, so the
 * places a person chooses write it down here.
 *
 * A pick stands while the account it names is still the active one. Nothing
 * needs to clear it when the account changes: a pick for an account that is
 * no longer in use holds nothing.
 */

const HandPickSchema = z.object({ account: z.string(), at: z.number() });
const FILENAME = 'hand-pick.json';

export type HandPickRecord = z.infer<typeof HandPickSchema>;

function handPickPath(c: PathCtx = {}): string {
  return path.join(configHome(c), FILENAME);
}

/** Write down that a person chose `account`. Best effort: a pick that cannot be recorded is still made. */
export function recordHandPick(account: string, c: PathCtx = {}, now: number = Date.now()): void {
  try {
    writeJsonFile(handPickPath(c), { account, at: now });
  } catch {
    /* the switch itself must not fail over a note about it */
  }
}

/** The standing pick, or null. A file that does not parse reads as no pick. */
export function readHandPick(c: PathCtx = {}): HandPickRecord | null {
  try {
    return readJsonFile(handPickPath(c), HandPickSchema) ?? null;
  } catch {
    return null;
  }
}

/** Forget the pick: the watcher does this when it moves off a picked account that ran out. */
export function clearHandPick(c: PathCtx = {}): void {
  try {
    rmSync(handPickPath(c), { force: true });
  } catch {
    /* already gone */
  }
}
