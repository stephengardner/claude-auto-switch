import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { loadConfig } from '../../src/config/config.js';
import { getActive, setActive } from '../../src/state/active.js';
import { markCapped, updateLedger } from '../../src/ledger/ledger.js';
import { moveEditorToActive, retireEditor, setUpEditor } from '../../src/editor/folder.js';
import { acquireOwnedLock } from '../../src/claude/locks.js';
import { processIsAlive } from '../../src/session/lease.js';
import { noteEditorChat } from '../../src/editor/editor-chats.js';
import type { CliContext } from '../../src/context.js';
import type { PathCtx } from '../../src/config/paths.js';
import type { LimitProbeResult } from '../../src/usage/limit-probe.js';

/**
 * An editor chat whose account runs out while ccx's usage check is turned
 * away (a 429). The wrapper the editor's extension starts (ccx-claude) runs in
 * a process of its own, through tsx, exactly as the extension runs it: its
 * standard input and output are the chat's, passed to Claude untouched, and
 * the fake claude stands in for the extension's Claude, taking turns as
 * stream-json on standard input and staying up across them. Conductor starts
 * ccx-claude the other way, with Claude's own arguments and no command before
 * them; the same chats are run that way too.
 */

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX = path.join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));

/** What the extension (2.1.302) starts every chat's Claude with, before anything about the chat itself. */
const EXTENSION_ARGS = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];
/** The conversation a new chat lands in, one a resumed chat names, and the one a /clear moves to. */
const NEW_CHAT = '12121212-3434-4565-8787-909090909090';
const RESUMED = '34343434-5656-4787-8989-010101010101';
const CLEARED = '56565656-7878-4909-8a1a-121212121212';

const TURNED_AWAY: LimitProbeResult = { verdict: 'unknown', detail: 'status 429' };
const ROOM: LimitProbeResult = { verdict: 'allowed', fiveHour: 0.1, sevenDay: 0.1 };
/** An answer of the usage endpoint; with `waitFor`, given only once that file appears in the home folder. */
type Answer = LimitProbeResult & { waitFor?: string };
/** The usage check answering that the whole account is out, until `resetAt`. */
const OUT = (resetAt: number): LimitProbeResult => ({ verdict: 'limited', fiveHour: 1, sevenDay: 0.4, fiveHourReset: resetAt });
/** The usage check answering that only Opus is out, until `resetAt`. */
const OPUS_OUT = (resetAt: number): LimitProbeResult => ({
  verdict: 'limited',
  fiveHour: 0.2,
  sevenDay: 0.3,
  models: [{ name: 'Opus', utilization: 1, resetsAt: resetAt }],
});

/**
 * The fake claude as the extension's: it keeps the records Claude keeps, takes
 * its turns over stream-json, refuses every turn on A's login, and stays up
 * until its input ends (the stay here is a backstop).
 */
const EDITOR_CLAUDE: Record<string, string> = {
  FAKE_CLAUDE_SESSION_RECORD: '1',
  FAKE_CLAUDE_TRANSCRIPT: '1',
  FAKE_CLAUDE_STATUS: 'idle',
  FAKE_CLAUDE_LANDS_ON: NEW_CHAT,
  FAKE_CLAUDE_REFUSE_ON: 'A',
  FAKE_CLAUDE_TURN_MS: '200',
  FAKE_CLAUDE_IDLE_MS: '45000',
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Whether `ok` comes true within `ms`; the test then says what it found either way. */
async function until(ok: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await sleep(50);
  }
  return ok();
}

interface LoggedEvent {
  msg: string;
  kind?: string;
  /** How many times in a row the log folded this message into the one line. */
  count?: number;
}
interface Cap {
  account: string;
  capUntil: number | null;
  model?: string;
}
const linesOf = (file: string): string[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '')
    : [];
const eventsIn = (home: string): LoggedEvent[] =>
  linesOf(path.join(home, 'events.jsonl')).map((l) => JSON.parse(l) as LoggedEvent);
const verdicts = (home: string): string[] =>
  eventsIn(home)
    .filter((e) => e.kind === 'cap-verify')
    .map((e) => e.msg);
const said = (home: string, msg: string): number => eventsIn(home).filter((e) => e.msg === msg).length;
/** How many times ccx said what `matches`, counting a message the log folded into one line for each time. */
const timesSaid = (home: string, matches: RegExp): number =>
  eventsIn(home)
    .filter((e) => matches.test(e.msg))
    .reduce((times, e) => times + (e.count ?? 1), 0);
/** What ccx says when the editor has not been moved off the account yet: it moves at ccx's next event. */
const NOT_MOVED_TO_B =
  /^the editor has not moved to B yet: on A for now: .* ccx moves it at its next event$/;
/** The `n`th verdict ccx gives on a refused turn, once it has given that many. */
async function verdictNumber(home: string, n: number): Promise<string> {
  await until(() => verdicts(home).length >= n);
  return verdicts(home)[n - 1] ?? `no verdict ${n}: ${JSON.stringify(verdicts(home))}`;
}
const capsIn = (home: string): Cap[] => {
  const file = path.join(home, 'ledger.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { caps: Cap[] }).caps : [];
};
/**
 * The limits recorded for `account` as they stand once their reset has
 * passed. The ledger is what tells ccx whether meeting a limit again is news,
 * so a test reaches "after the reset" here rather than by waiting for it.
 */
const resetOnLedger = (ctx: PathCtx, account: string): void => {
  updateLedger(ctx, (ledger) => ({
    caps: ledger.caps.map((cap) =>
      cap.account === account ? { ...cap, capUntil: Date.now() - 1_000 } : cap,
    ),
  }));
};
/** Whose login the usage check was asked with, in order. */
const asked = (home: string): string[] => linesOf(path.join(home, 'asked.txt'));
/** Each question put to the usage endpoint: whose login, the file it was asked with, and that file's access token. */
const askedDetail = (
  home: string,
): Array<{ account: string; file: string; token: string | null }> =>
  linesOf(path.join(home, 'asked.jsonl')).map(
    (l) => JSON.parse(l) as { account: string; file: string; token: string | null },
  );
/** Which account the editor's folder holds, and since when, by ccx's record in it. */
const editorRecord = (home: string): { account: string | null; loginChangedAt: number } | null => {
  try {
    return JSON.parse(
      readFileSync(path.join(home, 'editor-active', '.ccx-editor.json'), 'utf8'),
    ) as {
      account: string | null;
      loginChangedAt: number;
    };
  } catch {
    return null;
  }
};
/** Claude's own lock on its login in the editor's folder, taken as it is while Claude renews a login: a move of the editor waits for it. */
const claudeHoldsItsLogin = (home: string): void =>
  mkdirSync(path.join(home, 'editor-active', '.oauth_refresh.lock'));
const claudeLetsGo = (home: string): void =>
  rmSync(path.join(home, 'editor-active', '.oauth_refresh.lock'), { recursive: true, force: true });
/** Let the usage endpoint give an answer that waits for `name` (see launchScript). */
const release = (home: string, name = 'release'): void => writeFileSync(path.join(home, name), '', 'utf8');
/** Claude's own record of another process of its on `conversation`, in the shared folder: this test's own process stands in for it. */
function otherClaudeOn(home: string, conversation: string): void {
  mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  writeFileSync(
    path.join(home, '.claude', 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: conversation, kind: 'interactive' }),
    'utf8',
  );
}
/** A conversation's record, in your own projects folder, which the editor's folder links. */
const recordOf = (home: string, conversation: string): string =>
  path.join(home, '.claude', 'projects', 'fake-project', `${conversation}.jsonl`);

const HOURS = 3_600_000;
/** A login of `name`'s, generation `gen`: a renewal is the next generation, with a later expiry. The fake claude reads whose it is from `account`. */
const loginOf = (name: string, gen: number): string =>
  JSON.stringify({
    account: name,
    claudeAiOauth: {
      accessToken: `a-${name}-${gen}`,
      refreshToken: `r-${name}-${gen}`,
      expiresAt: Date.now() + (8 + gen) * HOURS,
    },
  });

/**
 * Accounts A and B, both signed in, the editor on A, and the usage endpoint
 * answering as given. With `realLogins`, each has a login with tokens, an
 * email and an identity, as ccx needs to take a renewal home.
 */
