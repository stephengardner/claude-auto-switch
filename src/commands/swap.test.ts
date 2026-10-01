import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { readSwitchRequest } from '../state/switch-request.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { card, rankAccounts, renderBoard, swapCommand, whereAmI, type Here } from './swap.js';
import { addAccount } from '../accounts/registry.js';
import { loadConfig } from '../config/config.js';
import { sessionDirFor } from '../session/session-dir.js';
import { getActive } from '../state/active.js';
import type { StateAccount, StatePayload } from '../dashboard/state-payload.js';
import type { CliContext } from '../context.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function account(name: string, usage: StateAccount['usage'], status: Partial<StateAccount['status']> = {}): StateAccount {
  return {
    name,
    email: `${name}@example.com`,
    loggedIn: true,
    enabled: true,
    active: false,
    priority: 0,
    usage,
    status: { state: 'ready', label: null, until: null, blockedBy: [], ...status },
  };
}

const state: StatePayload = {
  schemaVersion: 1,
  now: NOW,
  active: 'mid',
  preferredModel: 'fable',
  nextUp: null,
  events: [],
  accounts: [
    account('mid', { fiveHour: 0.5, sevenDay: 0.3, fiveHourReset: NOW + HOUR, sevenDayReset: NOW + 96 * HOUR }),
    account('roomy', { fiveHour: 0.1, sevenDay: 0.2, models: [{ name: 'Fable', utilization: 0.05, resetsAt: NOW + 96 * HOUR }] }),
    account('spent', { fiveHour: 0, sevenDay: 1, sevenDayReset: NOW + 30 * HOUR }, {
      state: 'blocked',
      label: 'week',
      until: NOW + 30 * HOUR,
    }),
    { ...account('off', { fiveHour: 0, sevenDay: 0 }), enabled: false },
  ],
};

describe('the swap board', () => {
  const here: Here = { kind: 'ccx', account: 'mid', pid: 4242 };

  it('ranks by room left on the tightest window, and recommends the roomiest that is not this one', () => {
    const rows = rankAccounts(state, here);
    expect(rows.map((r) => r.account.name)).toEqual(['roomy', 'mid', 'spent', 'off']);
    expect(rows.find((r) => r.recommended)?.account.name).toBe('roomy');
    expect(rows.find((r) => r.here)?.status).toBe('ready, you are here');
    expect(rows.find((r) => r.account.name === 'spent')?.status).toBe('week spent, back in 1d 6h');
    expect(rows.find((r) => r.account.name === 'off')?.eligible).toBe(false);
  });

  it('never recommends the account the session is already on', () => {
    const alone = { ...state, accounts: [state.accounts[0]!] };
    expect(rankAccounts(alone, here).some((r) => r.recommended)).toBe(false);
  });

  it('draws every account with its bars, and says what a swap does from here', () => {
    const board = renderBoard(rankAccounts(state, here), state, here, false);
    expect(board).toContain('ccx swap: this ccx session is on mid');
    expect(board).toMatch(/★ +roomy +█░░░░░░░░░ +10% +██░░░░░░░░ +20% +█░░░░░░░░░ +5% +ready/);
    expect(board).toMatch(/▶ +mid/);
    expect(board).toContain('★ most room: roomy');
    expect(board).toContain('nothing restarts');
    // No colour codes when asked for plain text: the skill prints it verbatim.
    expect(board).not.toContain(String.fromCharCode(27));
  });

  it('makes each account a card for the picker beside it', () => {
    const roomy = rankAccounts(state, here).find((r) => r.account.name === 'roomy')!;
    expect(card(roomy, state).split('\n')).toEqual([
      'roomy · roomy@example.com',
      '─'.repeat(36),
      '5-hour ██░░░░░░░░░░░░░░  10%',
      'week   ███░░░░░░░░░░░░░  20%',
      'fable  █░░░░░░░░░░░░░░░   5%  resets in 4d',
      '─'.repeat(36),
      'ready · most room of any account',
    ]);
  });
});

