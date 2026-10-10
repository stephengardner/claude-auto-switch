import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addAccount, updateAccount } from '../accounts/registry.js';
import { saveConfig } from '../config/config.js';
import type { PathCtx } from '../config/paths.js';
import { releaseLease, takeLease } from '../session/lease.js';
import { sessionLease } from '../session/session-lease.js';
import { createHopController, type HopDeps } from './hop.js';
import { hopDir, markDone, openHops, readState, sweepHops, writeState } from './hop-files.js';
import { afterArtifactCall, batchArtifactCalls, beforeArtifactCall, type HookEnv, type HookInput } from './hook.js';
import { appendPage, readPages, recordPath, type PageRow } from './record.js';
import { readResults, writePlan } from './scan.js';

const SESSION = 'e7a0c0de-0000-4000-8000-000000000001';
const URL = 'https://claude.ai/artifact/BmhXcGdEGscNbm7Pk1YSPc';
const FILE = path.resolve('pages', 'shape-lab.html');
const RESPONSE = {
  url: URL,
  path: FILE,
  artifact_id: '573916ad-1115-45ad-965e-2c91f5276edb',
  title: 'Shape Lab',
  updated: false,
};

interface Acct {
  name: string;
}

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length > 0) stops.pop()?.();
});

/**
 * A ccx home with three accounts and one running session on "work", and,
 * when asked, that session's ccx process answering requests for real.
 */
function setup(artifacts: { home?: string | null; updates?: 'off' | 'owner' } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-artifact-hook-'));
  const ctx: PathCtx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  for (const name of ['work', 'home', 'personal']) {
    addAccount({ name, dir: path.join(home, 'profiles', name) }, ctx);
  }
  if (Object.keys(artifacts).length > 0) saveConfig({ artifacts }, ctx);
  const sessionDir = path.join(home, 'sessions', '4242');
  mkdirSync(sessionDir, { recursive: true });
  takeLease('work', sessionDir, ctx);
  openHops(sessionDir, 4242);
  const env: HookEnv = { sessionDir, ctx, applyWaitMs: 400, returnWaitMs: 400, pollMs: 5 };

  const moves: string[] = [];
  /** Each time the session's ccx told Claude to use the login already in its folder. */
  const pins: string[] = [];
  /** The session's ccx: a real controller, moving the session by its announcement. */
  const wrapper = (over: Partial<HopDeps<Acct>> = {}) => {
    let on = 'work';
    const hop = createHopController<Acct>({
      dir: sessionDir,
      current: () => ({ name: on }),
      account: (name) => (['work', 'home', 'personal'].includes(name) ? { name } : null),
      readiness: () => 'ready',
      renew: () => Promise.resolve({ ok: true }),
      activate: (account) => {
        takeLease(account.name, sessionDir, ctx);
        releaseLease(on, ctx);
        on = account.name;
        moves.push(account.name);
      },
      pin: (account) => {
        pins.push(account.name);
      },
      standing: () => 'free',
      log: () => {},
      ...over,
    });
    const timer = setInterval(() => {
      hop.tick();
      hop.poll();
    }, 5);
    stops.push(() => clearInterval(timer));
    return hop;
  };
  const on = (): string | null => sessionLease(sessionDir, ctx)?.account ?? null;
  const call = (toolInput: Record<string, unknown>, id = 'toolu_01'): HookInput => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Artifact',
    tool_input: toolInput,
    tool_use_id: id,
    session_id: SESSION,
    cwd: path.resolve('.'),
    transcript_path: path.join(home, 'no-such-record.jsonl'),
  });
  const record = (over: Partial<PageRow> = {}): void =>
    appendPage(
      { url: URL, id: RESPONSE.artifact_id, title: 'Shape Lab', owner: 'personal', session: SESSION, file: FILE, at: 1, via: 'publish', ...over },
      ctx,
    );
  return { home, ctx, env, sessionDir, moves, pins, wrapper, on, call, record };
}