async function twoAccounts(
  prefix: string,
  usage: Record<string, Answer[]>,
  options: { realLogins?: boolean } = {},
): Promise<{ home: string; ctx: PathCtx; context: CliContext }> {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
  for (const name of ['A', 'B']) {
    const dir = path.join(home, 'profiles', name);
    const email = `${name.toLowerCase()}@example.com`;
    await addCommand(context, name, {
      dir,
      login: false,
      ...(options.realLogins ? { email } : {}),
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.credentials.json'),
      options.realLogins ? loginOf(name, 1) : JSON.stringify({ account: name }),
      'utf8',
    );
    if (options.realLogins) {
      writeFileSync(
        path.join(dir, '.claude.json'),
        JSON.stringify({
          oauthAccount: { emailAddress: email, accountUuid: `uuid-${name}` },
          userID: `user-${name}`,
        }),
        'utf8',
      );
    }
    writeFileSync(
      path.join(dir, 'fake-scenario.json'),
      JSON.stringify({ authStatus: { loggedIn: true, subscriptionType: 'max', email: `${name}@example.com` } }),
      'utf8',
    );
  }
  setActive('A', ctx);
  writeFileSync(path.join(home, 'usage.json'), JSON.stringify(usage), 'utf8');
  return { home, ctx, context };
}

/** How ccx-claude is started: as the editor's extension does (`<claude> ...args`), or as Conductor does (`...claude args`). */
type Mode = 'wrapper' | 'direct';

/**
 * ccx-claude as it is started, in a process of its own: ccx's wrapperLaunch
 * on `<claude> ...args` (the extension), or editorLaunch on `...args`
 * (Conductor), with the usage endpoint answering from
 * `usage.json` (each account's answers in turn, the last one standing; one
 * with `waitFor` answers once that file appears in the home folder) and the
 * fake claude, which runs as `node`, counted as a Claude. Each question put to
 * the usage endpoint is logged in `asked.txt` (whose login it was) and
 * `asked.jsonl` (the file and token as well). It reads Claude's
 * records every 100 ms, or every EDITOR_FOLLOW_MS, and holds refused turns
 * back for 20 s after a check that confirms nothing, as production does, or
 * for EDITOR_REFUTE_BACKOFF_MS. A move of the editor's login waits for Claude's
 * locks for EDITOR_MOVE_RETRY_MS, as production does for 10 s.
 */
function launchScript(home: string, mode: Mode): string {
  const script = path.join(home, `editor-${mode}.mts`);
  const source = (...parts: string[]): string => JSON.stringify(pathToFileURL(path.join(REPO, ...parts)).href);
  writeFileSync(
    script,
    [
      `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';`,
      `import { EOL } from 'node:os';`,
      `import path from 'node:path';`,
      `import { editorLaunch, wrapperLaunch } from ${source('src', 'commands', 'editor-launch.ts')};`,
      `import { loadConfig } from ${source('src', 'config', 'config.ts')};`,
      `import { processIsAlive } from ${source('src', 'session', 'lease.ts')};`,
      `const [home, fake, ...claudeArgs] = process.argv.slice(2);`,
      `const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };`,
      `const answers = JSON.parse(readFileSync(path.join(home, 'usage.json'), 'utf8'));`,
      `const probe = async (credentialsFile) => {`,
      `  const login = JSON.parse(readFileSync(credentialsFile, 'utf8'));`,
      `  const account = login.account ?? '?';`,
      `  appendFileSync(path.join(home, 'asked.txt'), account + EOL);`,
      `  const token = login.claudeAiOauth?.accessToken ?? null;`,
      `  appendFileSync(path.join(home, 'asked.jsonl'), JSON.stringify({ account, file: credentialsFile, token }) + EOL);`,
      `  const queue = answers[account] ?? [];`,
      `  const answer = (queue.length > 1 ? queue.shift() : queue[0]) ?? { verdict: 'allowed', fiveHour: 0.1, sevenDay: 0.1 };`,
      `  const until = Date.now() + 30000;`,
      `  while (answer.waitFor && !existsSync(path.join(home, answer.waitFor)) && Date.now() < until) {`,
      `    await new Promise((resolve) => setTimeout(resolve, 25));`,
      `  }`,
      `  return answer;`,
      `};`,
      // Whose a login is, as the API would say: by the account its token was made for.
      `const lookupOwner = async (dir) => {`,
      `  try {`,
      `    const token = JSON.parse(readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken ?? '';`,
      `    const named = /^a-([A-Za-z]+)-/.exec(token);`,
      `    return named ? named[1].toLowerCase() + '@example.com' : null;`,
      `  } catch {`,
      `    return null;`,
      `  }`,
      `};`,
      `const context = { ctx, config: loadConfig(ctx), claude: { bin: process.execPath, prefixArgs: [fake] },`,
      `  capProbe: probe, lookupOwner, isClaudeProcess: processIsAlive, editorFollowMs: Number(process.env.EDITOR_FOLLOW_MS) || 100,`,
      `  refuteBackoffMs: Number(process.env.EDITOR_REFUTE_BACKOFF_MS) || undefined,`,
      `  editorMoveRetryMs: Number(process.env.EDITOR_MOVE_RETRY_MS) || undefined,`,
      // A newer ccx installed while the chat runs, as update/newer-install finds one.
      `  newerInstall: () => (process.env.NEWER_CCX_CLI ? { version: '9.9.9', cli: process.env.NEWER_CCX_CLI } : null),`,
      `  out: () => {}, err: () => {}, json: false, quiet: false };`,
      // When the launch is called, so a test can tell how long it took to start Claude apart from tsx's own start.
      `writeFileSync(path.join(home, 'called.txt'), String(Date.now()));`,
      mode === 'wrapper'
        ? `process.exit(await wrapperLaunch(context, [process.execPath, fake, ...claudeArgs]));`
        : `process.exit(await editorLaunch(context, claudeArgs));`,
    ].join('\n'),
    'utf8',
  );
  return script;
}

/** What the fake claude is asked to do with one turn when it refuses it (see its README). */
interface Turn {
  limitType?: string;
  /** In epoch seconds. */
  resetsAt?: number;
  subagent?: boolean;
}

interface Chat {
  /** Tell Claude something, as the extension's webview sends a message somebody typed. */
  send(text: string, turn?: Turn): void;
  /** Whether Claude has answered `count` turns, within a while. */
  answered(count: number): Promise<boolean>;
  /** Whether the wrapper, and with it Claude, is still running. */
  running(): boolean;
  /** Close the chat, as the extension does: its input ends. The wrapper's exit code. */
  close(): Promise<number | null>;
  /** End the input without waiting, as the extension does first when it closes a chat. */
  endInput(): void;
  /** Send the wrapper `signal`, as the extension does 2 s after closing a chat whose wrapper still runs. */
  signal(signal: NodeJS.Signals): void;
  /** The wrapper's exit code, once it has exited. */
  exited: Promise<number | null>;
  /** Whether Claude has come up, within a while: it says so as it starts. */
  up(): Promise<boolean>;
  /** Every line Claude wrote to standard output, as it came through the wrapper. */
  stdout: string[];
  /** The result of each turn Claude has answered, in order. */
  results(): Array<{ is_error?: boolean }>;
}

const opened: ChildProcess[] = [];

function openChat(
  home: string,
  chatArgs: string[],
  env: Record<string, string> = {},
  mode: Mode = 'wrapper',
): Chat {
  const child = spawn(
    TSX,
    [launchScript(home, mode), home, fakeClaude, ...EXTENSION_ARGS, ...chatArgs],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, ...EDITOR_CLAUDE, ...env },
    },
  );
  opened.push(child);
  let exitCode: number | null | undefined;
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      exitCode = code;
      resolve(code);
    }),
  );
  const results: Array<{ is_error?: boolean }> = [];
  const stdout: string[] = [];
  let started = false;
  let unread = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    unread += chunk;
    for (let end = unread.indexOf('\n'); end !== -1; end = unread.indexOf('\n')) {
      const line = unread.slice(0, end).trim();
      unread = unread.slice(end + 1);
      if (line !== '') stdout.push(line);
      try {
        const event = JSON.parse(line) as { type?: unknown; subtype?: unknown; is_error?: boolean };
        if (event.type === 'result') results.push(event);
        if (event.type === 'system' && event.subtype === 'init') started = true;
      } catch {
        /* not an event */
      }
    }
  });
  child.stderr?.resume();
  return {
    send(text, turn) {
      const message = {
        type: 'user',
        session_id: '',
        parent_tool_use_id: null,
        origin: { kind: 'human' },
        message: { role: 'user', content: [{ type: 'text', text }] },
        ...(turn ? { fake: turn } : {}),
      };
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    answered: (count) => until(() => results.length >= count),
    running: () => exitCode === undefined,
    close() {
      child.stdin?.end();
      return exited;
    },
    endInput() {
      child.stdin?.end();
    },
    signal(signal) {
      child.kill(signal);
    },
    exited,
    up: () => until(() => started),
    stdout,
    results: () => results,
  };
}

