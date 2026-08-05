import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
const PER_WRITER = 25; // 75 total, below the trim threshold so nothing is dropped by design

function runWriters(home: string): Promise<Array<{ code: number | null; stderr: string }>> {
  const child = path.join(home, 'writer.ts');
  writeFileSync(
    child,
    [
      `import { appendEvent } from ${JSON.stringify(LOG_MODULE.split(path.sep).join('/'))};`,
      `const [home, tag, count] = process.argv.slice(2);`,
      `for (let i = 0; i < Number(count); i++) appendEvent(home, tag + '-' + i, Date.now() + i);`,
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

    const file = path.join(home, 'events.jsonl');
    expect(existsSync(file)).toBe(true);
    const present = new Set<string>();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        present.add((JSON.parse(line) as { msg: string }).msg);
      } catch {
        /* a partial line is tolerated by the reader; it is not a lost event */
      }
    }

    const expected: string[] = [];
    for (let w = 0; w < WRITERS; w++) {
      for (let i = 0; i < PER_WRITER; i++) expected.push(`w${w}-${i}`);
    }
    const missing = expected.filter((m) => !present.has(m));
    expect(missing).toEqual([]);
  }, 60_000);
});