describe('before an Artifact call', () => {
  it('does nothing at all with both settings off: no answer, no file, no move', async () => {
    const s = setup();
    s.wrapper();
    s.record();
    const before = readdirSync(hopDir(s.sessionDir));
    for (const input of [{ file_path: FILE }, { file_path: FILE, url: URL }, { action: 'read', url: URL }]) {
      expect(await beforeArtifactCall(s.call(input), s.env)).toBeNull();
    }
    expect(s.moves).toEqual([]);
    expect(readdirSync(hopDir(s.sessionDir))).toEqual(before);
  });

  it('does nothing in a Claude that is not a ccx session, whatever is configured', async () => {
    const s = setup({ home: 'home', updates: 'owner' });
    s.wrapper();
    const elsewhere = { ...s.env, sessionDir: path.join(s.home, 'sessions', '9999') };
    expect(await beforeArtifactCall(s.call({ file_path: FILE }), elsewhere)).toBeNull();
    expect(s.moves).toEqual([]);
    expect(existsSync(hopDir(elsewhere.sessionDir))).toBe(false);
  });

  it('routes and records a call in a ccx session whose announcement has lapsed, through the ccx that answers for it', async () => {
    const s = setup({ home: 'work' });
    s.wrapper();
    releaseLease('work', s.ctx);
    expect(await beforeArtifactCall(s.call({ file_path: FILE }), s.env)).toBeNull();
    expect(s.pins).toEqual(['work']);
    await afterArtifactCall(
      { ...s.call({ file_path: FILE }), hook_event_name: 'PostToolUse', tool_response: RESPONSE, duration_ms: 100 },
      s.env,
      false,
    );
    expect(readPages(s.ctx)[0]?.owner).toBe('work');
  });

  it('does nothing for any other tool', async () => {
    const s = setup({ home: 'home' });
    s.wrapper();
    expect(await beforeArtifactCall({ ...s.call({ file_path: FILE }), tool_name: 'Write' }, s.env)).toBeNull();
    expect(s.moves).toEqual([]);
  });

  it('moves the session to the home account for a new page, and lets the call go', async () => {
    const s = setup({ home: 'home' });
    s.wrapper();
    expect(await beforeArtifactCall(s.call({ file_path: FILE }), s.env)).toBeNull();
    expect(s.moves).toEqual(['home']);
    expect(s.on()).toBe('home');
  });

  it('still asks when the session is on the home account already: no move, but a hold and a word to Claude', async () => {
    const s = setup({ home: 'work' });
    s.wrapper();
    expect(await beforeArtifactCall(s.call({ file_path: FILE }), s.env)).toBeNull();
    expect(s.moves).toEqual([]);
    expect(s.pins).toEqual(['work']);
    expect(readState(s.sessionDir, 'toolu_01')).toMatchObject({ state: 'applied', moved: false, to: 'work' });
  });

  it('asks again for a call on the account the session is visiting, rather than taking the visit as proof', async () => {
    const s = setup({ home: 'home' });
    s.wrapper();
    await beforeArtifactCall(s.call({ file_path: FILE }, 'toolu_01'), s.env);
    expect(s.on()).toBe('home');
    // The first call's after-hook has not come, so the visit could end at any moment.
    await beforeArtifactCall(s.call({ file_path: path.resolve('pages', 'other.html') }, 'toolu_02'), s.env);
    expect(readState(s.sessionDir, 'toolu_02')).toMatchObject({ state: 'applied', moved: true, to: 'home' });
    // The first call over: the session stays for the second.
    markDone(s.sessionDir, 'toolu_01');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(s.on()).toBe('home');
    expect(s.moves).toEqual(['home']);
  });

  it('moves it to the owner for an update that names its page', async () => {
    const s = setup({ updates: 'owner' });
    s.wrapper();
    s.record();
    expect(await beforeArtifactCall(s.call({ file_path: FILE, url: URL }), s.env)).toBeNull();
    expect(s.moves).toEqual(['personal']);
  });

  it('moves it to the owner for an update that names only the file this conversation published', async () => {
    const s = setup({ home: 'home', updates: 'owner' });
    s.wrapper();
    s.record();
    expect(await beforeArtifactCall(s.call({ file_path: FILE }), s.env)).toBeNull();
    expect(s.moves).toEqual(['personal']);
  });

  it('moves it to the owner to read a recorded page', async () => {
    const s = setup({ updates: 'owner' });
    s.wrapper();
    s.record();
    expect(await beforeArtifactCall(s.call({ action: 'read', url: URL }), s.env)).toBeNull();
    expect(s.moves).toEqual(['personal']);
  });

  it('holds the session where it is when it is on the account that owns the page', async () => {
    const s = setup({ updates: 'owner' });
    s.wrapper();
    s.record({ owner: 'work' });
    expect(await beforeArtifactCall(s.call({ file_path: FILE, url: URL }), s.env)).toBeNull();
    expect(s.moves).toEqual([]);
    expect(s.pins).toEqual(['work']);
  });

  it('lets an update to a page of unknown owner through unchanged, and says once how to record owners', async () => {
    const s = setup({ updates: 'owner' });
    s.wrapper();
    const first = await beforeArtifactCall(s.call({ file_path: FILE, url: URL }), s.env);
    expect(first && 'context' in first && first.context).toContain('ccx artifacts scan');
    expect(first && 'context' in first && first.context).toContain('"work"');
    expect(await beforeArtifactCall(s.call({ file_path: FILE, url: URL }, 'toolu_02'), s.env)).toBeNull();
    expect(s.moves).toEqual([]);
    // Once for the session, not once per sweep of old answers.
    sweepHops(s.sessionDir, Date.now() + 11 * 60_000, 10 * 60_000);
    expect(await beforeArtifactCall(s.call({ file_path: FILE, url: URL }, 'toolu_03'), s.env)).toBeNull();
  });

  it('leaves listing, opening, pinning and the rest alone', async () => {
    const s = setup({ home: 'home', updates: 'owner' });
    s.wrapper();
    s.record();
    for (const action of ['list', 'open', 'pin', 'quickstart', 'run_script', 'teleport']) {
      expect(await beforeArtifactCall(s.call({ action, url: URL }), s.env), action).toBeNull();
    }
    expect(s.moves).toEqual([]);
    expect(s.pins).toEqual([]);
  });

  it('sends an asset upload, in either spelling, to the page’s owner', async () => {
    const s = setup({ updates: 'owner' });
    s.wrapper();
    s.record();
    const logo = path.resolve('logo.png');
    await beforeArtifactCall(s.call({ action: 'upload_asset', url: URL, file_path: logo }, 'toolu_01'), s.env);
    await batchArtifactCalls({ tool_calls: [{ tool_name: 'Artifact', tool_use_id: 'toolu_01' }] }, s.env);
    await beforeArtifactCall(s.call({ url: URL, file_path: logo, asset: true }, 'toolu_02'), s.env);
    expect(s.moves).toEqual(['personal', 'work', 'personal']);
  });

  it('refuses the call when the home account is not an account, rather than publish where the session is', async () => {
    const s = setup({ home: 'nobody' });
    s.wrapper();
    const answer = await beforeArtifactCall(s.call({ file_path: FILE }), s.env);
    expect(answer && 'deny' in answer && answer.deny).toMatch(/^ccx: .*"nobody"/);
    expect(s.moves).toEqual([]);
  });

  it('refuses the call with the reason the session could not be moved', async () => {
    const s = setup({ home: 'home' });
    s.wrapper({ readiness: () => 'no-login' });
    const answer = await beforeArtifactCall(s.call({ file_path: FILE }), s.env);
    expect(answer && 'deny' in answer && answer.deny).toContain('ccx login home');
    expect(s.on()).toBe('work');
  });

  it('refuses the call when the session is not moved in time, and leaves word so a late move is undone', async () => {
    const s = setup({ home: 'home' });
    // Nothing answers.
    const answer = await beforeArtifactCall(s.call({ file_path: FILE }), { ...s.env, applyWaitMs: 60 });
    expect(answer && 'deny' in answer && answer.deny).toContain('"home"');
    expect(readdirSync(hopDir(s.sessionDir))).toContain('toolu_01.done');
    // The session's ccx gets to it afterwards: it must not move for a call nobody is making.
    s.wrapper();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(s.moves).toEqual([]);
    expect(s.on()).toBe('work');
  });

  it('refuses at once, without waiting, in a session whose ccx is from before this existed', async () => {
    const s = setup({ home: 'home' });
    rmSync(hopDir(s.sessionDir), { recursive: true, force: true });
    const started = Date.now();
    const answer = await beforeArtifactCall(s.call({ file_path: FILE }), { ...s.env, applyWaitMs: 5_000 });
    expect(answer && 'deny' in answer && answer.deny).toContain('start it again');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(existsSync(hopDir(s.sessionDir))).toBe(false);
  });

  it('refuses the call when the account list cannot be read in a session that was being routed', async () => {
    const s = setup({ home: 'home' });
    s.wrapper();
    writeFileSync(path.join(s.home, 'accounts.json'), '{ not json', 'utf8');
    const answer = await beforeArtifactCall(s.call({ file_path: FILE }), s.env);
    expect(answer && 'deny' in answer && answer.deny).toContain('ccx could not work out');
    expect(s.moves).toEqual([]);
  });

  it('refuses a page call when the config does not load, rather than let it go wherever the session is', async () => {
    const s = setup({ home: 'home' });
    s.wrapper();
    writeFileSync(path.join(s.home, 'config.json'), '{ "artifacts": ', 'utf8');
    const answer = await beforeArtifactCall(s.call({ file_path: FILE }), s.env);
    expect(answer && 'deny' in answer && answer.deny).toContain('config.json');
    expect(s.moves).toEqual([]);
    // A call no setting could ever route is not held up by it.
    expect(await beforeArtifactCall(s.call({ action: 'list' }, 'toolu_02'), s.env)).toBeNull();
  });
});

