import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  continuationArgs,
  handOff,
  handedOffRecently,
  HANDOFF_QUIET_MS,
  lastModelIn,
  launchSpec,
  parseFlags,
  permissionArgs,
  readLaunchSpec,
  recordHandoff,
  runHandoffJob,
  scheduleHandoff,
  type HandoffTarget,
} from './handoff.js';

const ID = '9106faa2-0b73-4126-9a9f-581cc123867f';
const target: HandoffTarget = {
  sessionId: ID,
  cwd: 'C:\\work',
  name: 'Database schema review',
  model: 'claude-opus-5-5',
  effort: 'max',
  permissionMode: 'bypassPermissions',
};

describe('carrying a Desktop conversation on through ccx', () => {
  it('keeps the permission mode it had, or an unattended run stops at its first prompt', () => {
    expect(permissionArgs('bypassPermissions')).toEqual(['--dangerously-skip-permissions']);
    expect(permissionArgs('auto')).toEqual(['--permission-mode', 'auto']);
    expect(permissionArgs('acceptEdits')).toEqual(['--permission-mode', 'acceptEdits']);
    expect(permissionArgs('default')).toEqual([]);
    expect(permissionArgs(null)).toEqual([]);
  });

  it('resumes it as a copy by default, on the same model and effort, armed to carry on', () => {
    expect(continuationArgs(target, { mode: 'fork', prompt: 'Carry on.' })).toEqual([
      'run',
      '--resume-prompt',
      'Carry on.',
      '--',
      '--resume',
      ID,
      '--fork-session',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'max',
      '--dangerously-skip-permissions',
    ]);
  });

  it('resumes the conversation itself, on a chosen account, with a held message first', () => {
    const args = continuationArgs(
      { sessionId: ID, cwd: 'C:\\work', name: '' },
      { mode: 'same', prompt: 'Carry on.', account: 'osa', startPrompt: 'fix the flaky test' },
    );
    expect(args).toEqual([
      'run',
      '--account',
      'osa',
      '--resume-prompt',
      'Carry on.',
      '--start-prompt',
      'fix the flaky test',
      '--',
      '--resume',
      ID,
    ]);
  });

  it('keeps a held message out of every command line, quotes, lines, length and all', () => {
    // Windows PowerShell 5.1 splits an argument with a double quote in it when
    // it starts a program, so the message travels in the launch file instead.
    const message = 'fix "the foo" test and "bar baz" too\n- then push';
    const c = {
      env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-handoff-q-')) },
    };
    const scripts: string[] = [];
    const result = handOff(target, { mode: 'fork', prompt: 'Carry on.', startPrompt: message }, c, {
      platform: 'win32',
      ccx: { node: 'node', cli: 'cli.js' },
      exists: () => false,
      start: () => {},
      writeScript: (_f, content) => scripts.push(content),
    });
    expect(result.ok).toBe(true);
    expect(scripts[0]).not.toContain('the foo');
    const launch = path.join(c.env.CLAUDE_AUTO_SWITCH_HOME, 'handoffs', `${ID}.launch.json`);
    expect(JSON.parse(readFileSync(launch, 'utf8'))).toEqual(
      launchSpec(target, { mode: 'fork', prompt: 'Carry on.', startPrompt: message }),
    );
    expect(readLaunchSpec(launch)?.startPrompt).toBe(message);
  });

  it('reads model, effort and permission mode off the command line Desktop started it with', () => {
    // Taken from a live Desktop session, trimmed.
    const line =
      'C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1.284\\claude.exe --output-format stream-json ' +
      '--verbose --input-format stream-json --effort max --model claude-opus-5-5 --permission-prompt-tool stdio ' +
      '--resume=9106faa2-0b73-4126-9a9f-581cc123867f --setting-sources=user,project,local --permission-mode bypassPermissions';
    expect(parseFlags(line)).toEqual({
      model: 'claude-opus-5-5',
      effort: 'max',
      permissionMode: 'bypassPermissions',
    });
    expect(parseFlags('claude.exe --model="claude-fable-5"')).toMatchObject({
      model: 'claude-fable-5',
    });
    expect(parseFlags('claude.exe')).toEqual({ model: null, effort: null, permissionMode: null });
  });
});

