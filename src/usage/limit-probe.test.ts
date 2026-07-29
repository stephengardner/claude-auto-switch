import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeLimit, probeModelFor } from './limit-probe.js';

function credsFile(withToken = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-probe-'));
  const file = path.join(dir, '.credentials.json');
  writeFileSync(
    file,
    JSON.stringify(withToken ? { claudeAiOauth: { accessToken: 'tok-123' } } : {}),
    'utf8',
  );
  return file;
}

function fakeFetch(status: number, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response('{}', { status, headers: new Headers(headers) })) as unknown as typeof fetch;
}

describe('probeModelFor', () => {
  it('maps the model named in the rendered message', () => {
    expect(probeModelFor("You've reached your Fable 5 limit.")).toBe('claude-fable-5');
    expect(probeModelFor('Opus limit reached')).toBe('claude-opus-4-8');
    expect(probeModelFor('some unrelated text')).toBe('claude-haiku-4-5-20251001');
  });
});

describe('probeLimit', () => {
  it('429 means limited', async () => {
    const r = await probeLimit(credsFile(), '', fakeFetch(429));
    expect(r.verdict).toBe('limited');
  });

  it('200 with allowed status (and utilization headers) means allowed', async () => {
    const r = await probeLimit(
      credsFile(),
      '',
      fakeFetch(200, {
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.25',
        'anthropic-ratelimit-unified-7d-utilization': '0.6',
      }),
    );
    expect(r.verdict).toBe('allowed');
    expect(r.fiveHour).toBe(0.25);
    expect(r.sevenDay).toBe(0.6);
  });

  it('200 with a non-allowed unified status means limited', async () => {
    const r = await probeLimit(
      credsFile(),
      '',
      fakeFetch(200, { 'anthropic-ratelimit-unified-status': 'rejected' }),
    );
    expect(r.verdict).toBe('limited');
  });

  it('falls back to the base model when the hinted model is unknown (404)', async () => {
    const seen: string[] = [];
    const f = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      seen.push(body.model);
      return new Response('{}', {
        status: seen.length === 1 ? 404 : 200,
        headers: new Headers({ 'anthropic-ratelimit-unified-status': 'allowed' }),
      });
    }) as unknown as typeof fetch;
    const r = await probeLimit(credsFile(), 'Fable 5 limit', f);
    expect(seen).toEqual(['claude-fable-5', 'claude-haiku-4-5-20251001']);
    expect(r.verdict).toBe('allowed');
  });

  it('is fail-safe: no token or network failure means unknown, never limited', async () => {
    expect((await probeLimit(credsFile(false), '', fakeFetch(200))).verdict).toBe('unknown');
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect((await probeLimit(credsFile(), '', boom)).verdict).toBe('unknown');
  });
});