describe('ccx swap <name>', () => {
  function setup(env: Record<string, string> = {}): { context: CliContext; said: string[]; home: string } {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-swap-'));
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home, ...env } };
    for (const name of ['mid', 'roomy', 'spent']) {
      const dir = path.join(home, 'profiles', name);
      mkdirSync(dir, { recursive: true });
      addAccount({ name, dir }, ctx);
    }
    const said: string[] = [];
    const context: CliContext = {
      ctx,
      config: loadConfig(ctx),
      claude: { bin: 'claude', prefixArgs: [] },
      out: (m) => said.push(m),
      json: false,
      quiet: false,
    };
    return { context, said, home };
  }

  it('inside a ccx session, moves that session in place', async () => {
    const outside = setup();
    const dir = sessionDirFor(4242, outside.context.ctx);
    // The same home, seen from inside the session: Claude runs on its folder.
    const s = {
      context: { ...outside.context, ctx: { env: { ...outside.context.ctx.env, CLAUDE_CONFIG_DIR: dir } } },
    };
    expect(whereAmI(s.context, () => []).kind).toBe('ccx');
    expect(await swapCommand(s.context, 'roomy', {}, { state: () => Promise.resolve(state), conversations: () => [] })).toBe(0);
    // Aimed at this session only: others are not moved.
    expect(readSwitchRequest(outside.context.ctx, 4242)).toMatchObject({ account: 'roomy', mode: 'seamless' });
    expect(readSwitchRequest(outside.context.ctx)).toBeNull();
  });

  it('in Claude Desktop, carries the conversation on in a terminal on that account', async () => {
    const s = setup({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_PID: '777' });
    const handed: Array<{ account?: string; waitFor?: number }> = [];
    const code = await swapCommand(s.context, 'roomy', {}, {
      state: () => Promise.resolve(state),
      conversations: () => [
        { pid: 777, sessionId: '9106faa2-0b73-4126-9a9f-581cc123867f', cwd: 'C:\\w', name: 'Schema', status: 'busy', statusSince: null },
      ],
      flagsOf: () => ({ model: null, effort: null, permissionMode: null }),
      handOff: (_t, settings, _c, _d, waitFor) => {
        handed.push({ ...(settings.account ? { account: settings.account } : {}), ...(waitFor !== undefined ? { waitFor } : {}) });
        return { ok: true, via: 'Windows Terminal', script: 'x', command: [] };
      },
    });
    expect(code).toBe(0);
    // The reply running /ccx is still being written, so the window waits for it.
    expect(handed).toEqual([{ account: 'roomy', waitFor: 777 }]);
    expect(s.said.join(' ')).toMatch(/continues in a Windows Terminal window on roomy/);
  });

  it('outside any session, sets the account new sessions start on', async () => {
    const s = setup();
    expect(await swapCommand(s.context, 'roomy', {}, { state: () => Promise.resolve(state), conversations: () => [] })).toBe(0);
    expect(getActive(s.context.ctx)).toBe('roomy');
  });

  it('refuses an account that cannot take the session, and names one that can', async () => {
    const s = setup();
    expect(await swapCommand(s.context, 'spent', {}, { state: () => Promise.resolve(state), conversations: () => [] })).toBe(1);
    expect(s.said.join(' ')).toMatch(/spent cannot take it: week spent.*roomy has the most room/);
  });

  it('as JSON, gives the skill everything it lays out, already drawn', async () => {
    const s = setup();
    await swapCommand(s.context, undefined, { json: true }, { state: () => Promise.resolve(state), conversations: () => [] });
    const out = JSON.parse(s.said.join('\n')) as { here: Here; recommended: string; board: string; accounts: Array<{ card: string }> };
    expect(out.here.kind).toBe('none');
    expect(out.recommended).toBe('roomy');
    expect(out.board).toContain('ccx swap: not inside a session');
    expect(out.accounts[0]?.card).toContain('roomy · roomy@example.com');
  });
});

describe('where a swap is asked from', () => {
  it('is nowhere for a plain terminal', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-swap-here-'));
    writeFileSync(path.join(home, 'x'), '');
    const context = { ctx: { env: { HOME: home, USERPROFILE: home } } } as unknown as CliContext;
    expect(whereAmI(context, () => [])).toEqual({ kind: 'none', account: null });
  });
});
