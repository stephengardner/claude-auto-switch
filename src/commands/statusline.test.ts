import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { statuslineCommand } from './statusline.js';
import { rememberDeadLogin } from '../usage/dead-login-store.js';
import { refreshCredentialIfExpired } from '../usage/oauth-refresh.js';
import { loadConfig } from '../config/config.js';
import { sessionDirFor } from '../session/session-dir.js';
import { leasePath, takeLease } from '../session/lease.js';
import type { CliContext } from '../context.js';

interface SetupOptions {
  /**
   * Which folder Claude runs the session on: one ccx handed a terminal session,
   * the editor's (which follows the active account), or neither (plain claude).
   */
  where?: 'session' | 'editor' | 'plain';
  /** Every registered account, each signed in. Defaults to just the active one. */
  accounts?: string[];
  /**
   * The account the terminal session announced when ccx started or moved it, or
   * null for a session with no live announcement. Defaults to the active one.
   */
  sessionOn?: string | null;
}

function setup(
  active: string | null,
  usage?: Record<string, unknown>,
  options: SetupOptions = {},
): { context: CliContext; lines: string[]; home: string; sessionDir: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-status-'));
  const where = options.where ?? 'session';
  // A folder of the shape ccx gives each terminal session, named for the pid of
  // the ccx process running it. This test process stands in for that one, so
  // its announcement counts as live for as long as the test runs.
  const sessionDir = sessionDirFor(process.pid, { env: { CLAUDE_AUTO_SWITCH_HOME: home } });
  mkdirSync(sessionDir, { recursive: true });
  // Claude runs the status line inside the session, so a managed session is one
  // whose config location is the folder ccx handed it.
  const configDir =
    where === 'session' ? sessionDir : where === 'editor' ? path.join(home, 'editor-active') : null;
  const ctx = {
    env: {
      CLAUDE_AUTO_SWITCH_HOME: home,
      ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
    },
  };
  if (active) writeFileSync(path.join(home, 'active.json'), JSON.stringify({ active }), 'utf8');
  const names = options.accounts ?? (active ? [active] : []);
  if (names.length > 0) {
    const accounts = names.map((name, priority) => {
      // A signed-in account, so the line reports usage rather than asking for a login.
      const dir = path.join(home, 'profiles', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: `tok-${name}` } }),
        'utf8',
      );
      return { name, dir, email: `${name}@example.com`, priority, enabled: true };
    });
    writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({ accounts }), 'utf8');
  }
  // A running ccx session announces the account it is on, through the same call
  // the session itself makes.
  const sessionOn = options.sessionOn === undefined ? active : options.sessionOn;
  if (sessionOn) takeLease(sessionOn, sessionDir, ctx);
  if (usage) {
    writeFileSync(path.join(home, 'usage-snapshot.json'), JSON.stringify({ accounts: usage }), 'utf8');
  }
  const lines: string[] = [];
  return {
    lines,
    home,
    sessionDir,
    context: { ctx, config: loadConfig(ctx), out: (m) => lines.push(m), json: false, quiet: false },
  };
}

const entry = (over: Record<string, unknown>) => ({
  fiveHour: null,
  sevenDay: null,
  fiveHourReset: null,
  sevenDayReset: null,
  at: Date.now(),
  ...over,
});

