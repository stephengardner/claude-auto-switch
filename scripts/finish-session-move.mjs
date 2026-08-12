/**
 * Finish moving this conversation into the claude-auto-switch project.
 *
 * The transcript was moved while the session was LIVE, and a live session keeps
 * writing to its own path. So Claude Code recreated a file at the old location
 * and has been appending there ever since. This merges those entries into the
 * moved transcript and removes the leftover.
 *
 * Run it once after the session has exited. Running it while the session is
 * still going is harmless but pointless: it will just come back.
 *
 * Matching is by ENTRY IDENTITY, not by line count. The first version of this
 * compared counts, which was right while the destination was a copy of a longer
 * source, and wrong the moment the source became a fresh short file: it would
 * have concluded there was nothing new and deleted 19 real entries.
 *
 *   node scripts/finish-session-move.mjs            # merge, report, keep source
 *   node scripts/finish-session-move.mjs --commit    # merge, then delete source
 */
import {
  existsSync,
  createReadStream,
  createWriteStream,
  copyFileSync,
  mkdirSync,
  statSync,
  utimesSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import path from 'node:path';

const SID = 'ef2b2b73-9600-4c2e-bcda-9b09c90047fb';
const PROJECTS = 'C:/Users/opens/.claude/projects';
const SRC_DIR = path.join(PROJECTS, 'C--Users-opens-shop-sheriff-sms-root');
const DST_DIR = path.join(PROJECTS, 'C--Users-opens-claude-auto-switch');
const OLD_CWD = 'C:\\Users\\opens\\shop-sheriff-sms-root';
const NEW_CWD = 'C:\\Users\\opens\\claude-auto-switch';
const COMMIT = process.argv.includes('--commit');

const srcJsonl = path.join(SRC_DIR, `${SID}.jsonl`);
const dstJsonl = path.join(DST_DIR, `${SID}.jsonl`);

/**
 * Bring the destination's memory up to date with the shop-sheriff copy.
 *
 * COPY, never move. That memory directory is shared by the five other
 * shop-sheriff sessions in the same project, so taking it would strip them of
 * everything they know. Newer-wins and never deletes, so running this twice is
 * the same as running it once, and a file only the destination has is kept.
 */
function syncMemory() {
  const from = path.join(SRC_DIR, 'memory');
  const to = path.join(DST_DIR, 'memory');
  if (!existsSync(from)) return { copied: 0 };
  mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const name of readdirSync(from)) {
    const a = path.join(from, name);
    const b = path.join(to, name);
    try {
      const sa = statSync(a);
      if (!sa.isFile()) continue;
      if (existsSync(b) && statSync(b).mtimeMs >= sa.mtimeMs) continue;
      copyFileSync(a, b);
      // Timestamps carried over, or the next run sees the copy as newer than
      // its source and the comparison above stops meaning anything.
      utimesSync(b, sa.atime, sa.mtime);
      copied++;
    } catch {
      /* skip the unreadable one, sync the rest */
    }
  }
  return { copied };
}

if (!existsSync(dstJsonl)) {
  console.log('destination transcript is missing; the move has not been done');
  process.exit(1);
}

// Replacing the exact field token, never the path wherever it appears: this
// transcript quotes that path constantly in ordinary text and tool output, and
// rewriting those would falsify the history.
const OLD_TOKENS = [`"cwd":${JSON.stringify(OLD_CWD)}`, `"cwd": ${JSON.stringify(OLD_CWD)}`];
const NEW_TOKENS = [`"cwd":${JSON.stringify(NEW_CWD)}`, `"cwd": ${JSON.stringify(NEW_CWD)}`];

const rewrite = (line) => {
  let out = line;
  for (let i = 0; i < OLD_TOKENS.length; i++) {
    if (out.includes(OLD_TOKENS[i])) out = out.split(OLD_TOKENS[i]).join(NEW_TOKENS[i]);
  }
  return out;
};

/** A stable id for an entry: its uuid, or a hash of the line when it has none. */
const identity = (line) => {
  try {
    const o = JSON.parse(line);
    if (o.uuid) return `uuid:${o.uuid}`;
  } catch {
    /* fall through to the hash */
  }
  return `hash:${createHash('sha1').update(line).digest('hex')}`;
};

async function readIds(file) {
  const ids = new Set();
  const input = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lines = 0;
  for await (const raw of input) {
    if (!raw.trim()) continue;
    lines++;
    ids.add(identity(raw));
  }
  return { ids, lines };
}

const dst = await readIds(dstJsonl);
console.log(`destination : ${dst.lines} lines`);

if (!existsSync(srcJsonl)) {
  console.log('source      : already gone, nothing to merge');
  console.log(`destination : ${statSync(dstJsonl).size} bytes`);
  process.exit(0);
}

const src = await readIds(srcJsonl);
console.log(`source      : ${src.lines} lines left behind by the live session`);

let appended = 0;
let skipped = 0;
{
  const input = createInterface({
    input: createReadStream(srcJsonl, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const output = createWriteStream(dstJsonl, { flags: 'a', encoding: 'utf8' });
  for await (const raw of input) {
    if (!raw.trim()) continue;
    // Compared BEFORE the rewrite, because the destination's ids were read from
    // lines that had already been rewritten, and a uuid does not change either
    // way. Hash-identified lines are compared on their original form.
    if (dst.ids.has(identity(raw))) {
      skipped++;
      continue;
    }
    const line = rewrite(raw);
    try {
      JSON.parse(line);
    } catch {
      console.log('refusing to append a line that is not valid JSON');
      process.exit(1);
    }
    if (!output.write(`${line}\n`)) {
      await new Promise((resolve) => output.once('drain', resolve));
    }
    appended++;
  }
  await new Promise((resolve) => output.end(resolve));
}
console.log(`merged      : ${appended} new entries appended, ${skipped} already present`);

const memory = syncMemory();
console.log(`memory      : ${memory.copied} file(s) brought up to date (source left intact)`);

if (COMMIT) {
  rmSync(srcJsonl, { force: true });
  const srcSide = path.join(SRC_DIR, SID);
  if (existsSync(srcSide)) rmSync(srcSide, { recursive: true, force: true });
  // The pre-share directory is the copy ensureSharedProjects set aside before it
  // linked projects to the real root. Leaving anything of this session there
  // means it is still sitting in the old project under another folder. Only the
  // paths named for THIS session id are touched: the other shop-sheriff sessions
  // live in the same folder and none of this is theirs.
  const preShareDir = path.join(
    'C:/Users/opens/.claude-auto-switch/session/projects.pre-share',
    'C--Users-opens-shop-sheriff-sms-root',
  );
  for (const leftover of [path.join(preShareDir, `${SID}.jsonl`), path.join(preShareDir, SID)]) {
    if (existsSync(leftover)) rmSync(leftover, { recursive: true, force: true });
  }
  console.log('source      : removed from the shop-sheriff project');
}

const left = readdirSync(SRC_DIR).filter((f) => f.startsWith(SID));
const final = await readIds(dstJsonl);
console.log(`old project : ${left.length ? left.join(', ') : 'nothing left'}`);
console.log(`destination : ${statSync(dstJsonl).size} bytes, ${final.lines} lines`);