const confirmedByRefusal = (limit: string): RegExp =>
  new RegExp(
    `^in the editor, the usage check could not answer \\(status 429\\), but Claude recorded the turn as refused \\(usage_limit_reached, ${limit}\\), which confirms the limit$`,
  );
const notMoving = (why: string): string =>
  'Claude recorded a refused turn in the editor, but not moving the editor yet: ' +
  `the usage check could not answer (status 429), and ${why}`;

describe('an editor chat that meets a limit while the usage check is turned away (against fake-claude)', () => {
  afterEach(() => {
    // Its input ended too, so a Claude the wrapper left behind ends as well.
    for (const child of opened.splice(0)) {
      child.stdin?.end();
      if (child.exitCode === null) child.kill();
    }
  });

  it(
    'records the limit and moves the editor while a new chat stays open',
    { timeout: 60_000 },
    async () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
      const { home, ctx } = await twoAccounts('cas-editor-new-', { A: [TURNED_AWAY] });
      const chat = openChat(home, [], { FAKE_CLAUDE_RESETS_AT: String(resetsAt) });
      chat.send('hello');
      expect(await chat.answered(1)).toBe(true);
      await until(() => said(home, 'the editor moved to B') === 1);

      // Before the chat ends: its one Claude is still answering turns.
      expect(chat.running()).toBe(true);
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: resetsAt * 1000 })]);
      expect(capsIn(home)[0]?.model).toBeUndefined();
      expect(getActive(ctx)).toBe('B');
      expect(asked(home)).toEqual(['A']);
      expect(verdicts(home)).toEqual([expect.stringMatching(confirmedByRefusal('five_hour'))]);
      expect(said(home, 'the editor moved to B')).toBe(1);

      expect(await chat.close()).toBe(0);
      expect(capsIn(home)).toHaveLength(1);
    },
  );

  it(
    'records the limit but saves no login once a newer ccx is installed, leaving the editor to it, and says so once',
    { timeout: 60_000 },
    async () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
      const { home, ctx } = await twoAccounts('cas-editor-newer-', { A: [TURNED_AWAY] });
      const chat = openChat(home, [], {
        FAKE_CLAUDE_RESETS_AT: String(resetsAt),
        NEWER_CCX_CLI: path.join(home, 'newer-ccx', 'dist', 'cli.js'),
      });
      chat.send('hello');
      expect(await chat.answered(1)).toBe(true);
      expect(await until(() => getActive(ctx) === 'B')).toBe(true);
      // Without a newer ccx the editor moves straight after (the test above).
      await until(() => said(home, 'the editor moved to B') > 0, 3_000);

      expect(said(home, 'the editor moved to B')).toBe(0);
      expect(editorRecord(home)?.account).toBe('A');
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: resetsAt * 1000 })]);
      const told = /^ccx 9\.9\.9 is installed: this editor chat saves no logins from now on/;
      expect(timesSaid(home, told)).toBe(1);

      // Refused again on A: the move tried again is left to the newer ccx too, unsaid.
      chat.send('hello again');
      expect(await chat.answered(2)).toBe(true);
      await sleep(1_000);
      expect(editorRecord(home)?.account).toBe('A');
      expect(said(home, 'the editor moved to B')).toBe(0);
      expect(timesSaid(home, told)).toBe(1);
      expect(await chat.close()).toBe(0);
    },
  );

  it(
    'follows a chat it resumes from where its record ended, so its history is not news',
    { timeout: 60_000 },
    async () => {
      const { home, ctx } = await twoAccounts('cas-editor-resumed-', { A: [TURNED_AWAY] });
      // Earlier turns of the chat: a refusal an hour ago, and one half a minute
      // ago, before this Claude started, on another process now gone.
      const record = recordOf(home, RESUMED);
      mkdirSync(path.dirname(record), { recursive: true });
      const old = (agoMs: number): string =>
        `${JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          isApiErrorMessage: true,
          error: 'rate_limit',
          apiError: 'usage_limit_reached',
          apiErrorStatus: 429,
          apiErrorParams: { rate_limit_info: { rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 } },
          timestamp: new Date(Date.now() - agoMs).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: 'Out of room on this account for now.' }] },
        })}\n`;
      writeFileSync(record, old(60 * 60_000) + old(30_000), 'utf8');

      // The extension starts Claude to send the turn the person just wrote, and
      // here Claude is refused before ccx first reads its records (every 2 s,
      // as in production), and before Claude says which conversation it is in.
      const chat = openChat(home, [`--resume=${RESUMED}`], {
        EDITOR_FOLLOW_MS: '2000',
        FAKE_CLAUDE_SESSION_RECORD_AFTER_MS: '3000',
      });
      chat.send('hello again');
      expect(await chat.answered(1)).toBe(true);
      await until(() => getActive(ctx) === 'B');

      expect(chat.running()).toBe(true);
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A' })]);
      expect(getActive(ctx)).toBe('B');
      // Only the turn refused now was asked about.
      expect(asked(home)).toEqual(['A']);
      expect(verdicts(home)).toEqual([expect.stringMatching(confirmedByRefusal('five_hour'))]);
      expect(await chat.close()).toBe(0);
    },
  );

  it(
    'follows the chat to the conversation a /clear moves its Claude to',
    { timeout: 60_000 },
    async () => {
      const { home, ctx } = await twoAccounts('cas-editor-clear-', { A: [TURNED_AWAY] });
      // Held back only briefly after a check that confirms nothing.
      const chat = openChat(home, [], { FAKE_CLAUDE_CLEAR_TO: CLEARED, EDITOR_REFUTE_BACKOFF_MS: '500' });
      // A first turn, refused for a limit ccx cannot name: its verdict shows
      // that ccx is following the chat's first conversation.
      chat.send('hello', { limitType: 'seven_day_someday' });
      expect(await chat.answered(1)).toBe(true);
      await until(() => verdicts(home).length > 0);
      expect(verdicts(home)).toEqual([notMoving('the refusal does not say which limit it is (seven_day_someday)')]);
      chat.send('/clear');
      expect(await chat.answered(2)).toBe(true);
      // A person types the next message seconds later; ccx reads Claude's
      // records every 100 ms here.
      await sleep(1_500);
      chat.send('hello');
      expect(await chat.answered(3)).toBe(true);
      await until(() => getActive(ctx) === 'B');

      expect(chat.running()).toBe(true);
      // The turn refused for a limit ccx can name is in the new conversation's record only.
      expect(readFileSync(recordOf(home, CLEARED), 'utf8')).toContain(
        '"rateLimitType":"five_hour"',
      );
      expect(readFileSync(recordOf(home, NEW_CHAT), 'utf8')).not.toContain(
        '"rateLimitType":"five_hour"',
      );
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A' })]);
      expect(getActive(ctx)).toBe('B');
      expect(verdicts(home)[1]).toMatch(confirmedByRefusal('five_hour'));
      expect(await chat.close()).toBe(0);
    },
  );

  /**
   * A refused turn that must not count, with the usage check turned away: ccx
   * reads it and says why, and records and moves nothing, while the chat runs
   * or after it.
   */
  async function refusedButNotMoved(
    prefix: string,
    env: Record<string, string>,
    why: (home: string) => string,
    before: (home: string) => void = () => {},
  ): Promise<void> {
    const { home, ctx } = await twoAccounts(prefix, { A: [TURNED_AWAY] });
    before(home);
    const chat = openChat(home, [], env);
    chat.send('hello');
    expect(await chat.answered(1)).toBe(true);
    await until(() => verdicts(home).length > 0);

    expect(chat.running()).toBe(true);
    expect(verdicts(home)).toEqual([notMoving(why(home))]);
    expect(capsIn(home)).toEqual([]);
    expect(getActive(ctx)).toBe('A');
    expect(await chat.close()).toBe(0);
    expect(capsIn(home)).toEqual([]);
    expect(getActive(ctx)).toBe('A');
  }

  it('moves nothing on a refusal from before its Claude started', { timeout: 60_000 }, async () => {
    // As an entry copied into the record from an older one keeps its own time.
    await refusedButNotMoved(
      'cas-editor-old-',
      { FAKE_CLAUDE_REFUSAL_AGE_MS: String(60 * 60_000) },
      () => 'the refusal was recorded before this Claude started',
    );
  });

  it('moves nothing on a refusal that a prompt was typed after', { timeout: 60_000 }, async () => {
    await refusedButNotMoved(
      'cas-editor-prompted-',
      { FAKE_CLAUDE_PROMPT_WITH_REFUSAL: '1' },
      () => 'a prompt was typed after the refusal',
    );
  });

  it('moves nothing on a refusal for a limit it cannot name', { timeout: 60_000 }, async () => {
    await refusedButNotMoved(
      'cas-editor-unnamed-',
      { FAKE_CLAUDE_LIMIT_TYPE: 'seven_day_someday' },
      () => 'the refusal does not say which limit it is (seven_day_someday)',
    );
  });

  it('moves nothing on a refusal for a limit that has reset since', { timeout: 60_000 }, async () => {
    await refusedButNotMoved(
      'cas-editor-reset-',
      { FAKE_CLAUDE_RESETS_AT: String(Math.floor(Date.now() / 1000) - 60) },
      () => 'the limit it names has reset since',
    );
  });

  it('moves nothing while another live Claude is on the conversation', { timeout: 60_000 }, async () => {
    // Claude's own record of another process of its on the same conversation,
    // in the shared folder: this test's own process stands in for it.
    await refusedButNotMoved(
      'cas-editor-other-',
      {},
      () => `another Claude (pid ${process.pid}) is on this conversation too, so the refusal may be its`,
      (home) => {
        mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
        writeFileSync(
          path.join(home, '.claude', 'sessions', `${process.pid}.json`),
          JSON.stringify({ pid: process.pid, sessionId: NEW_CHAT, kind: 'interactive' }),
          'utf8',
        );
      },
    );
  });

  it(
    'records a limit once, however many turns Claude refuses on it',
    { timeout: 60_000 },
    async () => {
      const { home, ctx } = await twoAccounts('cas-editor-twice-', { A: [TURNED_AWAY] });
      // Claude keeps the login it had for a request more after the editor moves, as it does for up to 30 s.
      const chat = openChat(home, [], { FAKE_CLAUDE_OLD_LOGIN_REQUESTS: '1' });
      chat.send('hello');
      expect(await chat.answered(1)).toBe(true);
      await until(() => said(home, 'the editor moved to B') === 1);
      expect(getActive(ctx)).toBe('B');
      // The person tries again on the same Claude, and it is refused again.
      chat.send('please');
      expect(await chat.answered(2)).toBe(true);
      // Long enough for ccx to have read that refusal several times over.
      await sleep(1_000);

      expect(asked(home)).toEqual(['A']);
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A' })]);
      expect(chat.results()[1]?.is_error).toBe(true);
      expect(said(home, 'A hit its limit (editor)')).toBe(1);
      expect(said(home, 'the editor moved to B')).toBe(1);
      expect(await chat.close()).toBe(0);
      expect(said(home, 'A hit its limit (editor)')).toBe(1);
    },
  );

  it(
    "records a limit once when the record proved it and Claude's last words show it",
    { timeout: 60_000 },
    async () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
      const { home, ctx } = await twoAccounts('cas-editor-both-', {
        A: [TURNED_AWAY, OUT(Date.now() + 5 * 60 * 60_000)],
      });
      const chat = openChat(home, [], {
        FAKE_CLAUDE_RESETS_AT: String(resetsAt),
        FAKE_CLAUDE_LAST_WORDS: "You've hit your session limit. Run /usage-credits to continue.",
        FAKE_CLAUDE_EXIT_CODE: '1',
        EDITOR_MOVE_RETRY_MS: '300',
      });
      expect(await chat.up()).toBe(true);
      // The editor stays on A, where the words at the end are about, while Claude holds its login's lock.
      claudeHoldsItsLogin(home);
      chat.send('hello');
      expect(await chat.answered(1)).toBe(true);
      await until(() => getActive(ctx) === 'B');
      expect(said(home, 'A hit its limit (editor)')).toBe(1);

      expect(await chat.close()).toBe(1);
      // The whole account is already recorded, so the words are not asked about.
      expect(asked(home)).toEqual(['A']);
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: resetsAt * 1000 })]);
      expect(said(home, 'A hit its limit (editor)')).toBe(1);
      expect(timesSaid(home, NOT_MOVED_TO_B)).toBe(1);
    },
  );

  it(
    "records one model's limit once when the record proved it and Claude's last words show it",
    { timeout: 60_000 },
    async () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
      const { home } = await twoAccounts('cas-editor-both-opus-', {
        A: [TURNED_AWAY, OPUS_OUT(Date.now() + 9 * 60 * 60_000)],
      });
      const chat = openChat(home, [], {
        FAKE_CLAUDE_LIMIT_TYPE: 'seven_day_opus',
        FAKE_CLAUDE_RESETS_AT: String(resetsAt),
        FAKE_CLAUDE_LAST_WORDS: "You've reached your Opus limit. Run /usage-credits to continue.",
        FAKE_CLAUDE_EXIT_CODE: '1',
      });
      chat.send('hello');
      expect(await chat.answered(1)).toBe(true);
      await until(() => said(home, 'A hit its limit (editor)') > 0);
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', model: 'Opus' })]);

      expect(await chat.close()).toBe(1);
      // Asked about the words too, since only Opus was recorded, and that is
      // what they turned out to be: the refusal's reset stands.
      expect(asked(home)).toEqual(['A', 'A']);
      expect(capsIn(home)).toEqual([
        expect.objectContaining({ account: 'A', model: 'Opus', capUntil: resetsAt * 1000 }),
      ]);
      expect(said(home, 'A hit its limit (editor)')).toBe(1);
      // A's other models still work, so it is the account the editor stays on.
      expect(said(home, 'the editor stays on A')).toBe(1);
    },
  );

  it(
    "asks nothing about Claude's debug lines, however much they say about rate limits",
    { timeout: 60_000 },
    async () => {
      // The extension starts its Claude with --debug --debug-to-stderr, and in
      // an ordinary turn Claude's debug log talks about rate limits. A chat
      // that closes on such a line has met no limit.
      const { home, ctx } = await twoAccounts('cas-editor-debug-', { A: [ROOM] });
      const chat = openChat(home, [], {
        FAKE_CLAUDE_REFUSE_ON: '',
        FAKE_CLAUDE_LAST_WORDS:
          `${new Date().toISOString()} [ERROR] API error (attempt 1/11): 429 ` +
          'This request would exceed the rate limit for your organization',
        FAKE_CLAUDE_EXIT_CODE: '1',
      });
      chat.send('hello');
      expect(await chat.answered(1)).toBe(true);

      expect(await chat.close()).toBe(1);
      expect(asked(home)).toEqual([]);
      expect(verdicts(home)).toEqual([]);
      expect(capsIn(home)).toEqual([]);
      expect(getActive(ctx)).toBe('A');
    },
  );

  it(
    'records the limit again when the chat meets it after its reset',
    { timeout: 60_000 },
    async () => {
      // An editor's Claude outlives a limit: refused at 10:00 for one that
      // resets at 15:00, and at 18:00 for the next, on the same Claude.
      const { home, ctx } = await twoAccounts('cas-editor-again-', { A: [TURNED_AWAY] });
      const chat = openChat(home, [], { EDITOR_MOVE_RETRY_MS: '300' });
      expect(await chat.up()).toBe(true);
      // The editor stays on A while Claude holds its login's lock, so this Claude meets the limit again.
      claudeHoldsItsLogin(home);
      // Far enough out to hold however slowly the first turn is judged.
      const first = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
      chat.send('hello', { resetsAt: first });
      expect(await chat.answered(1)).toBe(true);
      expect(await verdictNumber(home, 1)).toMatch(confirmedByRefusal('five_hour'));
      expect(await until(() => timesSaid(home, NOT_MOVED_TO_B) === 1)).toBe(true);
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: first * 1000 })]);

      resetOnLedger(ctx, 'A');
      const second = first + 60 * 60;
      chat.send('hello again', { resetsAt: second });
      expect(await chat.answered(2)).toBe(true);
      expect(await verdictNumber(home, 2)).toMatch(confirmedByRefusal('five_hour'));
      expect(await until(() => said(home, 'A hit its limit (editor)') === 2)).toBe(true);

      expect(chat.running()).toBe(true);
      expect(asked(home)).toEqual(['A', 'A']);
      expect(said(home, 'A hit its limit (editor)')).toBe(2);
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: second * 1000 })]);
      expect(await chat.close()).toBe(0);
    },
  );

  it(
    "asks about Claude's last words once the limit the record proved has reset",
    { timeout: 60_000 },
    async () => {
      const later = Date.now() + 5 * 60 * 60_000;
      const { home, ctx } = await twoAccounts('cas-editor-again-words-', { A: [TURNED_AWAY, OUT(later)] });
      const chat = openChat(home, [], {
        FAKE_CLAUDE_LAST_WORDS: "You've hit your session limit. Run /usage-credits to continue.",
        FAKE_CLAUDE_EXIT_CODE: '1',
        EDITOR_MOVE_RETRY_MS: '300',
      });
      expect(await chat.up()).toBe(true);
      // The editor stays on A, where the words at the end are about, while Claude holds its login's lock.
      claudeHoldsItsLogin(home);
      // Far enough out to hold however slowly the first turn is judged.
      const first = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
      chat.send('hello', { resetsAt: first });
      expect(await chat.answered(1)).toBe(true);
      expect(await verdictNumber(home, 1)).toMatch(confirmedByRefusal('five_hour'));
      expect(await until(() => timesSaid(home, NOT_MOVED_TO_B) === 1)).toBe(true);
      resetOnLedger(ctx, 'A');

      expect(await chat.close()).toBe(1);
      expect(asked(home)).toEqual(['A', 'A']);
      expect(said(home, 'A hit its limit (editor)')).toBe(2);
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: later })]);
    },
  );

  it(
    'holds the next refused turns back after a check that confirms nothing, as a terminal session does',
    { timeout: 60_000 },
    async () => {
      const { home } = await twoAccounts('cas-editor-backoff-', { A: [ROOM] });
      const chat = openChat(home, []);
      chat.send('hello');
      expect(await chat.answered(1)).toBe(true);
      await until(() => verdicts(home).length === 1);
      // The person tries again at once, and is refused again.
      chat.send('please');
      expect(await chat.answered(2)).toBe(true);
      // Long enough for ccx to have read that refusal several times over.
      await sleep(1_000);
      expect(asked(home)).toEqual(['A']);
      expect(verdicts(home)).toEqual(['Claude recorded a refused turn in the editor, but "A" shows no spent window; nothing recorded']);

      expect(await chat.close()).toBe(0);
      // The one held back is asked about as Claude exits, as in a terminal.
      expect(asked(home)).toEqual(['A', 'A']);
      expect(capsIn(home)).toEqual([]);
    },
  );

  it(
    'judges a held refusal on the conversation it was read from, after a /clear',
    { timeout: 60_000 },
    async () => {
      // The first turn's check waits; meanwhile the session limit refuses the
      // second turn, read from the first conversation, where another live
      // Claude is at work; then a /clear moves this Claude elsewhere.
      const { home } = await twoAccounts('cas-editor-held-conversation-', {
        A: [{ ...TURNED_AWAY, waitFor: 'release' }, TURNED_AWAY],
      });
      otherClaudeOn(home, NEW_CHAT);
      const chat = openChat(home, [], { FAKE_CLAUDE_CLEAR_TO: CLEARED });
      chat.send('hello', { limitType: 'seven_day_someday' });
      expect(await chat.answered(1)).toBe(true);
      await until(() => asked(home).length === 1);
      chat.send('please');
      expect(await chat.answered(2)).toBe(true);
      await sleep(500);
      chat.send('/clear');
      expect(await chat.answered(3)).toBe(true);
      await sleep(500);
      release(home);
      await until(() => verdicts(home).length === 1);

      expect(await chat.close()).toBe(0);
      expect(capsIn(home)).toEqual([]);
      expect(verdicts(home)).toEqual([
        notMoving('the refusal does not say which limit it is (seven_day_someday)'),
        notMoving(`another Claude (pid ${process.pid}) is on this conversation too, so the refusal may be its`),
      ]);
    },
  );

  it(
    'keeps a refusal for the whole account held back behind a later one for one model',
    { timeout: 60_000 },
    async () => {
      // While the first turn's check waits, the main thread is refused for the
      // session limit and then a subagent for its weekly Opus limit.
      const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
      const { home } = await twoAccounts('cas-editor-held-scope-', {
        A: [{ ...TURNED_AWAY, waitFor: 'release' }, TURNED_AWAY],
      });
      const chat = openChat(home, [], { FAKE_CLAUDE_RESETS_AT: String(resetsAt) });
      chat.send('hello', { limitType: 'seven_day_someday' });
      expect(await chat.answered(1)).toBe(true);
      await until(() => asked(home).length === 1);
      chat.send('please');
      expect(await chat.answered(2)).toBe(true);
      chat.send('carry on', { subagent: true, limitType: 'seven_day_opus' });
      expect(await chat.answered(3)).toBe(true);
      await sleep(500);
      release(home);
      await until(() => verdicts(home).length === 1);

      expect(await chat.close()).toBe(0);
      // The whole account's, asked about first, which takes in Opus too.
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: resetsAt * 1000 })]);
      expect(capsIn(home)[0]?.model).toBeUndefined();
      expect(asked(home)).toEqual(['A', 'A']);
    },
  );

  it(
    "asks about the whole account's held refusal first, whichever came first",
    { timeout: 60_000 },
    async () => {
      // While the first turn's check waits, a subagent meets its weekly Opus
      // limit, and then the main thread its session limit.
      const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
      const { home } = await twoAccounts('cas-editor-held-order-', {
        A: [{ ...TURNED_AWAY, waitFor: 'release' }, TURNED_AWAY],
      });
      const chat = openChat(home, [], { FAKE_CLAUDE_RESETS_AT: String(resetsAt) });
      chat.send('hello', { limitType: 'seven_day_someday' });
      expect(await chat.answered(1)).toBe(true);
      await until(() => asked(home).length === 1);
      chat.send('carry on', { subagent: true, limitType: 'seven_day_opus' });
      expect(await chat.answered(2)).toBe(true);
      chat.send('please');
      expect(await chat.answered(3)).toBe(true);
      await sleep(500);
      release(home);
      await until(() => verdicts(home).length === 1);

      expect(await chat.close()).toBe(0);
      // One check, for the whole account, which takes in Opus.
      expect(asked(home)).toEqual(['A', 'A']);
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: resetsAt * 1000 })]);
      expect(capsIn(home)[0]?.model).toBeUndefined();
    },
  );

  it(
    'asks about every refusal held back, past one the ledger already holds',
    { timeout: 60_000 },
    async () => {
      // The first turn's check confirms nothing, so the next refused turns
      // are held back for a while: a subagent's weekly Opus limit, then the
      // main thread's weekly Sonnet limit. Another session records the Opus
      // one, and the chat is closed: as Claude exits, the Sonnet refusal is
      // reached only past the Opus one, with no check after it to pick it up.
      const { home, ctx } = await twoAccounts('cas-editor-held-past-', { A: [TURNED_AWAY] });
      const chat = openChat(home, []);
      chat.send('hello', { limitType: 'seven_day_someday' });
      expect(await chat.answered(1)).toBe(true);
      await until(() => verdicts(home).length === 1);
      chat.send('carry on', { subagent: true, limitType: 'seven_day_opus' });
      expect(await chat.answered(2)).toBe(true);
      chat.send('please', { limitType: 'seven_day_sonnet' });
      expect(await chat.answered(3)).toBe(true);
      await sleep(500);
      expect(asked(home)).toEqual(['A']);
      updateLedger(ctx, (ledger) =>
        markCapped(ledger, {
          account: 'A',
          now: Date.now(),
          resetAt: Date.now() + 2 * 60 * 60_000,
          model: 'Opus',
          reason: 'another session',
        }),
      );

      expect(await chat.close()).toBe(0);
      expect(capsIn(home)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ account: 'A', model: 'Sonnet' }),
          expect.objectContaining({ account: 'A', model: 'Opus' }),
        ]),
      );
      // Sonnet asked about; the Opus refusal let go, since the ledger holds it.
      expect(asked(home)).toEqual(['A', 'A']);
    },
  );
});

