import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../../src/events/log.js';

/**
 * Several ccx processes share one event log: a session writes swaps, the
 * dashboard tails it, the editor launcher adds its own. This is the only test
 * that puts REAL separate processes on it at once, which is what exposed the
 * defect: the old write rewrote the whole file, so writers erased each other's
 * events and the rename collided with EPERM on Windows.
 *
 * Children run through tsx (a devDependency) so this needs no build step.
 */

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const LOG_MODULE = path.join(REPO, 'src', 'events', 'log.ts');
const TSX = path.join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

const WRITERS = 3;
const PER_WRITER = 25;
/**
 * Long enough that 75 records pass the 64KB compaction threshold, so this test
 * covers the COMPACTION path and not just the appends. Compaction used to read
 * a snapshot and replace the file, which erased anything appended in between:
 * the same lost-update bug, moved rather than fixed. 75 records stays under the
 * 200-record cap, so every one of them must survive.
 */
const PADDING = 'x'.repeat(900);

function runWriters(home: string): Promise<Array<{ code: number | null; stderr: string }>> {
  const child = path.join(home, 'writer.ts');
  writeFileSync(
    child,
    [
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE.split(path.sep).join('/'))};`,
      `const [home, tag, count] = process.argv.slice(2);`,
      `const pad = ${JSON.stringify(PADDING)};`,
      `for (let i = 0; i < Number(count); i++) appendEvent(home, tag + '-' + i + ' ' + pad, Date.now() + i);`,
    ].join('\n'),
    'utf8',
  );

  return Promise.all(
    Array.from(
      { length: WRITERS },
      (_, w) =>
        new Promise<{ code: number | null; stderr: string }>((resolve) => {
          const p = spawn(TSX, [child, home, `w${w}`, String(PER_WRITER)], {
            stdio: ['ignore', 'ignore', 'pipe'],
            shell: process.platform === 'win32',
          });
          let stderr = '';
          p.stderr.on('data', (d) => {
            stderr += String(d);
          });
          p.on('exit', (code) => resolve({ code, stderr }));
        }),
    ),
  );
}

describe('several processes writing the event log at once', () => {
  it('loses nothing and crashes nobody', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-evrace-'));
    const results = await runWriters(home);

    // A crash here is the EPERM the rewrite used to produce. Report the message
    // rather than only the code, so a failure says what happened.
    const crashed = results.filter((r) => r.code !== 0);
    expect(crashed.map((c) => c.stderr.split('\n')[0] ?? 'no output')).toEqual([]);

    // Compaction must actually have run, or this test silently stops covering
    // the path it exists for: the archive only appears once the live file passes
    // the size threshold. Pinned so a change to the padding or the threshold
    // fails here rather than quietly narrowing the test.
    expect(existsSync(path.join(home, 'events.jsonl.1'))).toBe(true);

    // Asked through the READER, not by opening one file. Compaction moves older
    // records into an archive beside the live file, so reading only events.jsonl
    // reports them missing when they are simply somewhere else. What matters is
    // what the operator can see, and that is what readEvents returns.
    expect(existsSync(path.join(home, 'events.jsonl'))).toBe(true);
    const present = new Set(
      // The padding exists only to reach the compaction threshold.
      readEvents(home, 10_000).map((r) => r.msg.split(' ')[0] ?? ''),
    );

    const expected: string[] = [];
    for (let w = 0; w < WRITERS; w++) {
      for (let i = 0; i < PER_WRITER; i++) expected.push(`w${w}-${i}`);
    }
    const missing = expected.filter((m) => !present.has(m));
    expect(missing).toEqual([]);
  }, 60_000);
});
