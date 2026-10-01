import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  desktopCommand,
  desktopHookCommand,
  desktopRunCommand,
  nextHandoff,
  type DesktopDeps,
} from './desktop.js';
import { addAccount } from '../accounts/registry.js';
import { loadConfig, saveConfig } from '../config/config.js';
import { loadLedger, markCapped, saveLedger } from '../ledger/ledger.js';
import { readInstalledHandoff } from '../desktop/hooks.js';
import type { DesktopConversation } from '../desktop/desktop-sessions.js';
import { scheduleHandoff, type HandoffSettings, type HandoffTarget } from '../desktop/handoff.js';
import type { CliContext } from '../context.js';

const STEPHEN = '1b0125dc-730c-4d80-90da-af791d8f2b05';
const CONV = '9106faa2-0b73-4126-9a9f-581cc123867f';

interface Setup {
  context: CliContext;
  said: string[];
  told: string[];
  handed: Array<{ target: HandoffTarget; settings: HandoffSettings; waitFor?: number }>;
  deps: DesktopDeps;
}

/**
 * A home with ccx accounts, Claude Desktop signed in as `stephen`, and the
 * environment a hook sees inside a Desktop session.
 */
function setup(
  options: {
    handoff?: 'off' | 'limit' | 'credits';
    entrypoint?: string;
    payload?: Record<string, unknown>;
    spent?: boolean;
    conversations?: DesktopConversation[];
  } = {},
): Setup {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-desk-cmd-'));
  const appData = path.join(home, 'AppData');
  mkdirSync(path.join(appData, 'Claude'), { recursive: true });
  writeFileSync(
    path.join(appData, 'Claude', 'config.json'),
    JSON.stringify({ lastKnownAccountUuid: STEPHEN }),
  );
  const env: Record<string, string> = {
    CLAUDE_AUTO_SWITCH_HOME: home,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    CLAUDE_PID: '777',
    ...(options.entrypoint !== undefined ? { CLAUDE_CODE_ENTRYPOINT: options.entrypoint } : {}),
  };
  const ctx = { platform: 'win32' as const, env };
  for (const [name, uuid] of [
    ['stephen', STEPHEN],
    ['osa', 'other'],
  ] as const) {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: uuid } }),
    );
    writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }));
    addAccount({ name, dir }, ctx);
  }
  if (options.handoff) saveConfig({ desktop: { handoff: options.handoff } }, ctx);
  const said: string[] = [];
  const told: string[] = [];
  const handed: Setup['handed'] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: 'claude', prefixArgs: [] },
    out: (m) => said.push(m),
    err: (m) => told.push(m),
    json: false,
    quiet: false,
  };
  const now = Date.now();
  const deps: DesktopDeps = {
    stdin: () => Promise.resolve(JSON.stringify(options.payload ?? {})),
    conversations: () =>
      options.conversations ?? [
        {
          pid: 777,
          sessionId: CONV,
          cwd: 'C:\\work',
          name: 'Schema review',
          status: 'idle',
          statusSince: null,
          startedAt: null,
        },
      ],
    flagsOf: () => ({
      model: 'claude-opus-5-5',
      effort: 'max',
      permissionMode: 'bypassPermissions',
    }),
    usageOf: () =>
      Promise.resolve({
        fiveHour: 0.1,
        sevenDay: options.spent ? 1 : 0.4,
        fiveHourReset: now + 3_600_000,
        sevenDayReset: now + 4 * 86_400_000,
        at: now,
      }),
    handOff: (target, settings, _c, _d, waitFor) => {
      handed.push({ target, settings, ...(waitFor !== undefined ? { waitFor } : {}) });
      return { ok: true, via: 'Windows Terminal', script: 'x.ps1', command: [] };
    },
    // Whatever this machine has: a Linux runner has no terminal program.
    canOpen: () => true,
    // What a hook hands to the detached ccx.
    schedule: (job) => {
      handed.push({
        target: job.target,
        settings: job.settings,
        ...(job.waitFor !== undefined ? { waitFor: job.waitFor } : {}),
      });
      return true;
    },
  };
  return { context, said, told, handed, deps };
}

