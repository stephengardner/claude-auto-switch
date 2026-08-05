import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { statuslineCommand } from './statusline.js';
import { rememberDeadLogin } from '../usage/dead-login-store.js';
import { refreshCredentialIfExpired } from '../usage/oauth-refresh.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

function setup(
  active: string | null,
  usage?: Record<string, unknown>,
  options: { managed?: boolean } = {},
): { context: CliContext; lines: string[] } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-status-'));
  // Claude runs the status line inside the session, so a managed session is one
  // whose config location is the folder ccx handed it.
  const managed = options.managed ?? true;
  const ctx = {
    env: {
      CLAUDE_AUTO_SWITCH_HOME: home,
      ...(managed ? { CLAUDE_CONFIG_DIR: path.join(home, 'session') } : {}),
    },
  };
  if (active) {
    writeFileSync(path.join(home, 'active.json'), JSON.stringify({ active }), 'utf8');
    // A signed-in account, so the line reports usage rather than asking for a login.
    const dir = path.join(home, 'profiles', active);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }),
      'utf8',
    );
    writeFileSync(
      path.join(home, 'accounts.json'),
      JSON.stringify({ accounts: [{ name: active, dir, priority: 0, enabled: true }] }),
      'utf8',
    );
  }
  if (usage) {
    writeFileSync(path.join(home, 'usage-snapshot.json'), JSON.stringify({ accounts: usage }), 'utf8');
  }
  const lines: string[] = [];
  return {
    lines,
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
    const { context, lines } = setup('work', { work: entry({ fiveHour: 0.1, sevenDay: 0.1 }) }, { managed: false });
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
    const { context, lines } = setup(null);
    await statuslineCommand(context);
    expect(lines[0]).toContain('no account');
  });

  it('prints the settings snippet with --install', async () => {
    const { context, lines } = setup('work');
    await statuslineCommand(context, { install: true });
    expect(lines.join('\n')).toContain('"statusLine"');
    expect(lines.join('\n')).toContain('ccx statusline');
  });
});