describe('after an Artifact call', () => {
  const after = (s: ReturnType<typeof setup>, toolInput: Record<string, unknown>, more: Partial<HookInput> = {}) =>
    afterArtifactCall(
      { ...s.call(toolInput), hook_event_name: 'PostToolUse', tool_response: RESPONSE, duration_ms: 1_200, ...more },
      s.env,
      false,
    );

  it('puts the session straight back, and records the page under the account it went out as', async () => {
    const s = setup({ home: 'home' });
    s.wrapper();
    await beforeArtifactCall(s.call({ file_path: FILE }), s.env);
    expect(s.on()).toBe('home');
    expect(await after(s, { file_path: FILE })).toBeNull();
    expect(s.moves).toEqual(['home', 'work']);
    expect(s.on()).toBe('work');
    expect(readPages(s.ctx)).toMatchObject([
      { url: URL, id: RESPONSE.artifact_id, title: 'Shape Lab', owner: 'home', session: SESSION, file: FILE, via: 'publish' },
    ]);
  });

  it('records a page that needed no move under the account the session is on', async () => {
    const s = setup({ home: 'work' });
    s.wrapper();
    await beforeArtifactCall(s.call({ file_path: FILE }), s.env);
    await after(s, { file_path: FILE });
    expect(readPages(s.ctx)[0]?.owner).toBe('work');
    expect(s.moves).toEqual([]);
  });

  it('records a new page with only updates routed, so a later update finds its owner', async () => {
    const s = setup({ updates: 'owner' });
    s.wrapper();
    await beforeArtifactCall(s.call({ file_path: FILE }), s.env);
    await after(s, { file_path: FILE });
    expect(readPages(s.ctx)[0]).toMatchObject({ owner: 'work', file: FILE });
  });

  it('takes a hold that kept the session where it was as no time away, unless something else moved it', async () => {
    const s = setup({ updates: 'owner' });
    const now = Date.now();
    const held = { state: 'ended', to: 'work', from: 'work', at: now - 1_000, endedAt: now - 500 } as const;
    writeState(s.sessionDir, { id: 'toolu_held', ...held, by: 'done' });
    await after(s, { file_path: FILE });
    expect(readPages(s.ctx)[0]?.owner).toBe('work');
    writeState(s.sessionDir, { id: 'toolu_held', ...held, by: 'moved' });
    await after(s, { file_path: path.resolve('pages', 'other.html') }, {
      tool_use_id: 'toolu_02',
      tool_response: { ...RESPONSE, url: 'https://claude.ai/artifact/other', artifact_id: 'other' },
    });
    expect(readPages(s.ctx)[1]?.owner).toBeNull();
  });

  it('records nothing with both settings off', async () => {
    const s = setup();
    s.wrapper();
    expect(await after(s, { file_path: FILE })).toBeNull();
    expect(existsSync(recordPath(s.ctx))).toBe(false);
  });

  it('records nothing in a Claude that is not a ccx session', async () => {
    const s = setup({ home: 'home' });
    const elsewhere = { ...s.env, sessionDir: path.join(s.home, 'sessions', '9999') };
    await afterArtifactCall({ ...s.call({ file_path: FILE }), tool_response: RESPONSE }, elsewhere, false);
    expect(existsSync(recordPath(s.ctx))).toBe(false);
  });

  it('records nothing for a read, and still puts the session back', async () => {
    const s = setup({ updates: 'owner' });
    s.wrapper();
    s.record();
    await beforeArtifactCall(s.call({ action: 'read', url: URL }), s.env);
    await after(s, { action: 'read', url: URL }, { tool_response: { url: URL, content: '<html>' } });
    expect(s.moves).toEqual(['personal', 'work']);
    expect(readPages(s.ctx)).toHaveLength(1);
    expect(readPages(s.ctx)[0]?.at).toBe(1);
  });

  it('says so when the move had ended before the call went out, and records where the page really is', async () => {
    const s = setup({ home: 'home' });
    // The move ran out of time a minute ago, while a question was on screen; the call took a second.
    const now = Date.now();
    writeState(s.sessionDir, {
      id: 'toolu_01',
      state: 'ended',
      to: 'home',
      from: 'work',
      at: now - 180_000,
      endedAt: now - 60_000,
      by: 'deadline',
    });
    const answer = await after(s, { file_path: FILE });
    expect(answer && 'context' in answer && answer.context).toContain('"work"');
    expect(answer && 'context' in answer && answer.context).toContain('"home"');
    expect(readPages(s.ctx)[0]?.owner).toBe('work');
  });

  it('records no owner when it cannot tell which account the call went out as', async () => {
    const s = setup({ home: 'home' });
    // The move ended while the call was still running.
    const now = Date.now();
    writeState(s.sessionDir, {
      id: 'toolu_01',
      state: 'ended',
      to: 'home',
      from: 'work',
      at: now - 5_000,
      endedAt: now - 500,
      by: 'deadline',
    });
    const answer = await after(s, { file_path: FILE }, { duration_ms: 3_000 });
    expect(readPages(s.ctx)[0]?.owner).toBeNull();
    expect(answer && 'context' in answer && answer.context).toContain('ccx artifacts scan');
  });

  it('records no owner for a page that went out while another call had the session away', async () => {
    const s = setup({ updates: 'owner' });
    writeState(s.sessionDir, { id: 'toolu_other', state: 'applied', to: 'personal', from: 'work', at: Date.now() - 300, moved: true });
    await after(s, { file_path: FILE });
    expect(readPages(s.ctx)[0]?.owner).toBeNull();
  });

  it('releases the move even when routing was turned off while the call ran', async () => {
    const s = setup({ home: 'home' });
    s.wrapper();
    await beforeArtifactCall(s.call({ file_path: FILE }), s.env);
    saveConfig({}, s.ctx);
    await after(s, { file_path: FILE });
    expect(s.moves).toEqual(['home', 'work']);
  });

  it('answers within its own bound when the session is not put back in time', async () => {
    const s = setup({ home: 'home' });
    writeState(s.sessionDir, { id: 'toolu_01', state: 'applied', to: 'home', from: 'work', at: Date.now(), moved: true });
    const started = Date.now();
    await afterArtifactCall(
      { ...s.call({ file_path: FILE }), tool_response: RESPONSE },
      { ...s.env, returnWaitMs: 80 },
      false,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readdirSync(hopDir(s.sessionDir))).toContain('toolu_01.done');
    // It was held when the call ended, so the page is the home account's.
    expect(readPages(s.ctx)[0]?.owner).toBe('home');
  });
});