/** A transcript whose last answer came from Opus, the way Claude writes one. */
const TRANSCRIPT = path.join(
  mkdtempSync(path.join(tmpdir(), 'cas-desk-tr-')),
  'conversation.jsonl',
);
writeFileSync(
  TRANSCRIPT,
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [] } }),
    JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
  ].join('\n') + '\n',
);

const LIMIT = {
  session_id: CONV,
  cwd: 'C:\\work',
  transcript_path: TRANSCRIPT,
  error: 'rate_limit',
  effort: { level: 'max' },
};

describe('the hook Claude Desktop runs at a usage limit', () => {
  it('carries the conversation on in a terminal, waiting for Desktop to let go of it', async () => {
    const s = setup({ handoff: 'limit', entrypoint: 'claude-desktop', payload: LIMIT });
    expect(await desktopHookCommand(s.context, 'limit', s.deps)).toBe(0);
    expect(s.handed).toHaveLength(1);
    expect(s.handed[0]).toMatchObject({
      target: {
        sessionId: CONV,
        cwd: 'C:\\work',
        name: 'Schema review',
        model: 'claude-opus-5-5',
        effort: 'max',
      },
      settings: { mode: 'fork', prompt: 'Carry on where you stopped.' },
      waitFor: 777,
    });
  });

  it('hands a conversation over once, however many times its turns fail', async () => {
    const s = setup({ handoff: 'limit', entrypoint: 'claude-desktop', payload: LIMIT });
    // The real scheduler, with the detached ccx it would start recorded instead.
    const started: string[] = [];
    s.deps.schedule = (job, c) => scheduleHandoff(job, c, (file) => started.push(file));
    await desktopHookCommand(s.context, 'limit', s.deps);
    await desktopHookCommand(s.context, 'limit', s.deps);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatch(new RegExp(`${CONV}\\.job\\.json$`));
  });

  it('does nothing outside Desktop, when switched off, or for any other error', async () => {
    for (const s of [
      setup({ handoff: 'limit', entrypoint: 'cli', payload: LIMIT }),
      setup({ handoff: 'off', entrypoint: 'claude-desktop', payload: LIMIT }),
      setup({
        handoff: 'limit',
        entrypoint: 'claude-desktop',
        payload: { ...LIMIT, error: 'overloaded' },
      }),
      setup({ handoff: 'limit', entrypoint: 'claude-desktop', payload: { error: 'rate_limit' } }),
    ]) {
      expect(await desktopHookCommand(s.context, 'limit', s.deps)).toBe(0);
      expect(s.handed).toHaveLength(0);
    }
  });

  it('never fails the turn on input it cannot read', async () => {
    const s = setup({ handoff: 'limit', entrypoint: 'claude-desktop' });
    s.deps.stdin = () => Promise.resolve('not json');
    expect(await desktopHookCommand(s.context, 'limit', s.deps)).toBe(0);
  });
});

