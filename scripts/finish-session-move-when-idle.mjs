/**
 * Finish the session move once the session has stopped writing, then remove the
 * scheduled task that runs this.
 *
 * A plain background watcher was tried first and did not survive: a process
 * spawned from inside the session gets killed with it, and going through WMI
 * only moved the problem. So this runs from Task Scheduler, which is owned by a
 * service rather than by any process tree, and therefore also survives a reboot.
 *
 * Liveness is judged by the LEFTOVER FILE, not by a pid. Pids are reused after a
 * reboot, which would make a stale pid check either wrong or permanently stuck.
 * A file nobody has appended to for IDLE_MINUTES belongs to a session that is
 * over.
 *
 * Merging always runs and is non-destructive; only the delete waits for idle. If
 * a live-but-idle session is ever caught by this, nothing is lost: entries are
 * matched by uuid, so the next run merges whatever reappeared.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const SID = 'ef2b2b73-9600-4c2e-bcda-9b09c90047fb';
const PROJECTS = 'C:/Users/opens/.claude/projects';
const SRC = path.join(PROJECTS, 'C--Users-opens-shop-sheriff-sms-root', `${SID}.jsonl`);
const FINISH = 'C:/Users/opens/claude-auto-switch/scripts/finish-session-move.mjs';
const LOG = path.join(PROJECTS, 'C--Users-opens-claude-auto-switch', 'session-move.log');
const TASK = 'ccx-finish-session-move';
const IDLE_MINUTES = 10;

const say = (message) => {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    /* the log is a convenience, never a reason to skip the cleanup */
  }
};

/** Stop this task from ever running again. */
const unregister = () => {
  const done = spawnSync('schtasks', ['/Delete', '/TN', TASK, '/F'], { encoding: 'utf8' });
  say(done.status === 0 ? 'scheduled task removed; nothing further to do' : 'could not remove the scheduled task');
};

if (!existsSync(SRC)) {
  say('leftover already gone');
  unregister();
  process.exit(0);
}

const idleMs = Date.now() - statSync(SRC).mtimeMs;
const idleMinutes = Math.round(idleMs / 60000);

// Always merge: it only ever appends entries the destination does not have.
const merge = spawnSync(process.execPath, [FINISH], { encoding: 'utf8' });
if (merge.status !== 0) {
  say(`merge failed (exit ${merge.status}); leaving everything in place and trying again next run`);
  process.exit(1);
}

if (idleMs < IDLE_MINUTES * 60000) {
  say(`session still writing (last ${idleMinutes}m ago); merged, will retry`);
  process.exit(0);
}

say(`session idle ${idleMinutes}m; removing the leftover`);
const commit = spawnSync(process.execPath, [FINISH, '--commit'], { encoding: 'utf8' });
for (const line of String(commit.stdout ?? '').trim().split('\n')) {
  if (line.trim()) say(`  ${line.trim()}`);
}
if (commit.status === 0 && !existsSync(SRC)) {
  say('move complete');
  unregister();
} else {
  say(`commit did not finish cleanly (exit ${commit.status}); will retry`);
}