describe('a session signed in as another account from inside (/login)', () => {
  /** The accounts have addresses, and the session's folder says it is signed in as `email`. */
  function signedInFromInside(s: ReturnType<typeof setup>, email: string): void {
    for (const name of ['work', 'home', 'personal']) updateAccount(name, { email: `${name}@example.com` }, s.ctx);
    writeFileSync(path.join(s.sessionDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }), 'utf8');
  }
  const published = (s: ReturnType<typeof setup>) =>
    afterArtifactCall(
      { ...s.call({ file_path: FILE }), hook_event_name: 'PostToolUse', tool_response: RESPONSE, duration_ms: 900 },
      s.env,
      false,
    );

  it('records a page nothing routed as the account it is really signed in as', async () => {
    // Only updates are routed, and this is a new page: it goes where the session is.
    const s = setup({ updates: 'owner' });
    signedInFromInside(s, 'personal@example.com');
    expect(await beforeArtifactCall(s.call({ file_path: FILE }), s.env)).toBeNull();
    await published(s);
    expect(readPages(s.ctx)[0]?.owner).toBe('personal');
  });

  it('asks the session’s ccx for every routed call, which is the one that can refuse it', async () => {
    const s = setup({ home: 'personal' });
    s.wrapper();
    signedInFromInside(s, 'personal@example.com');
    await beforeArtifactCall(s.call({ file_path: FILE }), s.env);
    expect(readState(s.sessionDir, 'toolu_01')).toMatchObject({ to: 'personal' });
  });

  it('records no owner when it is signed in as an account ccx does not know', async () => {
    const s = setup({ updates: 'owner' });
    signedInFromInside(s, 'somebody.else@example.com');
    await published(s);
    expect(readPages(s.ctx)[0]?.owner).toBeNull();
  });
});

