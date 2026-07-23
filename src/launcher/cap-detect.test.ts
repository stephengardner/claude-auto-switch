import { describe, it, expect } from 'vitest';
import { classifyRun } from './cap-detect.js';

describe('classifyRun', () => {
  it('classifies a clean exit as ok', () => {
    expect(classifyRun({ exitCode: 0, stderr: '' }).kind).toBe('ok');
  });

  it('classifies the usage-limit message as capped', () => {
    const r = classifyRun({ exitCode: 1, stderr: 'Usage limit reached. Try again later.' });
    expect(r.kind).toBe('capped');
    expect(r.reason).toContain('Usage limit reached');
  });

  it('matches several rate-limit phrasings', () => {
    for (const msg of [
      'rate limit exceeded',
      'Too Many Requests',
      '5-hour limit reached',
      'weekly limit hit',
      'quota exceeded',
    ]) {
      expect(classifyRun({ exitCode: 1, stderr: msg }).kind).toBe('capped');
    }
  });

  it('classifies other non-zero exits as error', () => {
    expect(classifyRun({ exitCode: 2, stderr: 'some other failure' }).kind).toBe('error');
  });

  it('extracts an ISO reset time when present', () => {
    const r = classifyRun({
      exitCode: 1,
      stderr: 'Usage limit reached. Resets at 2026-07-22T15:00:00Z.',
    });
    expect(r.kind).toBe('capped');
    expect(r.resetAt).toBe(Date.parse('2026-07-22T15:00:00Z'));
  });
});
