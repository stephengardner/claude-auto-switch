import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sessionsCommand } from './sessions.js';
import { leasePath } from '../session/lease.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

function ctxWith(json: boolean): { context: CliContext; lines: string[]; home: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-sessions-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const lines: string[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    out: (m) => lines.push(m),
    err: () => {},
    json,
    quiet: false,
  };
  return { context, lines, home };
}

/** Write a lease as a running session would, so liveLeases counts it. */
function writeLease(home: string, pid: number, lease: Record<string, unknown>): void {
  const c = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const dir = path.dirname(leasePath(String(lease.account ?? 'x'), c, pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${encodeURIComponent(String(lease.account ?? 'x'))}__${pid}.json`),
    JSON.stringify({ pid, configDir: '/s', at: Date.now(), ...lease }),
    'utf8',
  );
}

describe('sessionsCommand', () => {
  it('says so plainly when nothing is running', () => {
    const { context, lines } = ctxWith(false);
    expect(sessionsCommand(context)).toBe(0);
    expect(lines.join('\n')).toContain('no ccx sessions are running');
  });

  it('lists a live session with its account and folder', () => {
    const { context, lines, home } = ctxWith(false);
    writeLease(home, process.pid, { account: 'work', cwd: 'C:/proj/a' });
    sessionsCommand(context);
    const out = lines.join('\n');
    expect(out).toContain('work');
    expect(out).toContain('C:/proj/a');
    expect(out).toContain(String(process.pid));
  });

  it('never throws on a malformed lease, and strips terminal escapes from the table', () => {
    const { context, lines, home } = ctxWith(false);
    // A non-string account is ignored entirely (no crash).
    writeLease(home, 111111, { account: 999, cwd: 'C:/x' });
    // A live lease whose cwd carries an escape sequence must not reach the
    // terminal raw: the control bytes are stripped before printing.
    writeLease(home, process.pid, { account: 'work', cwd: 'C:/p\x1b[31mRED\x07' });
    expect(() => sessionsCommand(context)).not.toThrow();
    const out = lines.join('\n');
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\x07');
    expect(out).toContain('RED'); // the visible text survives, only controls go
    expect(out).not.toContain('999'); // the malformed one was dropped
  });

  it('emits a machine-readable envelope with --json', () => {
    const { context, lines, home } = ctxWith(true);
    writeLease(home, process.pid, { account: 'work', cwd: 'C:/proj/a' });
    sessionsCommand(context);
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(parsed.sessions[0]).toMatchObject({ account: 'work', cwd: 'C:/proj/a' });
  });
});
