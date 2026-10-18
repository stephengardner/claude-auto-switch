import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

/**
 * Whether ccx kept relaying Claude's terminal while it waited for a lock,
 * measured so that a stall of the whole machine cannot look like a wait.
 *
 * The fake Claude stamps each line it writes with the time it wrote it
 * (FAKE_CLAUDE_CHATTER_STAMP), and the test notes each time ccx found the lock
 * taken. A wait on the thread that relays makes a written line wait for its
 * relay while ccx goes on trying the lock, again and again. A stalled machine
 * stops ccx and Claude alike: nothing is written and nothing is tried while
 * it lasts. Only Claude's own lines count, so the quiet after Claude exits,
 * which on Windows always lasts over a second (node-pty reports an exit only
 * a second after it, and ccx then waits for the last output), is not measured.
 */

/** A line Claude wrote, and when ccx passed it on to the terminal. */
export interface RelayedLine {
  writtenAt: number;
  relayedAt: number;
}

/** Records each stamped line as ccx writes it to stdout, until `stop`. */
export function watchRelay(): { lines: () => RelayedLine[]; stop: () => void } {
  const lines: RelayedLine[] = [];
  let tail = '';
  const write = process.stdout.write;
  process.stdout.write = function (this: NodeJS.WriteStream, ...args: Parameters<typeof write>) {
    const relayedAt = Date.now();
    const chunk = args[0] as unknown;
    tail += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    // Whole stamps only: a line can arrive split across two writes.
    const stamp = /working on it (\d+)(?=\D)/g;
    let consumed = 0;
    for (let found = stamp.exec(tail); found !== null; found = stamp.exec(tail)) {
      lines.push({ writtenAt: Number(found[1]), relayedAt });
      consumed = stamp.lastIndex;
    }
    tail = tail.slice(consumed).slice(-200);
    return write.apply(this, args);
  } as typeof write;
  return {
    lines: () => [...lines],
    stop: () => {
      process.stdout.write = write;
    },
  };
}

/**
 * Notes each time this process finds the directory lock `lockDir` taken (its
 * mkdir failing with EEXIST), until `stop`. ccx's locks import mkdirSync by
 * name, which syncBuiltinESMExports points at the stand-in.
 */
export function watchLockDirTries(lockDir: string): { tries: () => number[]; stop: () => void } {
  const target = path.resolve(lockDir);
  const tries: number[] = [];
  const fs = createRequire(import.meta.url)('node:fs') as { mkdirSync: (...a: unknown[]) => unknown };
  const mkdirSync = fs.mkdirSync;
  fs.mkdirSync = function (this: unknown, ...a: unknown[]) {
    try {
      return mkdirSync.apply(this, a);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && path.resolve(String(a[0])) === target) {
        tries.push(Date.now());
      }
      throw error;
    }
  };
  syncBuiltinESMExports();
  return {
    tries: () => [...tries],
    stop: () => {
      fs.mkdirSync = mkdirSync;
      syncBuiltinESMExports();
    },
  };
}

/** The most times ccx tried the lock while one line Claude had written waited to be relayed. */
export function triesWhileALineWaited(lines: RelayedLine[], tries: number[]): number {
  let most = 0;
  for (const line of lines) {
    const during = tries.filter((at) => at > line.writtenAt && at < line.relayedAt).length;
    if (during > most) most = during;
  }
  return most;
}
