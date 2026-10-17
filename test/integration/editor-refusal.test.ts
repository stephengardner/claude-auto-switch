import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { loadConfig } from '../../src/config/config.js';
import { getActive, setActive } from '../../src/state/active.js';
import { markCapped, updateLedger } from '../../src/ledger/ledger.js';
import type { CliContext } from '../../src/context.js';
import type { PathCtx } from '../../src/config/paths.js';
import type { LimitProbeResult } from '../../src/usage/limit-probe.js';

/**
 * An editor chat whose account runs out while ccx's usage check is turned
 * away (a 429). The wrapper the editor's extension starts (ccx-claude) runs in
 * a process of its own, through tsx, exactly as the extension runs it: its
 * standard input and output are the chat's, passed to Claude untouched, and
 * the fake claude stands in for the extension's Claude, taking turns as
 * stream-json on standard input and staying up across them.
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
const capsIn = (home: string): Cap[] => {
  const file = path.join(home, 'ledger.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { caps: Cap[] }).caps : [];
};
/** Whose login the usage check was asked with, in order. */
const asked = (home: string): string[] => linesOf(path.join(home, 'asked.txt'));
/** Let the usage endpoint give an answer that waits for `name` (see wrapperScript). */
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
const recordOf = (home: string, account: string, conversation: string): string =>
  path.join(home, 'profiles', account, 'projects', 'fake-project', `${conversation}.jsonl`);

/** Accounts A and B, both signed in, the editor on A, and the usage endpoint answering as given. */
async function twoAccounts(
  prefix: string,
  usage: Record<string, Answer[]>,
): Promise<{ home: string; ctx: PathCtx }> {
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
    await addCommand(context, name, { dir, login: false });
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
    writeFileSync(
      path.join(dir, 'fake-scenario.json'),
      JSON.stringify({ authStatus: { loggedIn: true, subscriptionType: 'max', email: `${name}@example.com` } }),
      'utf8',
    );
  }
  setActive('A', ctx);
  writeFileSync(path.join(home, 'usage.json'), JSON.stringify(usage), 'utf8');
  return { home, ctx };
}

/**
 * The wrapper as the extension starts it, in a process of its own: ccx's
 * wrapperLaunch on `<claude> ...args`, with the usage endpoint answering from
 * `usage.json` (each account's answers in turn, the last one standing; one
 * with `waitFor` answers once that file appears in the home folder) and the
 * fake claude, which runs as `node`, counted as a Claude. It reads Claude's
 * records every 100 ms, or every EDITOR_FOLLOW_MS, and holds refused turns
 * back for 20 s after a check that confirms nothing, as production does, or
 * for EDITOR_REFUTE_BACKOFF_MS.
 */