describe('statuslineCommand', () => {
  it('reports the room LEFT on the window that runs out first', async () => {
    const { context, lines } = setup('work', {
      work: entry({ fiveHour: 0.1, sevenDay: 0.62, models: [{ name: 'Fable', utilization: 0.78 }] }),
    });
    expect(await statuslineCommand(context)).toBe(0);
    // Not the hour or the week: the model window is what would stop you. And it
    // says what remains, because a bare "78%" reads as plenty when it is not.
    expect(lines[0]).toBe('work Fable 22% left');
  });

  it('does NOT report a model as spent once its window has reset', async () => {
    // This line sits inside Claude's interface the whole time it runs. Showing
    // "Fable spent" for a window that reset hours ago is alarming and wrong,
    // which is as bad here as reassuring and wrong.
    const { context, lines } = setup('work', {
      work: entry({
        fiveHour: 0.1,
        sevenDay: 0.2,
        models: [{ name: 'Fable', utilization: 1, resetsAt: Date.now() - 3600_000 }],
      }),
    });
    expect(await statuslineCommand(context)).toBe(0);
    expect(lines[0]).not.toContain('spent');
    // The week is now the tightest window that is actually running.
    expect(lines[0]).toBe('work week 80% left');
  });

  it('says SIGN IN for a login the endpoint has already refused', async () => {
    // The bug this closes: a dead refresh token leaves a credential file that
    // looks complete, so every local check passes and the existing warning one
    // line above could not fire. The line then reported full headroom, in
    // Claude's own interface, for an account that cannot authenticate.
    const { context, lines } = setup('work', {
      work: entry({ fiveHour: 0, sevenDay: 0 }),
    });
    const homeDir = (context.ctx.env as Record<string, string>).CLAUDE_AUTO_SWITCH_HOME ?? '';
    const dir = path.join(homeDir, 'profiles', 'work');
    // Recorded THROUGH the real renewal path, not by calling the store directly.
    // Writing the note by hand hides a mismatch between the key production files
    // it under and the key this line looks it up by, which is exactly the bug
    // this test failed to catch the first time.
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r-dead', expiresAt: 1 } }),
      'utf8',
    );
    const refused = await refreshCredentialIfExpired(dir, {
      ctx: context.ctx,
      now: () => 2_000_000,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as unknown as typeof fetch,
    });
    expect(refused.status).toBe('needs-login');

    expect(await statuslineCommand(context)).toBe(0);
    expect(lines[0]).toBe('! work needs sign-in');
  });

  it('still reports headroom for a login that has NOT been refused', async () => {
    // The other direction: a note about a different credential must not turn a
    // working account into a warning.
    const { context, lines } = setup('work', { work: entry({ fiveHour: 0.2, sevenDay: 0 }) });
    rememberDeadLogin('some-other-credential', 'invalid_grant', context.ctx);
    expect(await statuslineCommand(context)).toBe(0);
    expect(lines[0]).toBe('work 5h 80% left');
  });

  it('names an OPEN window rather than an expired one when both read empty', async () => {
    // Once expired windows read as empty, ties are the normal case, and a plain
    // "greater than" keeps whichever was listed first. That would name a window
    // which is not running at all as the thing constraining you.
    const { context, lines } = setup('work', {
      work: entry({
        fiveHour: 1,
        fiveHourReset: Date.now() - 1000, // expired, so effectively 0
        sevenDay: 0, // open, also 0
      }),
    });
    expect(await statuslineCommand(context)).toBe(0);
    expect(lines[0]).toBe('work week 100% left');
  });

  it('still names something when every window has expired', async () => {
    const { context, lines } = setup('work', {
      work: entry({ fiveHour: 1, fiveHourReset: Date.now() - 1000 }),
    });
    expect(await statuslineCommand(context)).toBe(0);
    expect(lines[0]).toBe('work 5h 100% left');
  });

  it('says "spent" and shows the reset once a window is exhausted', async () => {
    const { context, lines } = setup('work', {
      work: entry({
        fiveHour: 0,
        sevenDay: 0,
        models: [{ name: 'Fable', utilization: 1, resetsAt: Date.now() + 2 * 3600_000 }],
      }),
    });
    await statuslineCommand(context);
    expect(lines[0]).toContain('Fable spent');
    expect(lines[0]).toContain('resets 2h');
    expect(lines[0]?.startsWith('!')).toBe(true);
  });

  it('keeps the reset time out of the way while there is room', async () => {
    const { context, lines } = setup('work', {
      work: entry({ fiveHour: 0.2, sevenDay: 0.1, fiveHourReset: Date.now() + 3600_000 }),
    });
    await statuslineCommand(context);
    expect(lines[0]).toBe('work 5h 80% left');
    expect(lines[0]).not.toContain('resets');
  });

  it('omits the account name with --compact (when your line already shows it)', async () => {
    const { context, lines } = setup('work', {
      work: entry({ fiveHour: 0.25, sevenDay: 0.1 }),
    });
    await statuslineCommand(context, { compact: true });
    expect(lines[0]).toBe('5h 75% left');
  });

  it('stays quiet and useful when usage is unknown', async () => {
    const { context, lines } = setup('work');
    await statuslineCommand(context);
    expect(lines[0]).toBe('work');
  });

  it('says "no ccx" when ccx is NOT driving this session', async () => {
    // A plain `claude` session must never be shown another account's headroom
    // as though it were protected.
    const { context, lines } = setup('work', { work: entry({ fiveHour: 0.1, sevenDay: 0.1 }) }, { where: 'plain' });
    await statuslineCommand(context);
    expect(lines[0]).toBe('no ccx');
  });

  it('asks for a sign-in when the active account has no usable login', async () => {
    const { context, lines } = setup('work');
    const home = (context.ctx.env as Record<string, string>).CLAUDE_AUTO_SWITCH_HOME ?? '';
    writeFileSync(
      path.join(home, 'profiles', 'work', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: '' } }),
      'utf8',
    );
    await statuslineCommand(context);
    expect(lines[0]).toContain('needs sign-in');
  });

  it('says so when no account is selected', async () => {
    // The editor's folder follows the active account, so there the active
    // account being unset is the whole story.
    const { context, lines } = setup(null, undefined, { where: 'editor' });
    await statuslineCommand(context);
    expect(lines[0]).toContain('no account');
  });

  describe('whose account the line describes', () => {
    // The active account is where NEW sessions start. A move aimed at one
    // session (a swap, `ccx use --session` or `--here`, a move off a capped
    // account) leaves it alone, so every session that has been moved is on a
    // different account from it, and the line has to follow the session.
    const usage = {
      work: entry({ fiveHour: 0.1, sevenDay: 0 }),
      side: entry({ fiveHour: 0.7, sevenDay: 0 }),
    };

    it("names the session's OWN account, with that account's numbers", async () => {
      const { context, lines } = setup('work', usage, { accounts: ['work', 'side'], sessionOn: 'side' });
      expect(await statuslineCommand(context)).toBe(0);
      expect(lines[0]).toBe('side 5h 30% left');
    });

    it("warns about the session's account, not the active one", async () => {
      const { context, lines, home } = setup('work', usage, { accounts: ['work', 'side'], sessionOn: 'side' });
      writeFileSync(
        path.join(home, 'profiles', 'side', '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: '' } }),
        'utf8',
      );
      await statuslineCommand(context);
      expect(lines[0]).toBe('! side needs sign-in');
    });

    it('keeps following the active account in the editor, whatever a terminal session is on', async () => {
      // The editor's folder is a link ccx re-points at the active account, so
      // there the active account IS the one in use.
      const { context, lines } = setup('work', usage, {
        where: 'editor',
        accounts: ['work', 'side'],
        sessionOn: 'side',
      });
      await statuslineCommand(context);
      expect(lines[0]).toBe('work 5h 90% left');
    });

    it('names the account the session is moving onto while it briefly announces both', async () => {
      // A move announces the new account before it gives up the old one, so for
      // a moment two announcements name this folder. The newer one is the move.
      const { context, lines, sessionDir } = setup('work', usage, {
        accounts: ['work', 'side'],
        sessionOn: null,
      });
      takeLease('work', sessionDir, context.ctx, { now: () => Date.now() - 5_000 });
      takeLease('side', sessionDir, context.ctx);
      await statuslineCommand(context);
      expect(lines[0]).toBe('side 5h 30% left');
    });

    it('goes by who the folder is signed in as when no announcement names it', async () => {
      // A live session can lose its announcement (one left untouched past its
      // freshness window is cleared by the next reader). The folder's own login
      // still says which account Claude is running on.
      const { context, lines, sessionDir } = setup('work', usage, {
        accounts: ['work', 'side'],
        sessionOn: null,
      });
      writeFileSync(
        path.join(sessionDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'SIDE@example.com' } }),
        'utf8',
      );
      await statuslineCommand(context);
      expect(lines[0]).toBe('side 5h 30% left');
    });

    it('says the account is unknown rather than naming the active one when nothing says', async () => {
      const { context, lines } = setup('work', usage, { accounts: ['work', 'side'], sessionOn: null });
      await statuslineCommand(context);
      expect(lines[0]).toBe('ccx: account unknown');
    });

    it('is not thrown by a damaged announcement', async () => {
      const { context, lines, sessionDir } = setup('work', usage, {
        accounts: ['work', 'side'],
        sessionOn: null,
      });
      takeLease('side', sessionDir, context.ctx, { now: () => Date.now() - 5_000 });
      // Live and newer, so it is read, but with no folder a path can be made of.
      writeFileSync(
        leasePath('work', context.ctx, process.pid),
        JSON.stringify({ account: 'work', pid: process.pid, configDir: 42, at: Date.now() }),
        'utf8',
      );
      await statuslineCommand(context);
      expect(lines[0]).toBe('side 5h 30% left');
    });
  });

  it('prints the settings snippet with --install', async () => {
    const { context, lines } = setup('work');
    await statuslineCommand(context, { install: true });
    expect(lines.join('\n')).toContain('"statusLine"');
    expect(lines.join('\n')).toContain('ccx statusline');
  });
});
