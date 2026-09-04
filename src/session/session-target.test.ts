import { describe, it, expect } from 'vitest';
import { resolveTarget } from './session-target.js';
import type { SessionLease } from './lease.js';

const lease = (over: Partial<SessionLease>): SessionLease => ({
  account: 'a',
  pid: 100,
  configDir: 'C:/cfg/100',
  at: 1,
  ...over,
});

describe('resolveTarget', () => {
  it('broadcasts when no session is named', () => {
    expect(resolveTarget([lease({})], {}).kind).toBe('broadcast');
  });

  it('targets an explicit pid that is live', () => {
    const leases = [lease({ pid: 100, account: 'x' }), lease({ pid: 200, account: 'y' })];
    const r = resolveTarget(leases, { session: 200 });
    expect(r).toMatchObject({ kind: 'session', pid: 200 });
  });

  it('errors, and lists the live ones, when the pid is not running', () => {
    const r = resolveTarget([lease({ pid: 100, account: 'x' })], { session: 999 });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('999');
      expect(r.message).toContain('100');
    }
  });

  it('targets the one session running in the folder for --here', () => {
    const leases = [
      lease({ pid: 100, cwd: 'C:/proj/a' }),
      lease({ pid: 200, cwd: 'C:/proj/b' }),
    ];
    const r = resolveTarget(leases, { here: true, cwd: 'C:/proj/b' });
    expect(r).toMatchObject({ kind: 'session', pid: 200 });
  });

  it('matches --here regardless of slash direction or trailing slash or case (win)', () => {
    const leases = [lease({ pid: 100, cwd: 'C:/proj/a' })];
    const r = resolveTarget(leases, { here: true, cwd: 'c:\\proj\\a\\' });
    // On Windows this normalizes and matches; elsewhere it correctly does not.
    if (process.platform === 'win32') expect(r).toMatchObject({ kind: 'session', pid: 100 });
    else expect(r.kind).toBe('error');
  });

  it('errors for --here when no session runs in the folder', () => {
    const r = resolveTarget([lease({ pid: 100, cwd: 'C:/proj/a' })], { here: true, cwd: 'C:/elsewhere' });
    expect(r.kind).toBe('error');
  });

  it('refuses to guess when --here is ambiguous (two sessions, one folder)', () => {
    const leases = [
      lease({ pid: 100, cwd: 'C:/proj/a', account: 'x' }),
      lease({ pid: 200, cwd: 'C:/proj/a', account: 'y' }),
    ];
    const r = resolveTarget(leases, { here: true, cwd: 'C:/proj/a' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('100');
      expect(r.message).toContain('200');
    }
  });

  it('an explicit pid wins even when --here would be ambiguous', () => {
    const leases = [
      lease({ pid: 100, cwd: 'C:/proj/a' }),
      lease({ pid: 200, cwd: 'C:/proj/a' }),
    ];
    const r = resolveTarget(leases, { session: 100, here: true, cwd: 'C:/proj/a' });
    expect(r).toMatchObject({ kind: 'session', pid: 100 });
  });
});
