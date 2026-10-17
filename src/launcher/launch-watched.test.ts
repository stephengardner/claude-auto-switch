import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWatched, spawnWatched, type WatchedResult } from './launcher.js';

const fakeClaude = fileURLToPath(
  new URL('../../test/fake-claude/fake-claude.mjs', import.meta.url),
);
const invoker = { bin: process.execPath, prefixArgs: [fakeClaude] };

function accountDir(scenario?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-watched-'));
  if (scenario !== undefined) {
    writeFileSync(path.join(dir, 'fake-scenario.json'), JSON.stringify(scenario), 'utf8');
  }
  return dir;
}

describe('launchWatched', () => {
  it('detects a cap from stderr during a session', async () => {
    const dir = accountDir({ capped: true, capMessage: 'Usage limit reached.', capExitCode: 1 });
    const r = await launchWatched(['-p', 'hi'], { name: 'a', dir }, { claude: invoker });
    expect(r.classification.kind).toBe('capped');
    expect(r.exitCode).toBe(1);
  });

  it('classifies a normal session as ok', async () => {
    const r = await launchWatched(['chat'], { name: 'a', dir: accountDir() }, { claude: invoker });
    expect(r.classification.kind).toBe('ok');
    expect(r.exitCode).toBe(0);
  });
});

/** Ten times what is kept of standard error, 64 KiB. */
const FAR_MORE = 10 * 64 * 1024;
/** A debug line Claude writes in an ordinary turn, as 2.1.302 formats one with --debug-to-stderr. */
const RATE_LIMIT_DEBUG =
  "process.stderr.write(stamp() + ' [ERROR] API error (attempt 1/11): 429 This request would exceed the rate limit for your organization' + nl);";

/**
 * spawnWatched on a node script standing in for Claude, `env` added to its
 * environment, with what it passes on to ccx's own standard error caught
 * rather than printed.
 */
async function watchedScript(
  lines: string[],
  env: Record<string, string> = {},
): Promise<WatchedResult & { passedOn: string }> {
  const prelude = ['const nl = String.fromCharCode(10);', 'const stamp = () => new Date().toISOString();'];
  const write = process.stderr.write;
  const passedOn: string[] = [];
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    passedOn.push(String(chunk));
    const done = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    done?.();
    return true;
  }) as typeof write;
  try {
    const result = await spawnWatched(process.execPath, ['-e', [...prelude, ...lines].join('\n')], env);
    return { ...result, passedOn: passedOn.join('') };
  } finally {
    process.stderr.write = write;
  }
}

describe("what is kept of a watched Claude's standard error", () => {
  it('keeps only the end of a standard error far longer than the bound, and passes all of it on', async () => {
    const r = await watchedScript([
      "for (let i = 0; i < 9000; i++) process.stderr.write('warning ' + i + ': ' + 'x'.repeat(70) + nl);",
      "process.stderr.write('the last words' + nl);",
    ]);
    expect(r.passedOn.length).toBeGreaterThan(FAR_MORE);
    expect(r.passedOn.endsWith('the last words\n')).toBe(true);
    expect(r.stderr.length).toBeLessThanOrEqual(64 * 1024);
    expect(r.stderr.endsWith(`warning 8999: ${'x'.repeat(70)}\nthe last words\n`)).toBe(true);
    expect(r.stderr).not.toContain('warning 0:');
  });

  it('still finds a limit message at the end of a debug log far longer than the bound', async () => {
    // As the editor's Claude writes with --debug-to-stderr: debug lines that
    // talk about rate limits in an ordinary turn, then its own words at a limit.
    const limit = "You've hit your session limit. Run /usage-credits to continue.";
    const r = await watchedScript(
      [
        RATE_LIMIT_DEBUG,
        "for (let i = 0; i < 9000; i++) process.stderr.write(stamp() + ' [DEBUG] Stream event ' + i + ': ' + 'x'.repeat(50) + nl);",
        'process.stderr.write(process.env.LAST_WORDS + nl);',
        'process.exitCode = 1;',
      ],
      { LAST_WORDS: limit },
    );
    expect(r.passedOn.length).toBeGreaterThan(FAR_MORE);
    expect(r.exitCode).toBe(1);
    expect(r.classification).toMatchObject({ kind: 'capped', reason: limit });
    expect(r.stderr).toBe(`${limit}\n`);
  });

  it('never takes a debug line about rate limits for a limit', async () => {
    const r = await watchedScript([
      RATE_LIMIT_DEBUG,
      "process.stderr.write(stamp() + ' [DEBUG] Too many requests; retrying in 2000 ms' + nl);",
      'process.exitCode = 1;',
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.classification.kind).toBe('error');
    expect(r.stderr).toBe('');
    // Passed on untouched all the same, for the editor's own log.
    expect(r.passedOn).toContain('exceed the rate limit');
  });
});
