import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';

function dir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cas-atomic-'));
}

describe('replacing a file without a gap', () => {
  it('writes the contents, creating the directory if needed', () => {
    const file = path.join(dir(), 'nested', 'thing.json');
    writeFileAtomic(file, '{"a":1}\n');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n');
  });

  it('leaves nothing temporary behind', () => {
    // A reader listing the directory should see the file and nothing else, and
    // a stray temp file would outlive every write.
    const d = dir();
    const file = path.join(d, 'thing.json');
    writeFileAtomic(file, 'one');
    writeFileAtomic(file, 'two');
    writeFileAtomic(file, 'three');
    expect(readdirSync(d)).toEqual(['thing.json']);
    expect(readFileSync(file, 'utf8')).toBe('three');
  });

  it('replaces an existing file rather than appending to it', () => {
    const file = path.join(dir(), 'thing.json');
    writeFileSync(file, 'a much longer previous value', 'utf8');
    writeFileAtomic(file, 'short');
    expect(readFileSync(file, 'utf8')).toBe('short');
  });

  it('writes ALL of it, however big and whatever is in it', () => {
    // A single write can put fewer bytes on disk than it was given. Ignoring
    // that would fsync and rename a truncated file, which publishes damage
    // atomically rather than preventing it. Large enough to cross the buffer
    // sizes where short writes actually happen, and with multi-byte characters
    // so a byte count cannot be mistaken for a character count.
    const file = path.join(dir(), 'big.json');
    const contents = 'aaaaéü中\u{1f680}'.repeat(400_000);
    writeFileAtomic(file, contents);
    const read = readFileSync(file, 'utf8');
    expect(read.length).toBe(contents.length);
    expect(read).toBe(contents);
  });

  it('rolls back cleanly when it cannot finish, taking its temp file with it', () => {
    // The whole point of not truncating in place: a failure must cost nothing.
    // A directory standing where the file should go makes the rename fail
    // after the temp file has already been written, which is exactly the
    // moment the old code would have left damage behind.
    const d = dir();
    const target = path.join(d, 'occupied');
    mkdirSync(target, { recursive: true });

    expect(() => writeFileAtomic(target, 'replacement')).toThrow();
    // What was there is untouched, and nothing temporary survived the failure.
    expect(existsSync(target)).toBe(true);
    expect(readdirSync(d)).toEqual(['occupied']);
  });
});