/** The editor's folder, where ccx-claude runs every chat's Claude. */
const editorFolder = (home: string): string => path.join(home, 'editor-active');
const isRealFolder = (dir: string): boolean => {
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};
interface Launch {
  at: number;
  pid: number;
  args: string[];
  applied: { print: boolean; sessionId: string | null };
  folder: { configDir: string | null; settings: unknown };
}
/** When ccx-claude's launch was called (see launchScript). */
const calledAt = (home: string): number =>
  Number(readFileSync(path.join(home, 'called.txt'), 'utf8'));
/** How long a launch may take to start Claude, when it must not wait for a lock: it once waited 10 s for each. */
const LAUNCH_MS = 3_000;
/** Each Claude the fake claude logged starting (FAKE_CLAUDE_RUNS_LOG), with the folder it runs in (FAKE_CLAUDE_LOG_FOLDER). */
const launchesIn = (runsLog: string): Launch[] =>
  linesOf(runsLog)
    .map((l) => JSON.parse(l) as Launch & { type: string })
    .filter((e) => e.type === 'launch');
const LOG_LAUNCH = (home: string): Record<string, string> => ({
  FAKE_CLAUDE_RUNS_LOG: path.join(home, 'runs.jsonl'),
  FAKE_CLAUDE_LOG_FOLDER: '1',
});