describe('after an Artifact call that failed', () => {
  it('puts the session back and records nothing', async () => {
    const s = setup({ home: 'home' });
    s.wrapper();
    await beforeArtifactCall(s.call({ file_path: FILE }), s.env);
    const answer = await afterArtifactCall(
      { ...s.call({ file_path: FILE }), hook_event_name: 'PostToolUseFailure', error: 'not found' },
      s.env,
      true,
    );
    expect(s.moves).toEqual(['home', 'work']);
    expect(existsSync(recordPath(s.ctx))).toBe(false);
    // A publish of what looked like a new page: say which account it was sent as.
    expect(answer && 'context' in answer && answer.context).toContain('"home"');
    expect(readState(s.sessionDir, 'toolu_01')?.state).toBe('ended');
  });

  it('says nothing when the session was never moved for it', async () => {
    const s = setup({ home: 'work' });
    s.wrapper();
    expect(
      await afterArtifactCall({ ...s.call({ file_path: FILE }), error: 'not found' }, s.env, true),
    ).toBeNull();
  });
});

describe('a page that is deleted', () => {
  it('is recorded as deleted once the delete went through, so publishing its file again makes a new page', async () => {
    const s = setup({ home: 'home', updates: 'owner' });
    s.wrapper();
    s.record();
    await beforeArtifactCall(s.call({ action: 'delete', url: URL }), s.env);
    expect(s.moves).toEqual(['personal']);
    await afterArtifactCall({ ...s.call({ action: 'delete', url: URL }), tool_response: { deleted: true } }, s.env, false);
    expect(readPages(s.ctx)[0]?.deleted).toBe(true);
    await beforeArtifactCall(s.call({ file_path: FILE }, 'toolu_02'), s.env);
    expect(readState(s.sessionDir, 'toolu_02')).toMatchObject({ to: 'home' });
  });

  it('is not recorded as deleted when the delete failed', async () => {
    const s = setup({ updates: 'owner' });
    s.wrapper();
    s.record();
    await beforeArtifactCall(s.call({ action: 'delete', url: URL }), s.env);
    await afterArtifactCall({ ...s.call({ action: 'delete', url: URL }), error: 'not found' }, s.env, true);
    expect(readPages(s.ctx)[0]?.deleted).toBe(false);
  });
});

