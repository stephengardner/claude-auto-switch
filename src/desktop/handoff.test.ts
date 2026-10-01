import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  continuationArgs,
  handOff,
  handedOffRecently,
  HANDOFF_QUIET_MS,
  parseFlags,
  permissionArgs,
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

  it('reads model, effort and permission mode off the command line Desktop started it with', () => {
    // Taken from a live Desktop session, trimmed.
    const line =
      'C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1.284\\claude.exe --output-format stream-json ' +
      '--verbose --input-format stream-json --effort max --model claude-opus-5-5 --permission-prompt-tool stdio ' +
      '--resume=9106faa2-0b73-4126-9a9f-581cc123867f --setting-sources=user,project,local --permission-mode bypassPermissions';
    expect(parseFlags(line)).toEqual({ model: 'claude-opus-5-5', effort: 'max', permissionMode: 'bypassPermissions' });
    expect(parseFlags('claude.exe --model="claude-fable-5"')).toMatchObject({ model: 'claude-fable-5' });
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
    expect(scripts[0]?.file).toBe(path.join(c.env.CLAUDE_AUTO_SWITCH_HOME as string, 'handoffs', `${ID}.ps1`));
    expect(scripts[0]?.content).toContain("'desktop' 'wait' '4242'");
    expect(scripts[0]?.content).toContain("'--fork-session'");
    expect(handedOffRecently(ID, c, 1_000 + 60_000)).toBe(1_000);
    expect(handedOffRecently(ID, c, 1_000 + HANDOFF_QUIET_MS + 1)).toBeNull();
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
