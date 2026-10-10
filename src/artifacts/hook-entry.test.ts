import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addAccount } from '../accounts/registry.js';
import { saveConfig } from '../config/config.js';
import type { PathCtx } from '../config/paths.js';
import { releaseLease, takeLease } from '../session/lease.js';
import { createHopController } from './hop.js';
import { hopDir, openHops } from './hop-files.js';
import { hookOutput } from './hook-run.js';
import { readPages } from './record.js';

const entry = fileURLToPath(new URL('./hook-entry.ts', import.meta.url));
const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length > 0) stops.pop()?.();
});

/** Run the entry as Claude does: a program, its argument, the call on standard input. */
function runEntry(event: string, env: Record<string, string>, input: unknown): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsx, entry, event], {
      // The test's own environment underneath (it holds no Claude variable: see
      // test/setup-env), since Windows cannot start node without some of it.
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
}

/** A ccx home with page routing on, a session on "work", and its ccx answering requests. */
function routedSession(readiness: 'ready' | 'no-login' = 'ready') {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-artifact-entry-'));
  const ctx: PathCtx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  for (const name of ['work', 'home']) addAccount({ name, dir: path.join(home, 'profiles', name) }, ctx);
  saveConfig({ artifacts: { home: 'home' } }, ctx);
  const sessionDir = path.join(home, 'sessions', '4242');
  mkdirSync(sessionDir, { recursive: true });
  takeLease('work', sessionDir, ctx);
  openHops(sessionDir, 4242);
  const moves: string[] = [];
  let on = 'work';
  const hop = createHopController<{ name: string }>({
    dir: sessionDir,
    current: () => ({ name: on }),
    account: (name) => ({ name }),
    readiness: () => readiness,
    renew: () => Promise.resolve({ ok: true }),
    activate: (account) => {
      takeLease(account.name, sessionDir, ctx);
      releaseLease(on, ctx);
      on = account.name;
      moves.push(account.name);
    },
    standing: () => 'free',
    log: () => {},
  });
  const timer = setInterval(() => {
    hop.tick();
    hop.poll();
  }, 10);
  stops.push(() => clearInterval(timer));
  const env = { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: sessionDir };
  return { ctx, env, sessionDir, moves };
}

const PUBLISH = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Artifact',
  tool_input: { file_path: path.resolve('pages', 'shape-lab.html') },
  tool_use_id: 'toolu_01',
  session_id: 'e7a0c0de-0000-4000-8000-000000000001',
  cwd: path.resolve('.'),
};

describe('what the hook says to Claude', () => {
  it('nothing, when there is nothing to say: Claude then asks the person whatever it would have', () => {
    expect(hookOutput('pre', null)).toBe('');
    expect(hookOutput('post', null)).toBe('');
  });

  it('a refusal with its reason, before the call', () => {
    expect(JSON.parse(hookOutput('pre', { deny: 'ccx: not signed in' }))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'ccx: not signed in',
      },
    });
  });

  it('never an approval, and never a refusal once the call has been made', () => {
    expect(hookOutput('pre', { context: 'a word' })).not.toContain('permissionDecision');
    expect(hookOutput('post', { deny: 'too late' })).toBe('');
  });

  it('a word for the model, under the event it was run for', () => {
    expect(JSON.parse(hookOutput('fail', { context: 'sent as "home"' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'sent as "home"' },
    });
  });
});

describe('the Artifact hook entry, run as Claude runs it', () => {
  it('says and does nothing in plain claude, Claude Desktop, the editor, or any folder that is not a ccx session', async () => {
    const s = routedSession();
    const home = s.env.CLAUDE_AUTO_SWITCH_HOME;
    const plain = { ...s.env } as Record<string, string>;
    delete plain.CLAUDE_CONFIG_DIR;
    const elsewhere = [
      plain,
      { ...s.env, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
      { ...s.env, CLAUDE_CONFIG_DIR: path.join(home, 'editor-active') },
      { ...s.env, CLAUDE_CONFIG_DIR: path.join(home, 'profiles', 'work') },
      // Named like a session, but not under this ccx's sessions folder.
      { ...s.env, CLAUDE_CONFIG_DIR: path.join(home, 'elsewhere', 'sessions', '4242') },
    ];
    for (const env of elsewhere) {
      expect(await runEntry('pre', env, PUBLISH)).toEqual({ code: 0, out: '' });
    }
    expect(s.moves).toEqual([]);
    expect(existsSync(path.join(home, 'elsewhere'))).toBe(false);
  }, 60_000);

  it('moves a ccx session for a routed call and lets it go, then puts it back and records the page', async () => {
    const s = routedSession();
    expect(await runEntry('pre', s.env, PUBLISH)).toEqual({ code: 0, out: '' });
    expect(s.moves).toEqual(['home']);
    const done = await runEntry('post', s.env, {
      ...PUBLISH,
      hook_event_name: 'PostToolUse',
      tool_response: { url: 'https://claude.ai/artifact/BmhXcGdEGscNbm7Pk1YSPc', title: 'Shape Lab' },
      duration_ms: 900,
    });
    expect(done).toEqual({ code: 0, out: '' });
    expect(s.moves).toEqual(['home', 'work']);
    expect(readPages(s.ctx)).toMatchObject([{ owner: 'home', title: 'Shape Lab' }]);
  }, 60_000);

  it('refuses the call, in the words Claude shows the model, when the session cannot be moved', async () => {
    const s = routedSession('no-login');
    const result = await runEntry('pre', s.env, PUBLISH);
    expect(result.code).toBe(0);
    const said = JSON.parse(result.out) as { hookSpecificOutput: Record<string, string> };
    expect(said.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(said.hookSpecificOutput.permissionDecisionReason).toContain('ccx login home');
    expect(s.moves).toEqual([]);
  }, 60_000);

  it('ignores an argument it does not know, and input that is not a call', async () => {
    const s = routedSession();
    expect(await runEntry('sideways', s.env, PUBLISH)).toEqual({ code: 0, out: '' });
    expect(await runEntry('pre', s.env, 'not a call')).toEqual({ code: 0, out: '' });
    expect(s.moves).toEqual([]);
    expect(existsSync(hopDir(s.sessionDir))).toBe(true);
  }, 60_000);
});
