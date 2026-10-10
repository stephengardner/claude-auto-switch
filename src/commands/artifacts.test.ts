import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addAccount } from '../accounts/registry.js';
import { installArtifactHooks, readArtifactHooksInstalled } from '../artifacts/hooks.js';
import { appendPage, readPages, recordDeletion } from '../artifacts/record.js';
import { SCAN_ENV, readPlan, writeResult } from '../artifacts/scan.js';
import { loadConfig, saveConfig } from '../config/config.js';
import type { PartialConfig } from '../config/config.schema.js';
import type { CliContext } from '../context.js';
import { artifactsCommand, artifactsScanCommand, scanBrief } from './artifacts.js';
import { auditArtifactHooks } from './doctor.js';
import { offCommand, onCommand } from './onoff.js';

const PROGRAM = { node: process.execPath, entry: path.join(tmpdir(), 'ccx', 'dist', 'artifacts', 'hook-entry.js') };

function setup(artifacts?: PartialConfig['artifacts'], json = false) {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-artifacts-cmd-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: path.join(home, 'ccx'), HOME: home, USERPROFILE: home } };
  if (artifacts) saveConfig({ artifacts }, ctx);
  const said: string[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: 'claude', prefixArgs: [] },
    out: (m: string) => said.push(m),
    err: () => {},
    json,
    quiet: false,
  };
  /** Signed in or not: a login file with something in it, or none. */
  const account = (name: string, signedIn = true): void => {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    if (signedIn) writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
    addAccount({ name, dir }, ctx);
  };
  return { home, ctx, context, said, account, claudeSettings: path.join(home, '.claude', 'settings.json') };
}

const page = (key: string, over: Record<string, unknown> = {}) => ({
  url: `https://claude.ai/artifact/${key}`,
  id: null,
  title: `Page ${key}`,
  owner: 'work' as string | null,
  session: 's1',
  file: null,
  at: 1_000_000,
  via: 'publish' as const,
  ...over,
});