describe('the hook Claude Desktop runs before sending a message', () => {
  const MESSAGE = {
    session_id: CONV,
    cwd: 'C:\\work',
    prompt: 'now fix the failing tests',
    permission_mode: 'auto',
  };

  it('holds the message when Desktop is past its plan, and carries it on in a terminal instead', async () => {
    const s = setup({
      handoff: 'credits',
      entrypoint: 'claude-desktop',
      payload: MESSAGE,
      spent: true,
    });
    expect(await desktopHookCommand(s.context, 'prompt', s.deps)).toBe(2);
    expect(s.handed[0]?.settings).toMatchObject({ startPrompt: 'now fix the failing tests' });
    expect(s.handed[0]?.target.permissionMode).toBe('auto');
    expect(s.told.join(' ')).toMatch(/stephen is past its plan .*did not go to Desktop/);
  });

  it('lets the message through while the plan still has room', async () => {
    const s = setup({
      handoff: 'credits',
      entrypoint: 'claude-desktop',
      payload: MESSAGE,
      spent: false,
    });
    expect(await desktopHookCommand(s.context, 'prompt', s.deps)).toBe(0);
    expect(s.handed).toHaveLength(0);
  });

  it('only on "credits": at "limit" a message always goes through', async () => {
    const s = setup({
      handoff: 'limit',
      entrypoint: 'claude-desktop',
      payload: MESSAGE,
      spent: true,
    });
    expect(await desktopHookCommand(s.context, 'prompt', s.deps)).toBe(0);
  });

  it('lets the message through rather than strand it when it cannot be handed over', async () => {
    const s = setup({
      handoff: 'credits',
      entrypoint: 'claude-desktop',
      payload: MESSAGE,
      spent: true,
    });
    s.deps.schedule = () => false;
    expect(await desktopHookCommand(s.context, 'prompt', s.deps)).toBe(0);
  });

  it('lets through a message too long to carry over, rather than hold it and lose it', async () => {
    const s = setup({
      handoff: 'credits',
      entrypoint: 'claude-desktop',
      payload: { ...MESSAGE, prompt: 'x'.repeat(15_001) },
      spent: true,
    });
    expect(await desktopHookCommand(s.context, 'prompt', s.deps)).toBe(0);
    expect(s.handed).toHaveLength(0);
  });

  it('lets the message through where no terminal can be opened to carry it on', async () => {
    const s = setup({
      handoff: 'credits',
      entrypoint: 'claude-desktop',
      payload: MESSAGE,
      spent: true,
    });
    s.deps.canOpen = () => false;
    expect(await desktopHookCommand(s.context, 'prompt', s.deps)).toBe(0);
    expect(s.handed).toHaveLength(0);
  });
});

describe('ccx desktop move', () => {
  const busy: DesktopConversation = {
    pid: 777,
    sessionId: CONV,
    cwd: 'C:\\work',
    name: 'Schema review',
    status: 'busy',
    statusSince: null,
    startedAt: null,
  };

  it('refuses a conversation Desktop is still working on, unless told to wait', async () => {
    const s = setup({ conversations: [busy] });
    expect(await desktopCommand(s.context, 'move', ['1'], {}, s.deps)).toBe(1);
    expect(s.said.join(' ')).toMatch(/working in Desktop right now/);
    expect(s.handed).toHaveLength(0);
    expect(await desktopCommand(s.context, 'move', ['1'], { wait: true }, s.deps)).toBe(0);
    expect(s.handed[0]?.waitFor).toBe(777);
  });

  it('moves it to the account asked for, and only to one that exists', async () => {
    const s = setup({ conversations: [{ ...busy, status: 'idle' }] });
    expect(await desktopCommand(s.context, 'move', ['schema'], { to: 'nobody' }, s.deps)).toBe(1);
    expect(await desktopCommand(s.context, 'move', ['schema'], { to: 'osa' }, s.deps)).toBe(0);
    expect(s.handed[0]?.settings.account).toBe('osa');
  });

  it('refuses an account that could not take it, instead of starting somewhere else unsaid', async () => {
    const s = setup({ conversations: [{ ...busy, status: 'idle' }] });
    const home = s.context.ctx.env?.HOME as string;
    saveLedger(
      markCapped(loadLedger(s.context.ctx), {
        account: 'osa',
        now: Date.now(),
        backoffMinutes: 60,
      }),
      s.context.ctx,
    );
    expect(await desktopCommand(s.context, 'move', ['1'], { to: 'osa' }, s.deps)).toBe(1);
    expect(s.said.join(' ')).toMatch(/"osa" is out of usage/);
    rmSync(path.join(home, 'profiles', 'stephen', '.credentials.json'));
    expect(await desktopCommand(s.context, 'move', ['1'], { to: 'stephen' }, s.deps)).toBe(1);
    expect(s.said.join(' ')).toMatch(/"stephen" is not signed in/);
    expect(s.handed).toHaveLength(0);
  });

  it('shows what it would run, without running it', async () => {
    const s = setup({ conversations: [{ ...busy, status: 'idle' }] });
    expect(await desktopCommand(s.context, 'move', ['1'], { dryRun: true }, s.deps)).toBe(0);
    expect(s.handed).toHaveLength(0);
    expect(s.said.join('\n')).toContain(`--resume ${CONV} --fork-session --model claude-opus-5-5`);
  });
});