describe('handing over', () => {
  const ctx = (): { env: Record<string, string> } => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-handoff-'));
    return { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  };

  it('opens a terminal running this ccx, waiting for Desktop first when asked', () => {
    const c = ctx();
    const started: Array<{ program: string; args: string[] }> = [];
    const scripts: Array<{ file: string; content: string }> = [];
    const result = handOff(
      target,
      { mode: 'fork', prompt: 'Carry on.' },
      c,
      {
        platform: 'win32',
        ccx: { node: 'C:\\node.exe', cli: 'C:\\ccx\\cli.js' },
        exists: (p) => p === 'wt.exe',
        start: (program, args) => started.push({ program, args }),
        writeScript: (file, content) => scripts.push({ file, content }),
        now: () => 1_000,
      },
      4242,
    );
    expect(result.ok).toBe(true);
    expect(started[0]?.program).toBe('wt.exe');
    expect(scripts[0]?.file).toBe(
      path.join(c.env.CLAUDE_AUTO_SWITCH_HOME as string, 'handoffs', `${ID}.ps1`),
    );
    expect(scripts[0]?.content).toContain("'desktop' 'wait' '4242'");
    // What to run is in a file beside it, not on the launcher's command line.
    const launch = path.join(
      c.env.CLAUDE_AUTO_SWITCH_HOME as string,
      'handoffs',
      `${ID}.launch.json`,
    );
    expect(scripts[0]?.content).toContain(`'desktop-run' '${launch}'`);
    expect(readLaunchSpec(launch)?.claudeArgs).toEqual([
      '--resume',
      ID,
      '--fork-session',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'max',
      '--dangerously-skip-permissions',
    ]);
    expect(handedOffRecently(ID, c, 1_000 + 60_000)).toBe(1_000);
    expect(handedOffRecently(ID, c, 1_000 + HANDOFF_QUIET_MS + 1)).toBeNull();
  });

  it('from a hook: writes the job down, marks it handed over at once, and starts a detached ccx', () => {
    const c = ctx();
    const started: string[] = [];
    const job = {
      target: { sessionId: ID, cwd: 'C:\\work', name: 'x', effort: 'max' },
      settings: { mode: 'fork' as const, prompt: 'Carry on.' },
      flagsFrom: 4242,
      waitFor: 4242,
    };
    expect(scheduleHandoff(job, c, (file) => started.push(file), 5_000)).toBe(true);
    expect(started).toHaveLength(1);
    expect(handedOffRecently(ID, c, 6_000)).toBe(5_000);

    // The detached ccx: fills in what the payload did not say, then hands over.
    const handed: Array<{ target: HandoffTarget; waitFor?: number }> = [];
    const result = runHandoffJob(started[0] as string, c, {
      flagsOf: () => ({
        model: 'claude-opus-5-5',
        effort: 'low',
        permissionMode: 'bypassPermissions',
      }),
      handOff: (target, _s, _c, _d, waitFor) => {
        handed.push({ target, ...(waitFor !== undefined ? { waitFor } : {}) });
        return { ok: true, via: 'Windows Terminal', script: 'x', command: [] };
      },
    });
    expect(result.ok).toBe(true);
    // The payload's own effort wins over the command line's.
    expect(handed[0]?.target).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'max',
      permissionMode: 'bypassPermissions',
    });
    expect(handed[0]?.waitFor).toBe(4242);
    expect(existsSync(started[0] as string)).toBe(false);
  });

  it('reads the model a conversation last answered with from the end of its transcript', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-handoff-tr-'));
    const file = path.join(dir, 't.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5' } }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } }),
        JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } }),
        // A subagent's turn, inline in older transcripts.
        JSON.stringify({
          isSidechain: true,
          type: 'assistant',
          message: { model: 'claude-haiku-4-5' },
        }),
        JSON.stringify({ type: 'user', message: { content: 'x' } }),
      ].join('\n'),
    );
    expect(lastModelIn(file)).toBe('claude-opus-5-5');
    expect(lastModelIn(path.join(dir, 'missing.jsonl'))).toBeNull();
  });

  it('forgets a scheduled handover whose window never opened, so Desktop is not held back for it', () => {
    const c = ctx();
    const job = {
      target: { sessionId: ID, cwd: 'C:\work', name: 'x' },
      settings: { mode: 'fork' as const, prompt: 'Carry on.' },
    };
    const failed = (): { ok: false; reason: string } => ({ ok: false, reason: 'no terminal' });
    const files: string[] = [];
    scheduleHandoff(job, c, (file) => files.push(file), 5_000);
    expect(runHandoffJob(files[0] as string, c, { handOff: failed }).ok).toBe(false);
    expect(handedOffRecently(ID, c, 6_000)).toBeNull();

    // A handover recorded after the failed one was scheduled is a different one: kept.
    scheduleHandoff(job, c, (file) => files.push(file), 7_000);
    recordHandoff(ID, c, 8_000);
    runHandoffJob(files[1] as string, c, { handOff: failed });
    expect(handedOffRecently(ID, c, 9_000)).toBe(8_000);
  });

  it('takes the record back when the detached ccx cannot start, so a retry is not held off', () => {
    const c = ctx();
    const job = {
      target: { sessionId: ID, cwd: 'w', name: 'x' },
      settings: { mode: 'fork' as const, prompt: 'Carry on.' },
    };
    // Fails later, as a spawn does.
    expect(scheduleHandoff(job, c, (_file, failed) => failed(), 5_000)).toBe(true);
    expect(handedOffRecently(ID, c, 6_000)).toBeNull();
    // Fails at once.
    const throws = (): void => {
      throw new Error('no node');
    };
    expect(scheduleHandoff(job, c, throws, 7_000)).toBe(false);
    expect(handedOffRecently(ID, c, 8_000)).toBeNull();
  });

  it('clears out launchers old enough to have done their work', () => {
    const c = ctx();
    const dir = path.join(c.env.CLAUDE_AUTO_SWITCH_HOME as string, 'handoffs');
    mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'old.ps1');
    const fresh = path.join(dir, 'fresh.ps1');
    writeFileSync(old, '');
    writeFileSync(fresh, '');
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60_000) / 1000;
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    handOff(target, { mode: 'fork', prompt: 'Carry on.' }, c, {
      platform: 'win32',
      ccx: { node: 'node', cli: 'cli.js' },
      exists: () => false,
      start: () => {},
      writeScript: () => {},
    });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('remembers nothing when no terminal could be opened', () => {
    const c = ctx();
    const result = handOff(target, { mode: 'fork', prompt: 'Carry on.' }, c, {
      platform: 'linux',
      ccx: { node: 'node', cli: 'cli.js' },
      exists: () => false,
      start: () => {},
      writeScript: () => {},
    });
    expect(result.ok).toBe(false);
    expect(handedOffRecently(ID, c)).toBeNull();
  });
});