describe('ccx artifacts', () => {
  it('says there is nothing yet, how pages get recorded, and what the two settings are', () => {
    const { context, said } = setup();
    expect(artifactsCommand(context)).toBe(0);
    expect(said[0]).toBe('no pages recorded yet');
    expect(said.join('\n')).toContain('ccx artifacts scan');
    expect(said.join('\n')).toContain('new pages are published as: the account the session is on');
    expect(said.join('\n')).toContain('ccx config artifacts.updates owner');
  });

  it('lists each page with the account that owns it, the newest first', () => {
    const { context, ctx, said } = setup({ home: 'work', updates: 'owner' });
    appendPage(page('older'), ctx);
    appendPage(page('newer', { owner: 'personal', at: 1_000_000 + 3 * 3_600_000 }), ctx);
    expect(artifactsCommand(context, 1_000_000 + 4 * 3_600_000)).toBe(0);
    expect(said[0]).toMatch(/^ACCOUNT\s+PAGE\s+LAST SEEN\s+LINK$/);
    expect(said[1]).toMatch(/^personal\s+Page newer\s+1h ago\s+https:\/\/claude\.ai\/artifact\/newer$/);
    expect(said[2]).toMatch(/^work\s+Page older\s+4h ago\s+https:\/\/claude\.ai\/artifact\/older$/);
    expect(said.join('\n')).toContain('new pages are published as: work');
    expect(said.join('\n')).toContain('a page is changed as: the account that owns it');
  });

  it('leaves out a page deleted through a ccx session', () => {
    const { context, ctx, said } = setup({ home: 'work' });
    appendPage(page('kept'), ctx);
    appendPage(page('gone'), ctx);
    recordDeletion('https://claude.ai/artifact/gone', ctx, 1_000_001);
    artifactsCommand(context);
    expect(said.join('\n')).toContain('Page kept');
    expect(said.join('\n')).not.toContain('gone');
  });

  it('marks a page whose account it could not tell, and says how to find out', () => {
    const { context, ctx, said } = setup();
    appendPage(page('mystery', { owner: null, title: null }), ctx);
    artifactsCommand(context);
    expect(said[1]).toMatch(/^\?\s+\(untitled\)/);
    expect(said.join('\n')).toContain('ccx artifacts scan finds out');
  });

  it('never lets a title move the cursor', () => {
    const { context, ctx, said } = setup();
    appendPage(page('escape', { title: 'Bad\u001b[2Jtitle\u0007' }), ctx);
    artifactsCommand(context);
    expect(said.join('\n')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(said[1]).toContain('Bad[2Jtitle');
  });

  it('gives the same as data with --json', () => {
    const { context, ctx, said } = setup({ home: 'work' }, true);
    appendPage(page('one', { file: '/pages/one.html' }), ctx);
    expect(artifactsCommand(context)).toBe(0);
    expect(JSON.parse(said.join('\n'))).toMatchObject({
      settings: { home: 'work', updates: 'off' },
      pages: [{ url: 'https://claude.ai/artifact/one', title: 'Page one', owner: 'work', file: '/pages/one.html' }],
    });
  });
});

describe('ccx artifacts scan', () => {
  it('tells one headless Claude to list once per signed-in account, with the hooks and the scan named to it alone', async () => {
    const s = setup();
    s.account('work');
    s.account('personal');
    s.account('idle', false);
    const runs: Array<{ args: string[]; env: Record<string, string>; plan: string[]; brief: string; hooks: string[] }> = [];
    const code = await artifactsScanCommand(s.context, {}, {
      program: PROGRAM,
      runWorker: (args, env) => {
        const dir = env[SCAN_ENV] as string;
        const settings = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1] as string, 'utf8')) as {
          hooks: Record<string, unknown>;
        };
        runs.push({
          args,
          env,
          plan: readPlan(dir),
          brief: readFileSync(args[args.indexOf('--brief-file') + 1] as string, 'utf8'),
          hooks: Object.keys(settings.hooks).sort(),
        });
        // What the hook writes as the calls are made.
        writeResult(dir, 0, { account: 'work', listed: 12, total: 12 });
        writeResult(dir, 1, { account: 'personal', listed: 200, total: 431 });
        return Promise.resolve({ code: 0, said: '' });
      },
    });
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.plan).toEqual(['work', 'personal']);
    expect(run.args.slice(0, 1)).toEqual(['worker']);
    expect(run.args.slice(run.args.indexOf('--') + 1)).toEqual([
      '--settings',
      run.args[run.args.indexOf('--settings') + 1],
      '--allowedTools',
      'Artifact',
    ]);
    expect(run.env).toMatchObject({ CLAUDE_CODE_ARTIFACT: '1', CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '0' });
    expect(run.hooks).toEqual(['PostToolBatch', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse']);
    expect(run.brief).toContain('exactly 2 calls');
    expect(run.brief).toContain('{"action": "list", "scope": "mine", "limit": 200}');
    const said = s.said.join('\n');
    expect(said).toMatch(/work\s+12 pages/);
    expect(said).toMatch(/personal\s+200 pages of 431/);
    expect(said).toMatch(/idle\s+not listed: not signed in \(ccx login idle\)/);
    // One account was not listed, so it does not report success.
    expect(code).toBe(1);
    // Nothing of the scan is left behind, and the person's own settings were never touched.
    expect(readdirSync(path.join(s.home, 'ccx')).filter((name) => name.startsWith('artifact-scan'))).toEqual([]);
    expect(existsSync(s.claudeSettings)).toBe(false);
  });

  it('succeeds when every account was listed', async () => {
    const s = setup();
    s.account('work');
    const code = await artifactsScanCommand(s.context, {}, {
      program: PROGRAM,
      runWorker: (_args, env) => {
        writeResult(env[SCAN_ENV] as string, 0, { account: 'work', listed: 1, total: 1 });
        return Promise.resolve({ code: 0, said: '' });
      },
    });
    expect(code).toBe(0);
    expect(s.said.join('\n')).toMatch(/work\s+1 page$/m);
  });

  it('says which accounts were never reached and why the Claude ended, and that it is best effort', async () => {
    const s = setup();
    s.account('work');
    s.account('personal');
    const code = await artifactsScanCommand(s.context, {}, {
      program: PROGRAM,
      runWorker: (_args, env) => {
        writeResult(env[SCAN_ENV] as string, 0, { account: 'work', error: 'the list call failed' });
        return Promise.resolve({ code: 1, said: 'ccx worker: no account could run it\n' });
      },
    });
    expect(code).toBe(1);
    const said = s.said.join('\n');
    expect(said).toMatch(/work\s+not listed: the list call failed/);
    expect(said).toMatch(/personal\s+not listed: the scan ended before reaching it/);
    expect(said).toContain('no account could run it');
    expect(said).toContain('best effort');
  });

  it('can be kept to named accounts, and refuses a name that is not one', async () => {
    const s = setup();
    s.account('work');
    s.account('personal');
    let plan: string[] = [];
    await artifactsScanCommand(s.context, { account: ['personal'] }, {
      program: PROGRAM,
      runWorker: (_args, env) => {
        plan = readPlan(env[SCAN_ENV] as string);
        return Promise.resolve({ code: 0, said: '' });
      },
    });
    expect(plan).toEqual(['personal']);
    let ran = false;
    const code = await artifactsScanCommand(s.context, { account: ['nobody'] }, {
      runWorker: () => {
        ran = true;
        return Promise.resolve({ code: 0, said: '' });
      },
    });
    expect(code).toBe(1);
    expect(ran).toBe(false);
    expect(s.said.at(-1)).toContain('no account called "nobody"');
  });

  it('starts nothing when no account is signed in', async () => {
    const s = setup();
    s.account('idle', false);
    let ran = false;
    const code = await artifactsScanCommand(s.context, {}, {
      runWorker: () => {
        ran = true;
        return Promise.resolve({ code: 0, said: '' });
      },
    });
    expect(code).toBe(1);
    expect(ran).toBe(false);
  });

  it('words the brief for one account as for several', () => {
    expect(scanBrief(1)).toContain('exactly 1 call of');
    expect(scanBrief(3)).toContain('exactly 3 calls of');
    expect(scanBrief(3)).toContain('reply with only: done');
  });
});

