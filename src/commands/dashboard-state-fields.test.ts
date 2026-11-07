import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardCommand } from './dashboard.js';
import { loadConfig } from '../config/config.js';
import { takeLease } from '../session/lease.js';
import type { CliContext } from '../context.js';
import type { StatePayload } from '../dashboard/state-payload.js';

const fakeClaude = fileURLToPath(
  new URL('../../test/fake-claude/fake-claude.mjs', import.meta.url),
);
const HOUR = 3_600_000;

/**
 * What the dashboard works out, the whole way to `ccx state`: the command
 * builds the snapshot by hand from the registry, the usage file, the leases
 * and the settings, which is where a field the screen has is easiest to drop
 * before a program ever sees it.
 */
function setup(
  accounts: Array<{ name: string; enabled?: boolean; login?: boolean; pool?: string }> = [],
) {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-state-fields-'));
  const dirs = new Map<string, string>();
  for (const { name, login } of accounts) {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    // No login file, no usage read: an account without an entry is otherwise
    // read over the network, which a test must never do.
    if (login !== false)
      writeFileSync(
        path.join(dir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: name, refreshToken: 'r', expiresAt: Date.now() + HOUR },
        }),
        'utf8',
      );
    writeFileSync(
      path.join(dir, 'fake-scenario.json'),
      JSON.stringify({
        authStatus: { loggedIn: true, email: `${name}@example.com`, subscriptionType: 'max' },
      }),
      'utf8',
    );
    dirs.set(name, dir);
  }
  writeFileSync(
    path.join(home, 'accounts.json'),
    JSON.stringify({
      accounts: accounts.map((a, priority) => ({
        name: a.name,
        dir: dirs.get(a.name),
        priority,
        enabled: a.enabled ?? true,
        ...(a.pool !== undefined ? { pool: a.pool } : {}),
      })),
    }),
    'utf8',
  );
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const lines: string[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    out: (m: string) => lines.push(m),
    err: () => {},
    json: false,
    quiet: false,
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
  };
  const read = async (cachedLogins?: string): Promise<StatePayload> => {
    lines.length = 0;
    expect(
      await dashboardCommand(context, {
        json: true,
        ...(cachedLogins !== undefined ? { cachedLogins } : {}),
      }),
    ).toBe(0);
    return JSON.parse(lines.join('\n')) as StatePayload;
  };
  const refused = async (cachedLogins: string): Promise<unknown> => {
    lines.length = 0;
    expect(await dashboardCommand(context, { json: true, cachedLogins })).toBe(1);
    return JSON.parse(lines.join('\n'));
  };
  return { home, dirs, ctx, read, refused };
}

describe('a cheap `ccx state`', () => {
  it('uses the login checks the last read made, and says how old each is', async () => {
    const { home, read } = setup([{ name: 'a' }, { name: 'b' }]);
    const now = Date.now();
    const fresh = {
      fiveHour: 0.1,
      sevenDay: 0.1,
      fiveHourReset: now + HOUR,
      sevenDayReset: now + 60 * HOUR,
      at: now,
    };
    writeFileSync(
      path.join(home, 'usage-snapshot.json'),
      JSON.stringify({ accounts: { a: fresh, b: fresh } }),
      'utf8',
    );

    const full = await read();
    const cheap = await read('600');
    const checked = (s: StatePayload) =>
      s.accounts.map((a) => [a.name, a.loggedIn, a.loginCheckedAt]);
    // The same checks, at the times they were made, not asked again.
    expect(checked(cheap)).toEqual(checked(full));
    // And a read that will not use them asks again.
    const again = await read();
    for (const [i, a] of again.accounts.entries()) {
      expect(a.loginCheckedAt).toBeGreaterThan(full.accounts[i]?.loginCheckedAt ?? Infinity);
    }
  });

  it('refuses a bound that is not a number of seconds, in the envelope a reader parses', async () => {
    const { refused } = setup([{ name: 'a' }]);
    expect(await refused('soon')).toEqual({
      schemaVersion: 1,
      error: expect.stringContaining('"soon"'),
    });
  });
});

