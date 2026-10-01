import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeJsonFile, sweepAbandonedTemps } from './fs-json.js';

const tempDir = (): string => mkdtempSync(path.join(tmpdir(), 'cas-fs-json-'));

describe('writeJsonFile', () => {
  it('leaves nothing behind when the write fails', () => {
    // The target is a folder, so the final rename cannot succeed. The temp
    // file it would have replaced used to stay there for good, one per lost
    // write: 373 of them in one ccx folder.
    const dir = tempDir();
    mkdirSync(path.join(dir, 'active.json'));
    expect(() => writeJsonFile(path.join(dir, 'active.json'), { name: 'a' })).toThrow();
    expect(readdirSync(dir)).toEqual(['active.json']);
  });
});

describe('sweepAbandonedTemps', () => {
  /** Create `name` in `dir`, last written `ageMs` ago. */
  function file(dir: string, name: string, ageMs: number): string {
    const full = path.join(dir, name);
    writeFileSync(full, '{}', 'utf8');
    const when = new Date(Date.now() - ageMs);
    utimesSync(full, when, when);
    return full;
  }

  it('removes the temp files of writes that never finished', () => {
    const dir = tempDir();
    const hour = 60 * 60_000;
    const leftovers = [
      file(dir, 'usage-snapshot.json.17712.mtw0f6w3.tmp', hour), // writeJsonFile, as found in the wild
      file(dir, 'active.json.31120.mtj9shqu.tmp', hour),
      file(dir, '.claude-report.json.ccx-4242-7.tmp', hour), // writeFileAtomic
      file(dir, '.ledger.json.4242.mtj9shqu.tmp', hour), // secret files
    ];
    expect(sweepAbandonedTemps(dir)).toBe(4);
    for (const left of leftovers) expect(existsSync(left)).toBe(false);
  });

  it('never pulls a write in progress out from under its writer', () => {
    const dir = tempDir();
    const inFlight = file(dir, 'usage-snapshot.json.17712.mtw0f6w3.tmp', 1_000);
    expect(sweepAbandonedTemps(dir)).toBe(0);
    expect(existsSync(inFlight)).toBe(true);
  });

  it('touches only names ccx itself gives its temp files', () => {
    const dir = tempDir();
    const hour = 60 * 60_000;
    const kept = [
      file(dir, 'usage-snapshot.json', hour),
      file(dir, 'notes.tmp', hour),
      file(dir, '.claude.json.tmp.49064.704959bbd51f', hour), // Claude's own, not ours
      file(dir, 'events.jsonl.1', hour),
    ];
    expect(sweepAbandonedTemps(dir)).toBe(0);
    for (const k of kept) expect(existsSync(k)).toBe(true);
  });

  it('reports nothing for a folder that is not there', () => {
    expect(sweepAbandonedTemps(path.join(tempDir(), 'missing'))).toBe(0);
  });
});