describe.each<Mode>(['wrapper', 'direct'])(
  'a chat started through ccx-claude (%s mode)',
  (mode) => {
    afterEach(() => {
      for (const child of opened.splice(0)) {
        child.stdin?.end();
        if (child.exitCode === null) child.kill();
      }
    });

    it(
      "runs Claude on the editor's folder, and keeps the folder from being retired while it runs",
      { timeout: 60_000 },
      async () => {
        const { home, context } = await twoAccounts('cas-editor-on-folder-', { A: [ROOM] });
        const folder = editorFolder(home);
        const chat = openChat(home, [], { FAKE_CLAUDE_REFUSE_ON: '', ...LOG_LAUNCH(home) }, mode);
        chat.send('hello');
        expect(await chat.answered(1)).toBe(true);

        expect(launchesIn(path.join(home, 'runs.jsonl'))[0]?.folder.configDir).toBe(
          realpathSync(folder),
        );
        // It is an editor chat open in the folder: a retirement waits for it, as it does for the extension's.
        expect(retireEditor(context)).toBe('held');
        expect(isRealFolder(folder)).toBe(true);

        expect(await chat.close()).toBe(0);
        expect(retireEditor(context)).toBe('retired');
        expect(existsSync(folder)).toBe(false);
      },
    );

    it(
      'clears a retirement of the folder that is pending, and runs on the folder',
      { timeout: 60_000 },
      async () => {
        const { home, context } = await twoAccounts('cas-editor-pending-', { A: [ROOM] });
        const folder = editorFolder(home);
        // The folder, with its retirement held off for as long as something counts as an editor chat open in it.
        await setUpEditor(context);
        // A running chat started before the check; retireEditor skips one started at or after it.
        const chatEnded = noteEditorChat(context.ctx, process.pid, folder, Date.now() - 1_000);
        expect(retireEditor(context)).toBe('held');
        chatEnded();
        const pending = path.join(home, 'editor-retire.json');
        expect(existsSync(pending)).toBe(true);

        const chat = openChat(home, [], { FAKE_CLAUDE_REFUSE_ON: '', ...LOG_LAUNCH(home) }, mode);
        chat.send('hello');
        expect(await chat.answered(1)).toBe(true);

        expect(existsSync(pending)).toBe(false);
        expect(launchesIn(path.join(home, 'runs.jsonl'))[0]?.folder.configDir).toBe(
          realpathSync(folder),
        );
        expect(await chat.close()).toBe(0);
        expect(isRealFolder(folder)).toBe(true);
      },
    );

    it(
      'starts Claude on the editor folder at once while another ccx holds the editor lock, with your setup in it',
      { timeout: 60_000 },
      async () => {
        const { home, context } = await twoAccounts('cas-editor-locked-', { A: [ROOM] });
        mkdirSync(path.join(home, '.claude'), { recursive: true });
        writeFileSync(
          path.join(home, '.claude', 'settings.json'),
          JSON.stringify({ model: 'fable' }),
          'utf8',
        );
        await setUpEditor(context);
        // Another ccx is changing the folder, and goes on holding its lock for as long as this launch runs.
        const lock = acquireOwnedLock(path.join(home, 'editor-folder.lock'), {
          waitMs: 0,
          staleMs: 60_000,
          maxHoldMs: 60_000,
        });
        expect(lock.held).toBe(true);
        try {
          const chat = openChat(home, [], { FAKE_CLAUDE_REFUSE_ON: '', ...LOG_LAUNCH(home) }, mode);
          expect(await chat.up()).toBe(true);

          // It once waited 10 s for the lock and then ran on the account's own folder, which has none of your setup.
          const [launch] = launchesIn(path.join(home, 'runs.jsonl'));
          expect(launch!.at - calledAt(home)).toBeLessThan(LAUNCH_MS);
          expect(launch?.folder.configDir).toBe(realpathSync(editorFolder(home)));
          expect(launch?.folder.settings).toEqual({ model: 'fable' });
          expect(await chat.close()).toBe(0);
        } finally {
          lock.release();
        }
      },
    );

    it(
      'starts Claude at once when the move to the active account waits on Claude, and leaves that move pending',
      { timeout: 60_000 },
      async () => {
        const { home, ctx, context } = await twoAccounts('cas-editor-launch-wait-', { A: [ROOM] });
        // The folder is on A, B has been made active since, and Claude holds its login's lock.
        await setUpEditor(context);
        setActive('B', ctx);
        claudeHoldsItsLogin(home);

        // A move under a running Claude looks for its lock for 10 s; a launch looks once.
        const chat = openChat(
          home,
          [],
          { FAKE_CLAUDE_REFUSE_ON: '', EDITOR_MOVE_RETRY_MS: '8000', ...LOG_LAUNCH(home) },
          mode,
        );
        expect(await chat.up()).toBe(true);

        const [launch] = launchesIn(path.join(home, 'runs.jsonl'));
        expect(launch!.at - calledAt(home)).toBeLessThan(LAUNCH_MS);
        expect(launch?.folder.configDir).toBe(realpathSync(editorFolder(home)));
        // The editor stays on A, and the move waits for a later event.
        expect(editorRecord(home)?.account).toBe('A');
        expect(existsSync(path.join(home, 'editor-move-pending.json'))).toBe(true);
        expect(await chat.close()).toBe(0);
      },
    );
  },
);