function wrapperScript(home: string): string {
  const script = path.join(home, 'editor-wrapper.mts');
  const source = (...parts: string[]): string => JSON.stringify(pathToFileURL(path.join(REPO, ...parts)).href);
  writeFileSync(
    script,
    [
      `import { appendFileSync, existsSync, readFileSync } from 'node:fs';`,
      `import { EOL } from 'node:os';`,
      `import path from 'node:path';`,
      `import { wrapperLaunch } from ${source('src', 'commands', 'editor-launch.ts')};`,
      `import { loadConfig } from ${source('src', 'config', 'config.ts')};`,
      `import { processIsAlive } from ${source('src', 'session', 'lease.ts')};`,
      `const [home, fake, ...claudeArgs] = process.argv.slice(2);`,
      `const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };`,
      `const answers = JSON.parse(readFileSync(path.join(home, 'usage.json'), 'utf8'));`,
      `const probe = async (credentialsFile) => {`,
      `  const account = JSON.parse(readFileSync(credentialsFile, 'utf8')).account ?? '?';`,
      `  appendFileSync(path.join(home, 'asked.txt'), account + EOL);`,
      `  const queue = answers[account] ?? [];`,
      `  const answer = (queue.length > 1 ? queue.shift() : queue[0]) ?? { verdict: 'allowed', fiveHour: 0.1, sevenDay: 0.1 };`,
      `  const until = Date.now() + 30000;`,
      `  while (answer.waitFor && !existsSync(path.join(home, answer.waitFor)) && Date.now() < until) {`,
      `    await new Promise((resolve) => setTimeout(resolve, 25));`,
      `  }`,
      `  return answer;`,
      `};`,
      `const context = { ctx, config: loadConfig(ctx), claude: { bin: process.execPath, prefixArgs: [fake] },`,
      `  capProbe: probe, isClaudeProcess: processIsAlive, editorFollowMs: Number(process.env.EDITOR_FOLLOW_MS) || 100,`,
      `  refuteBackoffMs: Number(process.env.EDITOR_REFUTE_BACKOFF_MS) || undefined,`,
      `  out: () => {}, err: () => {}, json: false, quiet: false };`,
      `process.exit(await wrapperLaunch(context, [process.execPath, fake, ...claudeArgs]));`,
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
}

const opened: ChildProcess[] = [];

function openChat(home: string, chatArgs: string[], env: Record<string, string> = {}): Chat {
  const child = spawn(TSX, [wrapperScript(home), home, fakeClaude, ...EXTENSION_ARGS, ...chatArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, ...EDITOR_CLAUDE, ...env },
  });
  opened.push(child);
  let exitCode: number | null | undefined;
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      exitCode = code;
      resolve(code);
    }),
  );
  const results: unknown[] = [];
  let unread = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    unread += chunk;
    for (let end = unread.indexOf('\n'); end !== -1; end = unread.indexOf('\n')) {
      const line = unread.slice(0, end).trim();
      unread = unread.slice(end + 1);
      try {
        const event = JSON.parse(line) as { type?: unknown };
        if (event.type === 'result') results.push(event);
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
      await until(() => getActive(ctx) === 'B');

      // Before the chat ends: its one Claude is still answering turns.
      expect(chat.running()).toBe(true);
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: resetsAt * 1000 })]);
      expect(capsIn(home)[0]?.model).toBeUndefined();
      expect(getActive(ctx)).toBe('B');
      expect(asked(home)).toEqual(['A']);
      expect(verdicts(home)).toEqual([expect.stringMatching(confirmedByRefusal('five_hour'))]);
      expect(said(home, 'next editor chat will use B')).toBe(1);

      expect(await chat.close()).toBe(0);
      expect(capsIn(home)).toHaveLength(1);
    },
  );

  it(
    'follows a chat it resumes from where its record ended, so its history is not news',
    { timeout: 60_000 },
    async () => {
      const { home, ctx } = await twoAccounts('cas-editor-resumed-', { A: [TURNED_AWAY] });
      // Earlier turns of the chat: a refusal an hour ago, and one half a minute
      // ago, before this Claude started, on another process now gone.
      const record = recordOf(home, 'A', RESUMED);
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
      expect(readFileSync(recordOf(home, 'A', CLEARED), 'utf8')).toContain('"rateLimitType":"five_hour"');
      expect(readFileSync(recordOf(home, 'A', NEW_CHAT), 'utf8')).not.toContain('"rateLimitType":"five_hour"');
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

  it('records a limit once, however many turns Claude refuses on it', { timeout: 60_000 }, async () => {
    const { home, ctx } = await twoAccounts('cas-editor-twice-', { A: [TURNED_AWAY] });
    const chat = openChat(home, []);
    chat.send('hello');
    expect(await chat.answered(1)).toBe(true);
    await until(() => getActive(ctx) === 'B');
    // The person tries again on the same Claude, and it is refused again.
    chat.send('please');
    expect(await chat.answered(2)).toBe(true);
    // Long enough for ccx to have read that refusal several times over.
    await sleep(1_000);

    expect(asked(home)).toEqual(['A']);
    expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A' })]);
    expect(said(home, 'A hit its limit (editor)')).toBe(1);
    expect(said(home, 'next editor chat will use B')).toBe(1);
    expect(await chat.close()).toBe(0);
    expect(said(home, 'A hit its limit (editor)')).toBe(1);
  });

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
      });
      chat.send('hello');
      expect(await chat.answered(1)).toBe(true);
      await until(() => getActive(ctx) === 'B');
      expect(said(home, 'A hit its limit (editor)')).toBe(1);

      expect(await chat.close()).toBe(1);
      // The whole account is already recorded, so the words are not asked about.
      expect(asked(home)).toEqual(['A']);
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: resetsAt * 1000 })]);
      expect(said(home, 'A hit its limit (editor)')).toBe(1);
      expect(said(home, 'next editor chat will use B')).toBe(1);
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
      const { home } = await twoAccounts('cas-editor-again-', { A: [TURNED_AWAY] });
      const chat = openChat(home, []);
      const first = Math.floor(Date.now() / 1000) + 4;
      chat.send('hello', { resetsAt: first });
      expect(await chat.answered(1)).toBe(true);
      await until(() => said(home, 'A hit its limit (editor)') === 1);
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: first * 1000 })]);

      await until(() => Date.now() > first * 1000 + 300, 10_000);
      const second = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
      chat.send('hello again', { resetsAt: second });
      expect(await chat.answered(2)).toBe(true);
      await until(() => said(home, 'A hit its limit (editor)') === 2);

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
      const { home } = await twoAccounts('cas-editor-again-words-', { A: [TURNED_AWAY, OUT(later)] });
      const chat = openChat(home, [], {
        FAKE_CLAUDE_LAST_WORDS: "You've hit your session limit. Run /usage-credits to continue.",
        FAKE_CLAUDE_EXIT_CODE: '1',
      });
      const first = Math.floor(Date.now() / 1000) + 4;
      chat.send('hello', { resetsAt: first });
      expect(await chat.answered(1)).toBe(true);
      await until(() => said(home, 'A hit its limit (editor)') === 1);
      await until(() => Date.now() > first * 1000 + 300, 10_000);

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
