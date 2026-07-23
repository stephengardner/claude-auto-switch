import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveToken, readToken, extractToken } from './token-store.js';

describe('token store', () => {
  it('saves and reads back a token (trimmed)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-tok-'));
    saveToken(dir, '  sk-ant-oat01-abc123def456  ');
    expect(readToken(dir)).toBe('sk-ant-oat01-abc123def456');
  });

  it('returns null when no token is stored', () => {
    expect(readToken(mkdtempSync(path.join(tmpdir(), 'cas-tok-')))).toBeNull();
  });
});

describe('extractToken', () => {
  it('extracts an sk-ant token from setup-token output', () => {
    const out = 'Success!\nYour token:\n\nsk-ant-oat01-AbC_123-xyz789DEF456ghiJKL\n\nSet CLAUDE_CODE_OAUTH_TOKEN';
    expect(extractToken(out)).toBe('sk-ant-oat01-AbC_123-xyz789DEF456ghiJKL');
  });

  it('falls back to the longest credential-shaped token', () => {
    const token = 'A'.repeat(64);
    expect(extractToken(`token: ${token}`)).toBe(token);
  });

  it('returns null when no token is present', () => {
    expect(extractToken('no token here, just some words')).toBeNull();
  });
});