describe('after the batch of calls a Claude turn made', () => {
  const batch = (s: ReturnType<typeof setup>, calls: Array<{ tool_name: string; id: string }>) =>
    batchArtifactCalls(
      {
        hook_event_name: 'PostToolBatch',
        session_id: SESSION,
        tool_calls: calls.map((c) => ({ tool_name: c.tool_name, tool_input: { file_path: FILE }, tool_use_id: c.id })),
      },
      s.env,
    );

  it('puts the session back for a call no other hook said was over: one refused by the person’s own hook', async () => {
    const s = setup({ home: 'home' });
    s.wrapper();
    await beforeArtifactCall(s.call({ file_path: FILE }), s.env);
    expect(s.on()).toBe('home');
    await batch(s, [{ tool_name: 'Artifact', id: 'toolu_01' }]);
    // Back before Claude's next model request, which goes out the moment this returns.
    expect(s.on()).toBe('work');
    expect(readState(s.sessionDir, 'toolu_01')).toMatchObject({ state: 'ended', by: 'done' });
  });

  it('does nothing for a batch with no call held by ccx in it', async () => {
    const s = setup({ home: 'home' });
    s.wrapper();
    await batch(s, [{ tool_name: 'Bash', id: 'toolu_09' }, { tool_name: 'Artifact', id: 'toolu_10' }]);
    expect(s.moves).toEqual([]);
    expect(existsSync(path.join(hopDir(s.sessionDir), 'toolu_10.done'))).toBe(false);
  });
});