describe('a chat started the way Conductor starts Claude (against fake-claude)', () => {
  afterEach(() => {
    for (const child of opened.splice(0)) {
      child.stdin?.end();
      if (child.exitCode === null) child.kill();
    }
  });

  it(
    "passes its command line to Claude untouched, and writes nothing to Claude's standard output",
    { timeout: 60_000 },
    async () => {
      const { home } = await twoAccounts('cas-conductor-args-', { A: [ROOM] });
      const conductorArgs = [`--session-id=${NEW_CHAT}`, '--setting-sources=user,project,local'];
      const chat = openChat(
        home,
        conductorArgs,
        { FAKE_CLAUDE_REFUSE_ON: '', ...LOG_LAUNCH(home) },
        'direct',
      );
      chat.send('hello');
      expect(await chat.answered(1)).toBe(true);
      expect(await chat.close()).toBe(0);

      const [launch] = launchesIn(path.join(home, 'runs.jsonl'));
      expect(launch?.args).toEqual([...EXTENSION_ARGS, ...conductorArgs]);
      expect(launch?.applied.print).toBe(false);
      expect(launch?.applied.sessionId).toBe(NEW_CHAT);
      expect(launch?.folder.configDir).toBe(realpathSync(editorFolder(home)));
      // Every line on standard output is one of Claude's own events.
      expect(chat.stdout.length).toBeGreaterThan(0);
      for (const line of chat.stdout) {
        expect(['system', 'assistant', 'result']).toContain(
          (JSON.parse(line) as { type: string }).type,
        );
      }
    },
  );
});

/** The limit on `account`, as another session's confirmed check puts it on the ledger. */
const limitOn = (ctx: PathCtx, account: string): void => {
  updateLedger(ctx, (ledger) =>
    markCapped(ledger, {
      account,
      now: Date.now(),
      resetAt: Date.now() + 2 * HOURS,
      reason: 'another session',
    }),
  );
};