describe('`ccx state` says what the dashboard works out', () => {
  it("gives every account its folder, its usage's last good read, runway, hold-back and pick", async () => {
    const { home, dirs, read } = setup([
      { name: 'work', pool: 'lanes' },
      { name: 'tired' },
      { name: 'off', enabled: false, login: false },
    ]);
    const now = Date.now();
    writeFileSync(path.join(home, 'active.json'), JSON.stringify({ active: 'work' }), 'utf8');
    writeFileSync(
      path.join(home, 'usage-snapshot.json'),
      JSON.stringify({
        accounts: {
          // Read two minutes ago, checked again just now: `at` moved, `readAt` did not.
          work: {
            fiveHour: 0.5,
            sevenDay: 0.4,
            fiveHourReset: now + 2 * HOUR,
            sevenDayReset: now + 90 * HOUR,
            at: now,
            readAt: now - 2 * 60_000,
          },
          // Written before ccx kept a read time: not known, rather than `at`.
          tired: {
            fiveHour: 0.1,
            sevenDay: 0.85,
            fiveHourReset: now + HOUR,
            sevenDayReset: now + 30 * HOUR,
            at: now,
          },
        },
      }),
      'utf8',
    );

    const state = await read();
    const by = new Map(state.accounts.map((a) => [a.name, a]));
    const work = by.get('work');
    const tired = by.get('tired');
    const off = by.get('off');

    expect([work?.configDir, tired?.configDir, off?.configDir]).toEqual([
      dirs.get('work'),
      dirs.get('tired'),
      dirs.get('off'),
    ]);
    expect([work?.pool, tired?.pool]).toEqual(['lanes', null]);
    expect(work?.usage?.readAt).toBe(now - 2 * 60_000);
    expect(tired?.usage?.readAt).toBeNull();

    // Half its 5-hour window left, and that window binds.
    expect(work?.runway).toMatchObject({ windows: 0.5, binding: '5-hour', worthMoving: true });
    // 85% of its week used, past the default 80%: held back, so picked after work.
    expect(tired?.heldBack).toBe(true);
    expect(work?.heldBack).toBe(false);
    expect(tired?.runway?.weekLeft).toBeCloseTo(0.15);
    expect(work?.pick).toEqual({ rank: 1, binding: '5-hour' });
    expect(tired?.pick).toEqual({ rank: 2, binding: '5-hour' });
    // Disabled: rotation would not pick it, but where it stands is still said.
    expect(off?.pick).toBeNull();
    expect(off?.runway).toMatchObject({ windows: 1, binding: 'none' });

    for (const a of state.accounts) {
      expect(a.onHold).toBe(false);
      expect(typeof a.loginCheckedAt).toBe('number');
      expect(a.loginCheckedAt).toBeLessThanOrEqual(state.now);
    }
  });

  it('gives the settings, the move when one runs out, and the sessions running', async () => {
    const { home, dirs, ctx, read } = setup([{ name: 'work' }, { name: 'spare' }]);
    const now = Date.now();
    writeFileSync(path.join(home, 'active.json'), JSON.stringify({ active: 'work' }), 'utf8');
    // The active account's 5-hour window is spent, so the move goes to the other one.
    writeFileSync(
      path.join(home, 'usage-snapshot.json'),
      JSON.stringify({
        accounts: {
          work: {
            fiveHour: 1,
            sevenDay: 0.4,
            fiveHourReset: now + 2 * HOUR,
            sevenDayReset: now + 90 * HOUR,
            at: now,
          },
          spare: {
            fiveHour: 0.1,
            sevenDay: 0.2,
            fiveHourReset: now + HOUR,
            sevenDayReset: now + 60 * HOUR,
            at: now,
          },
        },
      }),
      'utf8',
    );
    takeLease('work', dirs.get('work') ?? '', ctx, { cwd: path.join(home, 'projects', 'api') });

    const state = await read();
    expect(state.settings).toEqual({
      accountOrder: 'smart',
      modelPreference: ['opus', 'fable'],
      modelStrategy: 'model-first',
      preferSameModel: true,
      holdBackAtPercent: 80,
      proactivePercent: null,
    });
    expect(state.whenOut).toEqual({ account: 'spare', model: 'opus', changesModel: false });
    expect(state.sessions).toEqual([
      {
        pid: process.pid,
        account: 'work',
        cwd: path.join(home, 'projects', 'api'),
        configDir: dirs.get('work'),
        lastSeen: expect.any(Number),
      },
    ]);
  });

  it('gives the same top-level shape when no account is registered yet', async () => {
    const { read } = setup();
    const state = await read();
    expect(state.accounts).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(state.whenOut).toBeNull();
    expect(state.settings?.accountOrder).toBe('smart');
    expect(state.active).toBeNull();
  });
});