describe('ccx on and ccx off', () => {
  const shell = (home: string) => ({
    profile: path.join(home, 'profile.sh'),
    shell: 'posix',
    editor: false,
    statusline: false,
  });

  it('ccx on installs nothing for pages while both settings are off', () => {
    const s = setup();
    onCommand(s.context, shell(s.home));
    expect(readArtifactHooksInstalled(s.ctx)).toBe(false);
    expect(s.said.join('\n')).not.toContain('page routing');
  });

  it('ccx on puts the hooks back as the settings say, pointed at this ccx, and ccx off takes them out', () => {
    const s = setup({ updates: 'owner' });
    installArtifactHooks(true, s.ctx, { node: 'old-node', entry: '/old/artifacts/hook-entry.js' });
    onCommand(s.context, shell(s.home));
    expect(s.said).toContain('claude: page routing hooks set up');
    expect(readFileSync(s.claudeSettings, 'utf8')).not.toContain('old-node');
    expect(readArtifactHooksInstalled(s.ctx)).toBe(true);

    offCommand(s.context, shell(s.home));
    expect(s.said).toContain('claude: page routing hooks removed (ccx on puts them back)');
    expect(readArtifactHooksInstalled(s.ctx)).toBe(false);
    expect(JSON.parse(readFileSync(s.claudeSettings, 'utf8'))).not.toHaveProperty('hooks');
    // The choice is kept, so ccx on brings them back.
    expect(loadConfig(s.ctx).artifacts.updates).toBe('owner');
    onCommand(s.context, shell(s.home));
    expect(readArtifactHooksInstalled(s.ctx)).toBe(true);
  });

  it('ccx on removes hooks left behind after routing was turned off by hand', () => {
    const s = setup();
    installArtifactHooks(true, s.ctx, PROGRAM);
    onCommand(s.context, shell(s.home));
    expect(readArtifactHooksInstalled(s.ctx)).toBe(false);
    expect(s.said).toContain('claude: page routing is off, so its hooks are removed');
  });

  it('ccx off says nothing about pages when there was nothing to remove', () => {
    const s = setup();
    offCommand(s.context, shell(s.home));
    expect(s.said.join('\n')).not.toContain('page routing');
  });
});

