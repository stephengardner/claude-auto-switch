import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { autoCommand } from './auto.js';
import { loadConfig } from '../config/config.js';
import { takeLease } from '../session/lease.js';
import { readSwitchRequest } from '../state/switch-request.js';
import { readSwitchEvents } from '../events/switch-events.js';
import type { CliContext } from '../context.js';

const HOUR = 3_600_000;

/**
 * `ccx auto` moving a session before its account runs out says so twice: in
 * the event log, as a move asked for proactively, and on the request the
 * session reads, so the move the session then makes says proactive too.
 * Fresh usage and a login that is not due, so nothing goes over the network.
 */
describe('a proactive move from ccx auto', () => {
  it('is recorded as proactive, on the event and on the session request', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-auto-proactive-'));
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
    const now = Date.now();
    const accounts = ['tired', 'roomy'].map((name, priority) => {
      const dir = path.join(home, 'profiles', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: name, refreshToken: 'r', expiresAt: now + 10 * HOUR },
        }),
        'utf8',
      );
      return { name, dir, priority, enabled: true };
    });
    writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({ accounts }), 'utf8');
    writeFileSync(path.join(home, 'active.json'), JSON.stringify({ active: 'tired' }), 'utf8');
    const entry = (fiveHour: number) => ({
      fiveHour,
      sevenDay: 0.2,
      fiveHourReset: now + 2 * HOUR,
      sevenDayReset: now + 80 * HOUR,
      at: now,
    });
    writeFileSync(
      path.join(home, 'usage-snapshot.json'),
      JSON.stringify({ accounts: { tired: entry(0.99), roomy: entry(0.1) } }),
      'utf8',
    );
    // A session running on the account being left: it is the one asked to move.
    takeLease('tired', accounts[0]?.dir ?? '', ctx, { cwd: home });
    const context: CliContext = {
      ctx,
      config: loadConfig(ctx),
      out: () => {},
      err: () => {},
      json: false,
      quiet: false,
    };

    expect(await autoCommand(context, { once: true })).toBe(0);

    expect(readSwitchEvents(home, 10)).toEqual([
      expect.objectContaining({
        kind: 'move-asked',
        from: 'tired',
        to: 'roomy',
        reason: 'proactive',
      }),
    ]);
    expect(readSwitchRequest(ctx, process.pid)).toMatchObject({
      account: 'roomy',
      reason: 'proactive',
    });
  });
});