describe.each<Mode>(['wrapper', 'direct'])(
  'a limit met in a chat started through ccx-claude (%s mode)',
  (mode) => {
    afterEach(() => {
      for (const child of opened.splice(0)) {
        child.stdin?.end();
        if (child.exitCode === null) child.kill();
      }
    });

    it(
      'moves the editor to the next account while the chat stays open, so its next message goes out there',
      { timeout: 60_000 },
      async () => {
        const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
        const { home, ctx } = await twoAccounts('cas-editor-moves-', { A: [TURNED_AWAY] });
        const chat = openChat(home, [], { FAKE_CLAUDE_RESETS_AT: String(resetsAt) }, mode);
        chat.send('hello');
        expect(await chat.answered(1)).toBe(true);
        await until(() => said(home, 'the editor moved to B') === 1);

        // The chat that met the limit is still open, and the editor's folder is on B.
        expect(chat.running()).toBe(true);
        expect(capsIn(home)).toEqual([
          expect.objectContaining({ account: 'A', capUntil: resetsAt * 1000 }),
        ]);
        expect(getActive(ctx)).toBe('B');
        expect(editorRecord(home)?.account).toBe('B');
        const login = JSON.parse(
          readFileSync(path.join(home, 'editor-active', '.credentials.json'), 'utf8'),
        ) as {
          account: string;
        };
        expect(login.account).toBe('B');
        expect(said(home, 'A hit its limit (editor)')).toBe(1);
        expect(said(home, 'the editor moved to B')).toBe(1);
        expect(said(home, 'next editor chat will use B')).toBe(0);

        // The refused turn stays refused, and the next message goes out on B.
        chat.send('please');
        expect(await chat.answered(2)).toBe(true);
        expect(chat.results().map((result) => result.is_error)).toEqual([true, false]);
        expect(asked(home)).toEqual(['A']);
        expect(await chat.close()).toBe(0);
      },
    );

    it(
      'passes over a refusal that comes just after the editor moved, which may be the login it left',
      { timeout: 60_000 },
      async () => {
        const { home } = await twoAccounts('cas-editor-left-', { A: [TURNED_AWAY] });
        // Claude keeps the login it had for a request more after the editor moves, as it does for up to 30 s.
        const chat = openChat(home, [], { FAKE_CLAUDE_OLD_LOGIN_REQUESTS: '1' }, mode);
        chat.send('hello');
        expect(await chat.answered(1)).toBe(true);
        await until(() => editorRecord(home)?.account === 'B');
        chat.send('again');
        expect(await chat.answered(2)).toBe(true);
        chat.send('once more');
        expect(await chat.answered(3)).toBe(true);
        // Long enough for ccx to have read that refusal several times over.
        await sleep(1_000);

        // Refused on the login Claude still held, then answered on B's.
        expect(chat.results().map((result) => result.is_error)).toEqual([true, true, false]);
        expect(
          timesSaid(
            home,
            /^Claude recorded a refused turn in the editor, but not asking about it: the refusal came within 40 s of the login changing under Claude, so it may be the old login$/,
          ),
        ).toBe(1);
        // No check was made for B, which has room, and none was left to be made as Claude ends.
        expect(asked(home)).toEqual(['A']);
        expect(verdicts(home)).toHaveLength(1);
        expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A' })]);
        expect(await chat.close()).toBe(0);
        expect(asked(home)).toEqual(['A']);
      },
    );

    it(
      'asks, for a refusal after the editor moved, the account the editor holds now, with its own login',
      { timeout: 60_000 },
      async () => {
        const { home, ctx, context } = await twoAccounts('cas-editor-holder-', {
          B: [TURNED_AWAY],
        });
        // The editor's folder is on B while A is the account this launch picks: the move to A waits on Claude's lock.
        setActive('B', ctx);
        await setUpEditor(context);
        setActive('A', ctx);
        claudeHoldsItsLogin(home);
        const chat = openChat(
          home,
          [],
          { FAKE_CLAUDE_REFUSE_ON: 'B', EDITOR_MOVE_RETRY_MS: '300' },
          mode,
        );
        chat.send('hello');
        expect(await chat.answered(1)).toBe(true);
        await until(() => capsIn(home).length > 0);

        // B's login was refused, so B is asked about, by its own profile folder's login, and B is what is recorded.
        expect(asked(home)).toEqual(['B']);
        expect(realpathSync(askedDetail(home)[0]!.file)).toBe(
          realpathSync(path.join(home, 'profiles', 'B', '.credentials.json')),
        );
        expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'B' })]);
        expect(await chat.close()).toBe(0);
      },
    );

    it(
      'takes home a renewal the editor made of the account before it asks that account about a limit',
      { timeout: 60_000 },
      async () => {
        const { home } = await twoAccounts(
          'cas-editor-renewal-',
          { A: [TURNED_AWAY] },
          { realLogins: true },
        );
        const chat = openChat(home, [], {}, mode);
        expect(await chat.up()).toBe(true);
        // The editor's Claude renews A's login in its folder, a generation on.
        writeFileSync(
          path.join(home, 'editor-active', '.credentials.json'),
          loginOf('A', 2),
          'utf8',
        );
        chat.send('hello');
        expect(await chat.answered(1)).toBe(true);
        await until(() => askedDetail(home).length === 1);

        // The check ran on the renewed login, not the one it retired.
        expect(askedDetail(home).map((question) => question.token)).toEqual(['a-A-2']);
        expect(await chat.close()).toBe(0);
      },
    );

    it(
      'asks, about the words Claude ends on, the account the editor holds by then',
      { timeout: 60_000 },
      async () => {
        const { home } = await twoAccounts('cas-editor-words-held-', { A: [TURNED_AWAY] });
        const chat = openChat(
          home,
          [],
          {
            FAKE_CLAUDE_LAST_WORDS:
              "You've hit your session limit. Run /usage-credits to continue.",
            FAKE_CLAUDE_EXIT_CODE: '1',
          },
          mode,
        );
        chat.send('hello');
        expect(await chat.answered(1)).toBe(true);
        await until(() => said(home, 'the editor moved to B') === 1);

        expect(await chat.close()).toBe(1);
        // The editor is on B by then, which has room: the limit on A is recorded once.
        expect(asked(home)).toEqual(['A', 'B']);
        expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A' })]);
        expect(
          said(home, 'limit text in the editor, but "B" shows no spent window; nothing recorded'),
        ).toBe(1);
      },
    );

    it(
      'records the limit of an account the editor has moved off while the check on it was under way, and moves nothing',
      { timeout: 60_000 },
      async () => {
        const { home, ctx, context } = await twoAccounts('cas-editor-moved-away-', {
          A: [{ ...OUT(Date.now() + 5 * HOURS), waitFor: 'release' }],
        });
        const chat = openChat(home, [], {}, mode);
        chat.send('hello');
        expect(await chat.answered(1)).toBe(true);
        await until(() => asked(home).length === 1);

        // While A is being asked about, something else puts the editor on B.
        setActive('B', ctx);
        await moveEditorToActive(context);
        expect(editorRecord(home)?.account).toBe('B');
        release(home);
        await until(() => timesSaid(home, /^the editor had already moved to B$/) === 1);

        // A is spent whichever account the editor holds now, so its limit is recorded. The editor is
        // already where it should be, so no next account is picked and nothing is moved.
        expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A' })]);
        expect(said(home, 'A hit its limit (editor)')).toBe(1);
        expect(getActive(ctx)).toBe('B');
        expect(editorRecord(home)?.account).toBe('B');
        expect(timesSaid(home, /^the editor (moved|has not moved|stays)/)).toBe(0);
        expect(await chat.close()).toBe(0);
      },
    );

    describe('a limit the ledger holds already, met again on the account the editor still holds', () => {
      it(
        'moves the editor when a move had waited on Claude, without asking the usage endpoint',
        { timeout: 60_000 },
        async () => {
          const { home, ctx } = await twoAccounts('cas-editor-retry-', { A: [TURNED_AWAY] });
          const chat = openChat(home, [], {}, mode);
          expect(await chat.up()).toBe(true);
          // Another session recorded A's limit and made B active, and the editor's folder is still on A.
          limitOn(ctx, 'A');
          setActive('B', ctx);
          expect(editorRecord(home)?.account).toBe('A');

          chat.send('hello');
          expect(await chat.answered(1)).toBe(true);
          await until(() => said(home, 'the editor moved to B') === 1);

          expect(editorRecord(home)?.account).toBe('B');
          expect(said(home, 'the editor moved to B')).toBe(1);
          expect(asked(home)).toEqual([]);
          // The turn that moved it stays refused, and the next goes out on B.
          chat.send('please');
          expect(await chat.answered(2)).toBe(true);
          expect(chat.results().map((result) => result.is_error)).toEqual([true, false]);
          expect(await chat.close()).toBe(0);
        },
      );

      it.each(['A', 'B'])(
        'does nothing while every account is spent, with %s active',
        { timeout: 60_000 },
        async (active) => {
          const { home, ctx } = await twoAccounts('cas-editor-all-spent-', { A: [TURNED_AWAY] });
          const chat = openChat(home, [], {}, mode);
          expect(await chat.up()).toBe(true);
          limitOn(ctx, 'A');
          limitOn(ctx, 'B');
          setActive(active, ctx);
          const moves = eventsIn(home).filter((event) => event.kind === 'editor-move').length;

          chat.send('hello');
          expect(await chat.answered(1)).toBe(true);
          // Long enough for ccx to have read that refusal several times over.
          await sleep(1_000);

          expect(editorRecord(home)?.account).toBe('A');
          expect(eventsIn(home).filter((event) => event.kind === 'editor-move')).toHaveLength(
            moves,
          );
          expect(timesSaid(home, /^the editor (moved|has not moved)/)).toBe(0);
          expect(asked(home)).toEqual([]);
          expect(await chat.close()).toBe(0);
        },
      );

      it(
        "does not move the editor to the account it is on for one model's limit the ledger holds",
        { timeout: 60_000 },
        async () => {
          const { home, ctx } = await twoAccounts('cas-editor-model-held-', { A: [TURNED_AWAY] });
          const chat = openChat(home, [], {}, mode);
          expect(await chat.up()).toBe(true);
          // Only Opus is out on A, which is the active account and the editor's.
          updateLedger(ctx, (ledger) =>
            markCapped(ledger, {
              account: 'A',
              now: Date.now(),
              resetAt: Date.now() + 2 * HOURS,
              model: 'Opus',
              reason: 'another session',
            }),
          );

          chat.send('hello', { limitType: 'seven_day_opus' });
          expect(await chat.answered(1)).toBe(true);
          // Long enough for ccx to have read that refusal several times over.
          await sleep(1_000);

          expect(timesSaid(home, /^the editor (moved|has not moved)/)).toBe(0);
          expect(asked(home)).toEqual([]);
          expect(await chat.close()).toBe(0);
        },
      );

      it(
        'tries the move once for two refusals within the back-off, and again after it',
        { timeout: 60_000 },
        async () => {
          const { home, ctx } = await twoAccounts('cas-editor-retry-once-', { A: [TURNED_AWAY] });
          const chat = openChat(
            home,
            [],
            { EDITOR_MOVE_RETRY_MS: '300', EDITOR_REFUTE_BACKOFF_MS: '3000' },
            mode,
          );
          expect(await chat.up()).toBe(true);
          limitOn(ctx, 'A');
          setActive('B', ctx);
          claudeHoldsItsLogin(home);

          chat.send('hello');
          expect(await chat.answered(1)).toBe(true);
          // The first try waits on Claude's lock and gives up.
          await until(() => timesSaid(home, NOT_MOVED_TO_B) === 1);
          chat.send('please');
          expect(await chat.answered(2)).toBe(true);
          // Long enough for ccx to have read that refusal several times over.
          await sleep(1_000);

          expect(timesSaid(home, NOT_MOVED_TO_B)).toBe(1);
          expect(editorRecord(home)?.account).toBe('A');

          // Once the back-off has passed and Claude lets go, the next refusal moves the editor.
          claudeLetsGo(home);
          await sleep(3_000);
          chat.send('again');
          expect(await chat.answered(3)).toBe(true);
          await until(() => said(home, 'the editor moved to B') === 1);

          expect(said(home, 'the editor moved to B')).toBe(1);
          expect(timesSaid(home, NOT_MOVED_TO_B)).toBe(1);
          expect(asked(home)).toEqual([]);
          expect(await chat.close()).toBe(0);
        },
      );
    });
  },
);

