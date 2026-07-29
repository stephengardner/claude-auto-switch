import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeSecretFile, copySecretFile, redactSecrets, secureMkdir } from './secret-file.js';

function dir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cas-secret-'));
}

describe('writeSecretFile', () => {
  it('writes the content and leaves no temp files behind', () => {
    const d = dir();
    const f = path.join(d, 'creds.json');
    writeSecretFile(f, '{"a":1}');
    expect(readFileSync(f, 'utf8')).toBe('{"a":1}');
    expect(readdirSync(d).filter((n) => n.includes('.tmp'))).toHaveLength(0);
  });

  it('replaces an existing file atomically (never a partial read)', () => {
    const d = dir();
    const f = path.join(d, 'creds.json');
    writeSecretFile(f, '{"gen":1}');
    writeSecretFile(f, '{"gen":2}');
    // A reader only ever sees a complete generation, never a truncated one.
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ gen: 2 });
    expect(readdirSync(d)).toHaveLength(1);
  });

  it('creates missing parent directories', () => {
    const f = path.join(dir(), 'nested', 'deep', 'creds.json');
    writeSecretFile(f, 'x');
    expect(readFileSync(f, 'utf8')).toBe('x');
  });

  it('restricts permissions to owner-only on POSIX', () => {
    const f = path.join(dir(), 'creds.json');
    writeSecretFile(f, 'x');
    if (process.platform !== 'win32') {
      expect(statSync(f).mode & 0o777).toBe(0o600);
    }
  });
});

describe('copySecretFile', () => {
  it('copies content and leaves no temp files behind', () => {
    const d = dir();
    const src = path.join(d, 'src.json');
    const dest = path.join(d, 'dest.json');
    writeFileSync(src, '{"token":"abc"}', 'utf8');
    copySecretFile(src, dest);
    expect(readFileSync(dest, 'utf8')).toBe('{"token":"abc"}');
    expect(readdirSync(d).filter((n) => n.includes('.tmp'))).toHaveLength(0);
  });

  it('throws when the source is missing (caller decides, never a silent empty file)', () => {
    const d = dir();
    expect(() => copySecretFile(path.join(d, 'nope.json'), path.join(d, 'dest.json'))).toThrow();
  });
});

describe('secureMkdir', () => {
  it('creates nested directories', () => {
    const d = path.join(dir(), 'a', 'b');
    secureMkdir(d);
    expect(statSync(d).isDirectory()).toBe(true);
  });
});

describe('redactSecrets', () => {
  it('redacts api keys and long token-shaped strings', () => {
    expect(redactSecrets('key sk-ant-abcdefghijklmno')).toContain('REDACTED');
    expect(redactSecrets(`tok ${'a'.repeat(70)}`)).toContain('REDACTED');
    expect(redactSecrets('nothing sensitive here')).toBe('nothing sensitive here');
  });
});