describe('in the one Claude ccx artifacts scan runs', () => {
  const LIST = { action: 'list', scope: 'mine', limit: 200 };
  const listed = (titles: string[]) => ({
    artifacts: titles.map((title) => ({ title, url: `https://claude.ai/artifact/${title.replace(/ /g, '')}`, updatedAt: '2026-10-01T00:00:00Z' })),
    total: titles.length,
    pins_enabled: true,
  });

  /** A scan of work, home and personal, in a session on "work", with neither page setting on. */
  function scanning() {
    const s = setup();
    const scanDir = path.join(s.home, 'artifact-scan-test');
    writePlan(scanDir, ['work', 'home', 'personal']);
    const env: HookEnv = { ...s.env, scanDir };
    const list = async (id: string, titles: string[] | null): Promise<string | null> => {
      const before = await beforeArtifactCall(s.call(LIST, id), env);
      if (before && 'deny' in before) return before.deny;
      const account = s.on();
      await afterArtifactCall(
        { ...s.call(LIST, id), hook_event_name: 'PostToolUse', tool_response: titles ? listed(titles) : 'not a list', duration_ms: 150 },
        env,
        false,
      );
      return account;
    };
    return { ...s, scanDir, env, list };
  }

  it('gives each list call the next account, has the session moved there, and records that account’s pages as its own', async () => {
    const s = scanning();
    s.wrapper();
    // Which account's login was in the folder as each call went out.
    expect(await s.list('toolu_a', ['Work page'])).toBe('work');
    expect(await s.list('toolu_b', ['Home one', 'Home two'])).toBe('home');
    expect(await s.list('toolu_c', [])).toBe('personal');
    expect(s.on()).toBe('work');
    expect(s.moves).toEqual(['home', 'work', 'personal', 'work']);
    expect(readPages(s.ctx).map((p) => [p.title, p.owner, p.via])).toEqual([
      ['Work page', 'work', 'scan'],
      ['Home one', 'home', 'scan'],
      ['Home two', 'home', 'scan'],
    ]);
    expect(readResults(s.scanDir).map((r) => r.result)).toEqual([
      { account: 'work', listed: 1, total: 1 },
      { account: 'home', listed: 2, total: 2 },
      { account: 'personal', listed: 0, total: 0 },
    ]);
  });

  it('refuses a call past the last account, and anything that is not a list', async () => {
    const s = scanning();
    s.wrapper();
    for (const id of ['toolu_a', 'toolu_b', 'toolu_c']) await s.list(id, []);
    expect(await s.list('toolu_d', [])).toContain('every account has been listed');
    const publish = await beforeArtifactCall(s.call({ file_path: FILE }, 'toolu_e'), s.env);
    expect(publish && 'deny' in publish && publish.deny).toContain('only lists pages');
    expect(readPages(s.ctx)).toEqual([]);
  });

  it('says why an account could not be listed, and goes on to the next', async () => {
    const s = scanning();
    s.wrapper({ readiness: (account) => (account.name === 'home' ? 'no-login' : 'ready') });
    await s.list('toolu_a', ['Work page']);
    const refused = await s.list('toolu_b', ['never seen']);
    expect(refused).toContain('ccx login home');
    expect(refused).toContain('Go on to the next call');
    expect(await s.list('toolu_c', ['Personal page'])).toBe('personal');
    const results = readResults(s.scanDir).map((r) => r.result);
    expect(results[1]).toMatchObject({ account: 'home' });
    expect(results[1] && 'error' in results[1] && results[1].error).toContain('not signed in');
    expect(readPages(s.ctx).map((p) => p.owner)).toEqual(['work', 'personal']);
  });

  it('records nothing for an answer that is not a list of pages, or when it cannot tell who answered', async () => {
    const s = scanning();
    s.wrapper({ holdMs: 30 });
    await s.list('toolu_a', null);
    writePlan(s.scanDir, ['work', 'work']);
    await beforeArtifactCall(s.call(LIST, 'toolu_z'), s.env);
    // Its hold ran out before it was over, and the session was away for another call meanwhile.
    for (let i = 0; i < 100 && readState(s.sessionDir, 'toolu_z')?.state !== 'ended'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(readState(s.sessionDir, 'toolu_z')).toMatchObject({ state: 'ended', by: 'deadline' });
    writeState(s.sessionDir, { id: 'toolu_other', state: 'ended', to: 'personal', from: 'work', at: Date.now() - 50, endedAt: Date.now(), by: 'done' });
    await afterArtifactCall(
      { ...s.call(LIST, 'toolu_z'), hook_event_name: 'PostToolUse', tool_response: listed(['Whose page']), duration_ms: 150 },
      s.env,
      false,
    );
    expect(readPages(s.ctx)).toEqual([]);
    const results = readResults(s.scanDir).map((r) => r.result);
    expect(results[0] && 'error' in results[0] && results[0].error).toContain('not a list');
    expect(results[1] && 'error' in results[1] && results[1].error).toContain('could not tell');
  });

  it('gives a hook run twice for one call the same turn, and records its pages once', async () => {
    const s = scanning();
    s.wrapper();
    await beforeArtifactCall(s.call(LIST, 'toolu_a'), s.env);
    await beforeArtifactCall(s.call(LIST, 'toolu_a'), s.env);
    const done = { ...s.call(LIST, 'toolu_a'), tool_response: listed(['Work page']), duration_ms: 100 };
    await afterArtifactCall(done, s.env, false);
    await afterArtifactCall(done, s.env, false);
    expect(readPages(s.ctx)).toHaveLength(1);
    // The next call still gets the second account, not the third.
    expect(await s.list('toolu_b', [])).toBe('home');
  });

  it('adds nothing for a page already recorded as that account’s, so scanning again does not grow the record', async () => {
    const s = scanning();
    s.wrapper();
    await s.list('toolu_a', ['Work page', 'Second page']);
    const lines = (): number => readFileSync(recordPath(s.ctx), 'utf8').trim().split('\n').length;
    expect(lines()).toBe(2);
    writePlan(s.scanDir, ['work']);
    rmSync(path.join(s.scanDir, 'turn-0'));
    await s.list('toolu_again', ['Work page', 'Second page']);
    expect(lines()).toBe(2);
  });
});