/**
 * How the extension (2.1.302) ends a chat's process: it closes its input,
 * then sends SIGTERM 2 s later if the wrapper still runs, and SIGKILL 5 s
 * after that. Off Windows only: there it sends no SIGTERM, only the SIGKILL.
 */
describe.skipIf(process.platform === 'win32')('an editor chat ended by the extension (against fake-claude)', () => {
  afterEach(() => {
    for (const child of opened.splice(0)) {
      child.stdin?.end();
      if (child.exitCode === null) child.kill();
    }
  });

  it(
    'finishes a check under way when the wrapper is asked to end after the chat closed',
    { timeout: 60_000 },
    async () => {
      const { home } = await twoAccounts('cas-editor-term-check-', { A: [{ ...TURNED_AWAY, waitFor: 'release' }] });
      const chat = openChat(home, []);
      chat.send('hello');
      expect(await chat.answered(1)).toBe(true);
      await until(() => asked(home).length === 1);
      chat.endInput();
      await sleep(300);
      const endedAt = Date.now();
      chat.signal('SIGTERM');
      await sleep(500);
      release(home);
      const code = await chat.exited;

      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A' })]);
      expect(code).toBe(143);
      expect(Date.now() - endedAt).toBeLessThan(5_000);
    },
  );

  it('passes the end on to its Claude while it runs', { timeout: 60_000 }, async () => {
    const { home } = await twoAccounts('cas-editor-term-claude-', { A: [TURNED_AWAY] });
    const runsLog = path.join(home, 'runs.jsonl');
    const chat = openChat(home, [], {
      FAKE_CLAUDE_REFUSE_ON: '',
      FAKE_CLAUDE_RUNS_LOG: runsLog,
      FAKE_CLAUDE_NOTE_TERM: '1',
    });
    chat.send('hello');
    expect(await chat.answered(1)).toBe(true);
    chat.signal('SIGTERM');
    const code = await chat.exited;

    const signals = linesOf(runsLog)
      .map((l) => JSON.parse(l) as { type?: string; signal?: string })
      .filter((e) => e.type === 'signal');
    expect(signals).toEqual([{ type: 'signal', signal: 'SIGTERM' }]);
    expect(code).toBe(143);
  });

  it(
    'gives up on a check that does not answer before the extension would kill it',
    { timeout: 60_000 },
    async () => {
      const { home } = await twoAccounts('cas-editor-term-bound-', { A: [{ ...TURNED_AWAY, waitFor: 'never' }] });
      const chat = openChat(home, []);
      chat.send('hello');
      expect(await chat.answered(1)).toBe(true);
      await until(() => asked(home).length === 1);
      chat.endInput();
      await sleep(300);
      const endedAt = Date.now();
      chat.signal('SIGTERM');
      const code = await chat.exited;
      const took = Date.now() - endedAt;

      expect(code).toBe(143);
      // It waited for the check, but not into the extension's SIGKILL.
      expect(took).toBeGreaterThanOrEqual(3_500);
      expect(took).toBeLessThan(5_000);
      expect(capsIn(home)).toEqual([]);
    },
  );
});

describe.skipIf(process.platform === 'win32')(
  'a chat through ccx-claude whose Claude will not end when asked (against fake-claude)',
  () => {
    afterEach(() => {
      for (const child of opened.splice(0)) {
        child.stdin?.end();
        if (child.exitCode === null) child.kill();
      }
    });

    describe.each<Mode>(['wrapper', 'direct'])('%s mode', (mode) => {
      /** A chat whose Claude ignores SIGTERM, and the note ccx-claude made of it. */
      async function stubbornChat(
        prefix: string,
      ): Promise<{ chat: Chat; claude: number; note: string }> {
        const { home } = await twoAccounts(prefix, { A: [ROOM] });
        const chat = openChat(
          home,
          [],
          { FAKE_CLAUDE_REFUSE_ON: '', FAKE_CLAUDE_IGNORE_TERM: '1', ...LOG_LAUNCH(home) },
          mode,
        );
        chat.send('hello');
        expect(await chat.answered(1)).toBe(true);
        const claude = launchesIn(path.join(home, 'runs.jsonl'))[0]!.pid;
        const note = path.join(home, 'editor-chats', `${claude}.json`);
        expect(existsSync(note)).toBe(true);
        return { chat, claude, note };
      }

      it(
        'leaves no note of its Claude when it gives up on it after the time it was given',
        { timeout: 60_000 },
        async () => {
          const { chat, claude, note } = await stubbornChat('cas-editor-note-giveup-');

          chat.signal('SIGTERM');
          expect(await chat.exited).toBe(143);

          // Claude is still running, which is not what clears the note.
          expect(processIsAlive(claude)).toBe(true);
          expect(existsSync(note)).toBe(false);
        },
      );

      it(
        'leaves no note of its Claude when it is asked to end a second time',
        { timeout: 60_000 },
        async () => {
          const { chat, claude, note } = await stubbornChat('cas-editor-note-second-');

          chat.signal('SIGTERM');
          await sleep(300);
          chat.signal('SIGTERM');
          expect(await chat.exited).toBe(143);

          expect(processIsAlive(claude)).toBe(true);
          expect(existsSync(note)).toBe(false);
        },
      );
    });
  },
);
