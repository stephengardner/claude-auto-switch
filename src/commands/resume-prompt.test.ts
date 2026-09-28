import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resumePromptCommand } from './resume-prompt.js';
import { takeLease } from '../session/lease.js';
import { sessionDirFor } from '../session/session-dir.js';
import { RESUME_PROMPT_FILE, readResumePrompt } from '../session/resume-prompt.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

/**
 * A temp ccx home with ONE live session: this test process, which is alive for
 * as long as the test runs, so the liveness check is real rather than faked.
 */
function liveSession(extraEnv: Record<string, string> = {}): {
  context: CliContext;
  dir: string;
  lines: string[];
} {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-resume-cmd-'));
  const env = { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home, ...extraEnv };
  const ctx = { env };
  const dir = sessionDirFor(process.pid, ctx);
  mkdirSync(dir, { recursive: true });
  takeLease('A', dir, ctx, { cwd: path.join(home, 'project') });
  const lines: string[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    out: (m) => lines.push(m),
    json: false,
    quiet: false,
  };
  return { context, dir, lines };
}

describe('ccx resume-prompt', () => {
  it('arms the session it runs INSIDE, found through its CLAUDE_CONFIG_DIR', () => {
    // How an unattended session arms itself: its tools run with the session's
    // own directory as CLAUDE_CONFIG_DIR, so it needs no pid to name itself.
    const { context, dir } = liveSession();
    context.ctx.env!.CLAUDE_CONFIG_DIR = dir;
    expect(
      resumePromptCommand(context, ['Resumed', 'after', 'a', 'swap:', 'carry', 'on.'], {}),
    ).toBe(0);
    expect(readResumePrompt(dir)).toEqual({
      armed: true,
      prompt: 'Resumed after a swap: carry on.',
    });
  });

  it('arms a session named by --session <pid>', () => {
    const { context, dir } = liveSession();
    expect(resumePromptCommand(context, ['carry on'], { session: String(process.pid) })).toBe(0);
    expect(readResumePrompt(dir)).toEqual({ armed: true, prompt: 'carry on' });
  });

  it('shows what is armed, and says so when nothing is', () => {
    const { context, lines } = liveSession();
    expect(resumePromptCommand(context, [], { session: String(process.pid) })).toBe(0);
    expect(lines.join('\n')).toMatch(/nothing armed/);
    resumePromptCommand(context, ['carry on'], { session: String(process.pid) });
    lines.length = 0;
    expect(resumePromptCommand(context, [], { session: String(process.pid) })).toBe(0);
    expect(lines.join('\n')).toMatch(/armed: carry on/);
  });

  it('refuses a prompt that breaks the rules, and arms nothing', () => {
    const { context, dir, lines } = liveSession();
    expect(resumePromptCommand(context, ['--not-a-prompt'], { session: String(process.pid) })).toBe(
      1,
    );
    expect(lines.join('\n')).toMatch(/flag/);
    expect(existsSync(path.join(dir, RESUME_PROMPT_FILE))).toBe(false);
  });

  it('disarms with --clear, and refuses a prompt given together with --clear', () => {
    const { context, dir } = liveSession();
    resumePromptCommand(context, ['carry on'], { session: String(process.pid) });
    expect(
      resumePromptCommand(context, ['carry on'], { session: String(process.pid), clear: true }),
    ).toBe(1);
    expect(resumePromptCommand(context, [], { session: String(process.pid), clear: true })).toBe(0);
    expect(readResumePrompt(dir)).toEqual({ armed: false });
  });

  it('refuses when it cannot tell which session is meant', () => {
    // Outside a ccx session, with no target: arming "some session" would be a
    // guess, and a wrong guess hands one session another session's instruction.
    const { context, lines } = liveSession();
    delete context.ctx.env!.CLAUDE_CONFIG_DIR;
    expect(resumePromptCommand(context, ['carry on'], {})).toBe(1);
    expect(lines.join('\n')).toMatch(/--session/);
  });

  it('refuses a pid with no live session behind it', () => {
    const { context, lines } = liveSession();
    expect(resumePromptCommand(context, ['carry on'], { session: '999999' })).toBe(1);
    expect(lines.join('\n')).toMatch(/no live ccx session/);
  });
});