describe('ccx doctor on page routing', () => {
  it('has nothing to say while it is off and nothing is installed', () => {
    expect(auditArtifactHooks(setup().context)).toBeNull();
  });

  it('is content when it is on, its hooks are in place and can run, and the home account exists', () => {
    const s = setup({ home: 'work', updates: 'owner' });
    s.account('work');
    mkdirSync(path.dirname(PROGRAM.entry), { recursive: true });
    writeFileSync(PROGRAM.entry, '', 'utf8');
    installArtifactHooks(true, s.ctx, PROGRAM);
    expect(auditArtifactHooks(s.context)).toEqual({
      name: 'page-routing',
      ok: true,
      detail: 'new pages are published as "work"; a page is changed as the account that owns it',
    });
  });

  it('says so when it is on with no hooks, when the hooks cannot run, and when the home account is gone', () => {
    const s = setup({ home: 'work' });
    s.account('work');
    // Setting it again puts the hooks back, pointed at this ccx, and touches nothing else.
    expect(auditArtifactHooks(s.context)).toMatchObject({ ok: false, fix: ['ccx config artifacts.home work'] });
    installArtifactHooks(true, s.ctx, { node: process.execPath, entry: path.join(s.home, 'gone', 'artifacts', 'hook-entry.js') });
    expect(auditArtifactHooks(s.context)?.detail).toContain('cannot run');
    expect(auditArtifactHooks(s.context)?.fix).toEqual(['ccx config artifacts.home work']);
    expect(auditArtifactHooks(setup({ updates: 'owner' }).context)?.fix).toEqual(['ccx config artifacts.updates owner']);
    // A home that is no account cannot be set again, so the fix is another line.
    expect(auditArtifactHooks(setup({ home: 'gone' }).context)?.fix).toEqual(['ccx config artifacts.home <account>']);
    const goneWithUpdates = setup({ home: 'gone', updates: 'owner' });
    expect(auditArtifactHooks(goneWithUpdates.context)?.fix).toEqual(['ccx config artifacts.updates owner']);
    mkdirSync(path.dirname(PROGRAM.entry), { recursive: true });
    writeFileSync(PROGRAM.entry, '', 'utf8');
    const gone = setup({ home: 'gone' });
    installArtifactHooks(true, gone.ctx, PROGRAM);
    expect(auditArtifactHooks(gone.context)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('"gone", which is not an account'),
      fix: ['ccx config artifacts.home <account>'],
    });
  });

  it('says the settings file does not parse, rather than prescribing a ccx on that refuses it', () => {
    const s = setup({ home: 'work' });
    s.account('work');
    mkdirSync(path.dirname(s.claudeSettings), { recursive: true });
    writeFileSync(s.claudeSettings, '{ "hooks": ', 'utf8');
    const check = auditArtifactHooks(s.context);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('not valid JSON');
    expect(check?.fix ?? []).not.toContain('ccx on');
    // Nothing to report when routing is off: no page routing is waiting on that file.
    expect(auditArtifactHooks(setup().context)).toBeNull();
  });

  it('reports a home folder it cannot find as one failed check, not a doctor that fails whole', () => {
    const s = setup({ updates: 'owner' });
    const homeless: typeof s.context = { ...s.context, ctx: { env: { CLAUDE_AUTO_SWITCH_HOME: path.join(s.home, 'ccx') } } };
    expect(() => auditArtifactHooks(homeless)).not.toThrow();
    expect(auditArtifactHooks(homeless)).toMatchObject({ name: 'page-routing', ok: false });
  });

  it('says so when hooks are still installed with routing off', () => {
    const s = setup();
    installArtifactHooks(true, s.ctx, PROGRAM);
    // Not ccx on, which would also put back what ccx off took out.
    expect(auditArtifactHooks(s.context)).toMatchObject({ ok: false, fix: ['ccx config artifacts.updates off'] });
    expect(readPages(s.ctx)).toEqual([]);
  });
});