describe('ccx desktop-run: what the window runs', () => {
  it('reads what to run from the file, so no text passes through a command line', async () => {
    const s = setup();
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cas-desk-run-')), 'x.launch.json');
    const message = 'fix "the foo" test; then\n- push';
    writeFileSync(
      file,
      JSON.stringify({
        account: 'osa',
        resumePrompt: 'Carry on.',
        startPrompt: message,
        claudeArgs: ['--resume', CONV, '--fork-session'],
      }),
    );
    const ran: Array<{ args: string[]; options: unknown }> = [];
    s.deps.run = (_context, args, options) => {
      ran.push({ args, options });
      return Promise.resolve(0);
    };
    expect(await desktopRunCommand(s.context, file, s.deps)).toBe(0);
    expect(ran[0]).toEqual({
      args: ['--resume', CONV, '--fork-session'],
      options: { resumePrompt: 'Carry on.', startPrompt: message, account: 'osa' },
    });
  });

  it('refuses a file that is not a launch, and runs nothing', async () => {
    const s = setup();
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cas-desk-run-')), 'x.launch.json');
    writeFileSync(file, JSON.stringify({ claudeArgs: 'not a list' }));
    let ran = false;
    s.deps.run = () => {
      ran = true;
      return Promise.resolve(0);
    };
    expect(await desktopRunCommand(s.context, file, s.deps)).toBe(1);
    expect(ran).toBe(false);
  });
});

describe('ccx desktop settings', () => {
  it('the dashboard key steps off, limit, credits, and round again', () => {
    expect([nextHandoff('off'), nextHandoff('limit'), nextHandoff('credits')]).toEqual([
      'limit',
      'credits',
      'off',
    ]);
  });

  it('installs the hooks the choice needs, and keeps the choice', async () => {
    const s = setup();
    expect(await desktopCommand(s.context, 'handoff', ['credits'], {}, s.deps)).toBe(0);
    expect(readInstalledHandoff(s.context.ctx)).toBe('credits');
    expect(loadConfig(s.context.ctx).desktop.handoff).toBe('credits');
    expect(await desktopCommand(s.context, 'handoff', ['off'], {}, s.deps)).toBe(0);
    expect(readInstalledHandoff(s.context.ctx)).toBe('off');
  });

  it('refuses a prompt Claude could not be given', async () => {
    const s = setup();
    // Claude would read a prompt that starts with "-" as a flag.
    expect(await desktopCommand(s.context, 'prompt', ['--carry', 'on'], {}, s.deps)).toBe(1);
    expect(await desktopCommand(s.context, 'prompt', ['Keep', 'going.'], {}, s.deps)).toBe(0);
    expect(loadConfig(s.context.ctx).desktop.prompt).toBe('Keep going.');
  });

  it('says which account Desktop spends, and lists what is open there', async () => {
    const s = setup({ spent: true });
    expect(await desktopCommand(s.context, undefined, [], {}, s.deps)).toBe(0);
    expect(s.said[0]).toMatch(/signed in as stephen: weekly limit spent/);
    expect(s.said.join('\n')).toMatch(/1 {2}idle {2}Schema review/);
  });
});
