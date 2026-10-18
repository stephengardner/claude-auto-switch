#!/usr/bin/env node
// Fake `claude` for tests. Impersonates the subset of the real CLI that
// claude-auto-switch drives: `auth status`, `auth login`, and a generic run.
// Behavior is driven by a scenario JSON, resolved from FAKE_CLAUDE_SCENARIO or
// <CLAUDE_CONFIG_DIR>/fake-scenario.json. No network, no model spend, no logins.
import {
  readFileSync,
  writeFileSync,
  writeSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  rmSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? process.cwd();

// The options as the real CLI's parser (commander, in the 2.1.302 binary)
// reads them, written here on its own rather than taken from ccx, so a test
// sees what Claude would do with what ccx passed. Everything after `--` is an
// operand. An option that requires a value takes the next argument, whatever
// it is; an optional one takes it only when it is not another option; a list
// takes every argument up to the next option. Short options cluster (`-pc` is
// `-p -c`) up to one that takes a value, which takes the rest (`-dp` is
// `--debug p`).
const SHORT_OPTIONS = {
  p: '--print',
  c: '--continue',
  h: '--help',
  v: '--version',
  d: '--debug',
  r: '--resume',
  w: '--worktree',
  n: '--name',
};
// As the 2.1.302 binary declares them: `<value>` is required, `[value]` optional.
const REQUIRED_VALUE = new Set([
  '--agent',
  '--agents',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--autocompact',
  '--debug-file',
  '--effort',
  '--environment',
  '--fallback-model',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--max-turns',
  '--model',
  '--name',
  '--output-format',
  '--permission-mode',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--plugin-dir',
  '--plugin-url',
  '--remote-control-session-name-prefix',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--system-prompt',
  '--system-prompt-file',
  '--system-prompt-snapshot',
]);
const OPTIONAL_VALUE = new Set([
  '--resume',
  '--debug',
  '--worktree',
  '--from-pr',
  '--teleport',
  '--cloud',
  '--remote',
  '--remote-control',
  '--rc',
  '--prompt-suggestions',
]);
const LIST_VALUE = new Set([
  '--add-dir',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--mcp-config',
  '--betas',
  '--file',
]);
const looksLikeOption = (arg) => arg.length > 1 && arg.startsWith('-');
/** Each option by its long name (true when it took no value; a later one wins), and the operands. */
function parseCommandLine(argv) {
  const options = new Map();
  const operands = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      operands.push(...argv.slice(i + 1));
      break;
    }
    if (!looksLikeOption(arg)) {
      operands.push(arg);
      continue;
    }
    const take = (name, attached) => {
      if (attached !== undefined && attached !== '') return options.set(name, attached);
      if (REQUIRED_VALUE.has(name) && i + 1 < argv.length) return options.set(name, argv[++i]);
      if (OPTIONAL_VALUE.has(name) && i + 1 < argv.length && !looksLikeOption(argv[i + 1])) {
        return options.set(name, argv[++i]);
      }
      if (LIST_VALUE.has(name)) {
        const values = [];
        while (i + 1 < argv.length && !looksLikeOption(argv[i + 1])) values.push(argv[++i]);
        return options.set(name, values);
      }
      return options.set(name, true);
    };
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (eq === -1) take(arg);
      // Only an option that takes a value takes one this way; `--print=x` is
      // an option the real CLI does not know.
      else if (REQUIRED_VALUE.has(name) || OPTIONAL_VALUE.has(name) || LIST_VALUE.has(name)) {
        options.set(name, arg.slice(eq + 1));
      } else options.set(arg, true);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const name = SHORT_OPTIONS[arg[j]];
      if (name === undefined) break; // the real CLI refuses an option it does not know
      if (REQUIRED_VALUE.has(name) || OPTIONAL_VALUE.has(name)) {
        take(name, arg.slice(j + 1));
        break;
      }
      options.set(name, true);
    }
  }
  return { options, operands };
}
const parsed = parseCommandLine(args);
/** An option's value as Claude would read it: a string, or null when absent or given none. */
const valueOf = (name) => (typeof parsed.options.get(name) === 'string' ? parsed.options.get(name) : null);
/** What this run applies, as the real CLI would read its arguments. */
const applied = {
  print: parsed.options.has('--print'),
  continue: parsed.options.has('--continue'),
  resume: valueOf('--resume') ?? (parsed.options.has('--resume') ? true : null),
  sessionId: valueOf('--session-id'),
  fork: parsed.options.has('--fork-session'),
  model: valueOf('--model'),
  prompt: parsed.operands[0] ?? null,
};
// Turns arriving on standard input as stream-json, as the editor's extension
// (2.1.302) runs Claude: no `--print`, and the process stays up across turns
// until its input ends. Only with the records it keeps (see below).
const streamTurns =
  valueOf('--input-format') === 'stream-json' &&
  Boolean(process.env.FAKE_CLAUDE_SESSION_RECORD && process.env.FAKE_CLAUDE_TRANSCRIPT);

function loadScenario() {
  const explicit = process.env.FAKE_CLAUDE_SCENARIO;
  const perDir = path.join(configDir, 'fake-scenario.json');
  const file =
    explicit && existsSync(explicit) ? explicit : existsSync(perDir) ? perDir : null;
  if (!file) {
    return {
      authStatus: { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' },
      capped: false,
    };
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const scenario = loadScenario();

// claude auth status -> print the scenario auth JSON; exit 0 if logged in.
if (args[0] === 'auth' && args[1] === 'status') {
  const status = scenario.authStatus ?? { loggedIn: false, authMethod: 'none' };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exit(status.loggedIn ? 0 : 1);
}

// claude auth login -> simulate a successful login by marking this dir logged in.
if (args[0] === 'auth' && args[1] === 'login') {
  const loginResult = scenario.loginResult ?? {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: scenario.email ?? 'test@example.com',
    subscriptionType: scenario.plan ?? 'max',
  };
  writeJson(path.join(configDir, 'fake-scenario.json'), {
    ...scenario,
    authStatus: loginResult,
    capped: scenario.capped ?? false,
  });
  process.stdout.write('Logged in (fake).\n');
  process.exit(0);
}

// Any other invocation is a "run" (e.g. -p "..."). Honor a capped scenario.
if (scenario.capped) {
  process.stderr.write(`${scenario.capMessage ?? 'Usage limit reached. Try again later.'}\n`);
  process.exit(scenario.capExitCode ?? 1);
}

// Record the invocation so launcher tests can assert on args + config dir.
// Only into a config dir a test gave it: falling back to the working directory
// wrote this into the repository on every run that had none.
if (process.env.CLAUDE_CONFIG_DIR) {
  writeJson(path.join(configDir, 'fake-last-run.json'), { args, configDir });
}

// For hot-swap / in-place-switch tests: append each launch to a shared log,
// tagged with which account credential is present in the config dir, so a test
// can see the session move from one account to another.
const runsLog = process.env.FAKE_CLAUDE_RUNS_LOG;
const readMarker = () => {
  try {
    return JSON.parse(readFileSync(path.join(configDir, '.credentials.json'), 'utf8')).account ?? null;
  } catch {
    return null; // no credential present
  }
};
const readObject = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
// Print mode with an output format, as a worker runs it. The prompt is the
// first operand (see parseCommandLine). With no operand, it is standard input,
// and with neither, Claude refuses, as the real one does.
const printMode = applied.print;
const outputFormat = printMode ? valueOf('--output-format') : null;
// Print mode answering as text, with no format or `--output-format text`: the
// 2.1.302 binary prints the result once, on standard output, a refused turn's
// own words included, and draws nothing before it.
const textAnswer = printMode && (!outputFormat || outputFormat === 'text');
let printPrompt = null;
let promptVia = null;
if (outputFormat) {
  const operand = applied.prompt;
  if (operand !== null) {
    printPrompt = operand.trim();
    promptVia = 'arg';
  } else {
    try {
      printPrompt = readFileSync(0, 'utf8');
      promptVia = 'stdin';
    } catch {
      printPrompt = '';
    }
  }
}
/**
 * With FAKE_CLAUDE_LOG_FOLDER, what the folder it runs in holds of the user's
 * Claude, as it would read it: where its projects and skills land, its
 * settings, and who its state says it is signed in as.
 */
const describeFolder = () => {
  const landsAt = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  return {
    configDir: landsAt(configDir),
    projects: landsAt(path.join(configDir, 'projects')),
    skills: landsAt(path.join(configDir, 'skills')),
    settings: readObject(path.join(configDir, 'settings.json')),
    email: readObject(path.join(configDir, '.claude.json')).oauthAccount?.emailAddress ?? null,
  };
};
if (runsLog) {
  // The model the session was given in its settings, as Claude would read it.
  const settingsModel = readObject(path.join(configDir, 'settings.json')).model ?? null;
  appendFileSync(
    runsLog,
    `${JSON.stringify({
      type: 'launch',
      args,
      marker: readMarker(),
      settingsModel,
      ...(outputFormat ? { prompt: printPrompt, via: promptVia, cwd: process.cwd() } : {}),
      // What the real CLI would make of the arguments, and whether ccx gave it
      // a terminal (a session) or pipes (a print-mode run it reads).
      applied,
      tty: Boolean(process.stdout.isTTY),
      pid: process.pid,
      // What it would sign in with, besides the session folder.
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
      ...(process.env.FAKE_CLAUDE_LOG_FOLDER ? { folder: describeFolder() } : {}),
    })}\n`,
    'utf8',
  );
}
// The real CLI's refusal of a conversation id beside a resume or a continue
// that makes no copy (2.1.299 and 2.1.302), before it does anything else.
if (applied.sessionId !== null && (applied.continue || applied.resume !== null) && !applied.fork) {
  process.stderr.write(
    'Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.\n',
  );
  process.exit(1);
}
/** The conversation this run is in, which print mode reports as Claude does, flag or none. */
const printSession = () =>
  applied.sessionId ??
  valueOf('--resume') ??
  process.env.FAKE_CLAUDE_LANDS_ON ??
  '00000000-0000-4000-8000-000000000000';
/**
 * The answer a print-mode run gives as it ends normally, then `done`. Only
 * once it is written out: a pipe on macOS takes writes asynchronously, and
 * exiting straight after a long answer cut it off.
 */
const printResult = (done) => {
  if (!outputFormat) return done();
  const result = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: `done: ${printPrompt}`,
    session_id: printSession(),
    num_turns: 1,
  };
  const text =
    outputFormat === 'json'
      ? `${JSON.stringify(result)}\n`
      : outputFormat === 'stream-json'
        ? `${JSON.stringify({ type: 'system', subtype: 'init', session_id: printSession() })}\n${JSON.stringify(result)}\n`
        : `done: ${printPrompt}\n`;
  if (!process.env.FAKE_CLAUDE_SPLIT_ANSWER) {
    process.stdout.write(text, () => done());
    return;
  }
  // In two writes a moment apart, split inside the first character that
  // takes more than one byte, so the reader gets half a character per read.
  const bytes = Buffer.from(text, 'utf8');
  const lead = bytes.findIndex((b) => b >= 0xc0);
  const cut = lead >= 0 ? lead + 1 : Math.floor(bytes.length / 2);
  writeSync(1, bytes.subarray(0, cut));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  writeSync(1, bytes.subarray(cut));
  done();
};
// The real CLI's answer to print mode with no prompt at all.
if (outputFormat && !printPrompt) {
  process.stderr.write('Error: Input must be provided either through stdin or as a prompt argument when using --print\n');
  process.exit(1);
}
const firstLaunch = applied.resume === null;
// A process Claude started (a test run, a dev server) that would run on after
// it: its pid goes to the named file. Holding Claude's own output open, when
// asked, as one that inherited it would. On Windows it is outside the job
// Claude itself sits in, as the commands Claude's Bash tool runs are
// (measured: ending Claude's parent outright ends Claude, not those).
if (process.env.FAKE_CLAUDE_GRANDCHILD && firstLaunch) {
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
    stdio: process.env.FAKE_CLAUDE_GRANDCHILD_STDIO === 'inherit' ? 'inherit' : 'ignore',
    detached: process.platform === 'win32',
    windowsHide: true,
  });
  writeFileSync(process.env.FAKE_CLAUDE_GRANDCHILD, String(grandchild.pid), 'utf8');
}
// A Claude that does not stop when asked to.
if (process.env.FAKE_CLAUDE_IGNORE_TERM && firstLaunch) {
  process.on('SIGTERM', () => {});
}
// One that says, in the runs log, that it was asked to stop, then stops as a
// process ended by SIGTERM reports it.
if (process.env.FAKE_CLAUDE_NOTE_TERM && runsLog) {
  process.on('SIGTERM', () => {
    appendFileSync(runsLog, `${JSON.stringify({ type: 'signal', signal: 'SIGTERM' })}\n`, 'utf8');
    process.exit(143);
  });
}
// Half an event, cut off by the end of the launch, as a kill mid-write leaves it.
if (process.env.FAKE_CLAUDE_PARTIAL_LINE && outputFormat === 'stream-json' && firstLaunch) {
  process.stdout.write('{"type":"assistant","message":{"content":"cut off mid');
}

// What Claude itself writes into its config folder during a run: a model picked
// with /model, a theme, a folder trusted. Merged in, as Claude would save them.
if (process.env.CLAUDE_CONFIG_DIR) {
  for (const [variable, name] of [
    ['FAKE_CLAUDE_SET_SETTINGS', 'settings.json'],
    ['FAKE_CLAUDE_SET_STATE', '.claude.json'],
  ]) {
    if (!process.env[variable]) continue;
    const file = path.join(configDir, name);
    writeJson(file, { ...readObject(file), ...JSON.parse(process.env[variable]) });
  }
}
// On standard error in print mode with a format, and for turns over
// stream-json: standard output there is the answer, and a program reads it.
(outputFormat || streamTurns ? process.stderr : process.stdout).write(`fake-claude ran: ${args.join(' ')}\n`);

// Arbitrary output at start, standing in for a replayed conversation.
if (process.env.FAKE_CLAUDE_SAY) process.stdout.write(`${process.env.FAKE_CLAUDE_SAY}\n`);

// The real CLI's answer to resuming a conversation that was never written (a
// swap before the first message): a message on stderr and exit 1, at once.
const resumed = valueOf('--resume');
if (process.env.FAKE_CLAUDE_NOTHING_TO_RESUME && resumed) {
  process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
  process.exit(1);
}

// A fork is only saved with its first message. With this set, every fork this
// fake starts is remembered as unsaved, and resuming one by its own id finds
// nothing, as with the real CLI when a swap lands before that message.
if (process.env.FAKE_CLAUDE_UNSAVED_FORKS) {
  const unsaved = path.join(configDir, 'unsaved-forks.txt');
  if (applied.fork && applied.sessionId !== null) {
    appendFileSync(unsaved, `${applied.sessionId}\n`, 'utf8');
  } else if (resumed && existsSync(unsaved) && readFileSync(unsaved, 'utf8').split('\n').includes(resumed)) {
    process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
    process.exit(1);
  }
}

// The real CLI's own record of which conversation this process is in, at
// <config dir>/sessions/<pid>.json, written once it is up, rewritten on every
// switch (/clear, /resume, a pick from the picker) and deleted on exit.
// Measured against the real binary: a fork records its --session-id, a resume
// the resumed id, --continue or the picker whatever it lands on.
if (process.env.FAKE_CLAUDE_SESSION_RECORD) {
  const record = path.join(configDir, 'sessions', `${process.pid}.json`);
  const startedAt = Date.now();
  // What Claude says it is doing, as 2.1.296 keeps it (measured): "idle" at
  // an empty prompt, "shell" there while a background command runs, "busy"
  // during a turn or while a subagent runs, "waiting" behind a dialog.
  // FAKE_CLAUDE_STATUS is what it rests in; with FAKE_CLAUDE_IDLE_STATUS it
  // has been idle a minute already. With neither set it says nothing.
  let resting = process.env.FAKE_CLAUDE_STATUS ?? null;
  /** A turn started by a typed prompt is running. */
  let turnRunning = false;
  let doing = process.env.FAKE_CLAUDE_IDLE_STATUS
    ? { status: 'idle', statusUpdatedAt: Date.now() - 60_000 }
    : resting
      ? { status: resting, statusUpdatedAt: Date.now() }
      : {};
  let recordedId =
    applied.sessionId ??
    valueOf('--resume') ??
    process.env.FAKE_CLAUDE_LANDS_ON ??
    '00000000-0000-4000-8000-000000000000';
  // When this process started, as Claude 2.1.302 records it off Windows
  // (`LC_ALL=C TZ=UTC ps -o lstart= -p <pid>`), to tell it from a later
  // process given the same pid.
  let procStart;
  if (process.platform !== 'win32') {
    try {
      const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
        encoding: 'utf8',
        timeout: 1000,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      });
      if (ps.status === 0 && ps.stdout.trim() !== '') procStart = ps.stdout.trim();
    } catch {
      /* written without one, as an older Claude does */
    }
  }
  // With FAKE_CLAUDE_SESSION_RECORD_AFTER_MS the record is first written that
  // late, as when Claude has taken its first turn before it registers itself.
  const registerAfter = Number(process.env.FAKE_CLAUDE_SESSION_RECORD_AFTER_MS) || 0;
  let registered = registerAfter === 0;
  const writeRecord = (sessionId) => {
    recordedId = sessionId;
    if (!registered) return;
    writeJson(record, {
      pid: process.pid,
      sessionId,
      cwd: process.cwd(),
      startedAt,
      ...(procStart ? { procStart } : {}),
      kind: 'interactive',
      ...doing,
    });
  };
  const setStatus = (status) => {
    if (!status) return;
    doing = { status, statusUpdatedAt: Date.now() };
    writeRecord(recordedId);
    if (runsLog) appendFileSync(runsLog, `${JSON.stringify({ type: 'status', status })}\n`, 'utf8');
  };
  writeRecord(recordedId);
  if (!registered) {
    const t = setTimeout(() => {
      registered = true;
      writeRecord(recordedId);
    }, registerAfter);
    if (t.unref) t.unref();
  }
  // A change of what it rests in, "<ms>:<status>": a subagent finishing
  // ("1500:idle"), a dialog opening.
  if (process.env.FAKE_CLAUDE_STATUS_THEN) {
    const [after, next] = process.env.FAKE_CLAUDE_STATUS_THEN.split(':');
    const t = setTimeout(() => {
      resting = next;
      if (!turnRunning) setStatus(next);
    }, Number(after));
    if (t.unref) t.unref();
  }

  // The login this process is using. Claude reads the login in its config
  // folder again before a request once the file has changed; with
  // FAKE_CLAUDE_OLD_LOGIN_REQUESTS it goes on using the one it had for that
  // many requests first, as a login it still holds in a cache.
  const credentialStamp = () => {
    try {
      return statSync(path.join(configDir, '.credentials.json')).mtimeMs;
    } catch {
      return 0;
    }
  };
  let login = { marker: readMarker(), stamp: credentialStamp() };
  let staleRequests = Number(process.env.FAKE_CLAUDE_OLD_LOGIN_REQUESTS) || 0;
  const loginForRequest = () => {
    const stamp = credentialStamp();
    if (stamp !== login.stamp) {
      if (staleRequests > 0) staleRequests -= 1;
      else login = { marker: readMarker(), stamp };
    }
    return login.marker;
  };
  const refusedOn = (marker) =>
    (process.env.FAKE_CLAUDE_REFUSE_ON ?? '').split(',').filter(Boolean).includes(marker ?? '');
  /**
   * A refused turn as Claude writes one for an account out of its usage limit:
   * "usage_limit_reached" is the API's code for it from 2.1.292 on (measured
   * up to 2.1.302). A subagent's carries its own marks. With
   * FAKE_CLAUDE_REFUSAL_AGE_MS it carries a time that long ago, as an entry
   * copied into a new record from an older one (a fork, a record Claude
   * wrote again) still carries its own.
   */
  /**
   * The limit a refusal names, as Claude 2.1.29x writes it: its type
   * (FAKE_CLAUDE_LIMIT_TYPE, five_hour by default) and when it resets in
   * epoch seconds (FAKE_CLAUDE_RESETS_AT, an hour on by default, "none" for
   * no time). `turn` names either for one refusal instead.
   */
  const rateLimitInfo = (turn = {}) => {
    const resets = turn.resetsAt !== undefined ? String(turn.resetsAt) : process.env.FAKE_CLAUDE_RESETS_AT;
    return {
      status: 'rejected',
      rateLimitType: turn.limitType ?? process.env.FAKE_CLAUDE_LIMIT_TYPE ?? 'five_hour',
      ...(resets === 'none' ? {} : { resetsAt: resets ? Number(resets) : Math.floor(Date.now() / 1000) + 3600 }),
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false,
    };
  };
  const refusalEntry = (extra = {}, turn = {}) => ({
    type: 'assistant',
    isSidechain: false,
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiError: 'usage_limit_reached',
    apiErrorStatus: 429,
    apiErrorParams: { rate_limit_info: rateLimitInfo(turn) },
    timestamp: new Date(Date.now() - (Number(process.env.FAKE_CLAUDE_REFUSAL_AGE_MS) || 0)).toISOString(),
    message: {
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text: 'Out of room on this account for now.' }],
    },
    ...extra,
  });
  /**
   * A turn refused because the login no longer works, as Claude writes one
   * (measured): its own code, no HTTP status, "Please run /login". Written in
   * place of a limit when FAKE_CLAUDE_REFUSE_AS is "signed-out".
   */
  const signedOutEntry = () => ({
    type: 'assistant',
    isSidechain: false,
    isApiErrorMessage: true,
    error: 'authentication_failed',
    timestamp: new Date().toISOString(),
    message: {
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text: 'Login expired · Please run /login' }],
    },
  });

  // The conversation's own record, at <config dir>/projects/<folder>/<id>.jsonl
  // where the real CLI keeps it. A refused turn is written the way Claude
  // 2.1.284 writes one (measured): an answer flagged isApiErrorMessage, with
  // Claude's code, the API's code and the HTTP status.
  if (process.env.FAKE_CLAUDE_TRANSCRIPT) {
    const transcript = path.join(configDir, 'projects', 'fake-project', `${recordedId}.jsonl`);
    mkdirSync(path.dirname(transcript), { recursive: true });
    appendFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
    /**
     * A limit refusal of its own, shown as Claude shows one: in its terminal,
     * or, with FAKE_CLAUDE_STREAM_REFUSALS, as an event in stream-json. One
     * another Claude writes into the same record is never shown here.
     */
    const showRefusal = (entry) => {
      const text = entry.message.content[0].text;
      if (textAnswer) return; // printed as the run's answer when it ends, below
      if (!outputFormat && process.env.FAKE_CLAUDE_DRAW_BY_CELLS) {
        // As Claude 2.1.302 draws: only the cells that changed, each moved to
        // in turn, here from the last to the first, so the text never goes
        // out in order.
        const row = 12;
        for (let i = text.length - 1; i >= 0; i--) process.stdout.write(`\x1b[${row};${i + 3}H${text[i]}`);
      } else if (!outputFormat) process.stdout.write(`${text}\n`);
      else if (outputFormat === 'stream-json' && process.env.FAKE_CLAUDE_STREAM_REFUSALS) {
        process.stdout.write(`${JSON.stringify({ type: 'assistant', message: entry.message, session_id: printSession() })}\n`);
      }
    };
    // A prompt somebody typed, recorded at a set time, as Claude records one.
    const promptAfter = Number(process.env.FAKE_CLAUDE_PROMPT_AFTER_MS) || 0;
    if (promptAfter > 0) {
      const t = setTimeout(() => {
        const prompt = {
          type: 'user',
          isSidechain: false,
          origin: { kind: 'human' },
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'and one more thing' },
        };
        appendFileSync(transcript, `${JSON.stringify(prompt)}\n`);
      }, promptAfter);
      if (t.unref) t.unref();
    }
    // Only on the accounts named, when some are: an account with room does
    // not refuse.
    const refuseOn = process.env.FAKE_CLAUDE_REFUSE_ON;
    const refusesHere = !refuseOn || refuseOn.split(',').includes(readMarker() ?? '');
    // Claude's own usage-limit menu, which it opens by itself on a limit
    // (measured, 2.1.280) when FAKE_CLAUDE_LIMIT_MENU is set: it says "waiting"
    // while open, a key is a choice in it rather than text, and Esc closes it.
    let menuOpen = false;
    const openLimitMenu = () => {
      if (!process.env.FAKE_CLAUDE_LIMIT_MENU || menuOpen) return;
      menuOpen = true;
      process.stdout.write(
        '\r\n❯ /rate-limit-options\r\n  What do you want to do?\r\n' +
          '  ❯ 1. Stop and wait for limit to reset\r\n' +
          '    2. Wait here, then continue automatically at Oct 22, 1pm\r\n' +
          '    3. Switch to usage credits\r\n',
      );
      setStatus('waiting');
      if (runsLog) appendFileSync(runsLog, `${JSON.stringify({ type: 'menu', open: true })}\n`, 'utf8');
    };
    const closeLimitMenu = () => {
      menuOpen = false;
      setStatus(resting ?? 'idle');
      if (runsLog) appendFileSync(runsLog, `${JSON.stringify({ type: 'menu', open: false })}\n`, 'utf8');
    };
    // With FAKE_CLAUDE_REFUSALS_AT_ONCE, that many refused turns a millisecond
    // apart in one write, as when somebody tries again before anyone has read
    // the record: whoever reads it next reads them together.
    const atOnce = Math.max(1, Number(process.env.FAKE_CLAUDE_REFUSALS_AT_ONCE) || 1);
    const refuse = () => {
      if (!refusesHere) return;
      const signedOut = process.env.FAKE_CLAUDE_REFUSE_AS === 'signed-out';
      const entry = signedOut ? signedOutEntry() : refusalEntry();
      const at = Date.parse(entry.timestamp);
      const entries = Array.from({ length: atOnce }, (_, i) => ({ ...entry, timestamp: new Date(at + i).toISOString() }));
      appendFileSync(transcript, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
      if (!signedOut) {
        showRefusal(entry);
        openLimitMenu();
      }
      // Print mode ends the run on a refused turn, with an error result and
      // exit 1, where the terminal app stays up and waits. As text, the
      // result is the refusal's own words.
      if (process.env.FAKE_CLAUDE_REFUSAL_ENDS_RUN && printMode) {
        const failed = {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'Out of room on this account for now.',
          session_id: printSession(),
        };
        const answer = textAnswer ? failed.result : JSON.stringify(failed);
        process.stdout.write(`${answer}\n`, () => process.exit(1));
      }
    };
    const after = Number(process.env.FAKE_CLAUDE_REFUSE_AFTER_MS) || 0;
    if (after > 0) {
      const t = setTimeout(refuse, after);
      if (t.unref) t.unref();
    }
    // A second refusal, as when the operator tries again.
    const again = Number(process.env.FAKE_CLAUDE_REFUSE_AGAIN_AFTER_MS) || 0;
    if (again > 0) {
      const t = setTimeout(refuse, again);
      if (t.unref) t.unref();
    }
    // Refused once a file the test names appears, rather than at a set time:
    // after something the test waits for has happened, however slow the
    // machine is to get there.
    const refuseWhen = process.env.FAKE_CLAUDE_REFUSE_WHEN;
    if (refuseWhen) {
      const t = setInterval(() => {
        if (!existsSync(refuseWhen)) return;
        clearInterval(t);
        refuse();
      }, 50);
      if (t.unref) t.unref();
    }

    // A subagent's turn refused, in the record Claude 2.1.296 keeps for each
    // subagent beside the conversation's own (measured). Only on an account
    // FAKE_CLAUDE_REFUSE_ON names, by the login in use at that moment. A
    // second subagent can meet it too, later.
    for (const [variable, agentId] of [
      ['FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS', 'afake01'],
      ['FAKE_CLAUDE_SUBAGENT_REFUSE_AGAIN_AFTER_MS', 'afake02'],
    ]) {
      const after = Number(process.env[variable]) || 0;
      if (after <= 0) continue;
      const t = setTimeout(() => {
        const marker = loginForRequest();
        if (!refusedOn(marker)) return;
        const file = path.join(path.dirname(transcript), recordedId, 'subagents', `agent-${agentId}.jsonl`);
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify(refusalEntry({ isSidechain: true, agentId }))}\n`);
        if (runsLog) appendFileSync(runsLog, `${JSON.stringify({ type: 'subagent-refusal', marker })}\n`, 'utf8');
      }, after);
      if (t.unref) t.unref();
    }

    // A subagent at work: its record grows every 300ms until the given time,
    // and the log says when it finished, which it only can if nothing ended it.
    const workingUntil = Number(process.env.FAKE_CLAUDE_SUBAGENT_WRITES_UNTIL_MS) || 0;
    if (workingUntil > 0) {
      const file = path.join(path.dirname(transcript), recordedId, 'subagents', 'agent-aworker.jsonl');
      mkdirSync(path.dirname(file), { recursive: true });
      const step = () =>
        appendFileSync(
          file,
          `${JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'aworker', timestamp: new Date().toISOString() })}\n`,
        );
      // At once, so the record is there before anyone first looks at it.
      step();
      const working = setInterval(() => {
        step();
        if (Date.now() - startedAt < workingUntil) return;
        clearInterval(working);
        if (runsLog) appendFileSync(runsLog, `${JSON.stringify({ type: 'subagent-done' })}\n`, 'utf8');
      }, 300);
      if (working.unref) working.unref();
    }

    // What is typed at it. Like Claude it asks the terminal to mark pastes,
    // takes a marked paste as text, and sends what is in its input box on
    // Enter: recorded as a prompt somebody typed, then answered, or refused
    // when the login in use is one FAKE_CLAUDE_REFUSE_ON names.
    if (process.env.FAKE_CLAUDE_READS_INPUT) {
      process.stdout.write('\x1b[?2004h');
      const PASTE_START = '\x1b[200~';
      const PASTE_END = '\x1b[201~';
      let box = '';
      let pending = '';
      let pasting = false;
      let answered = 0;
      const submit = () => {
        const text = box;
        box = '';
        if (text === '') return;
        const marker = loginForRequest();
        const refused = refusedOn(marker);
        appendFileSync(
          transcript,
          `${JSON.stringify({
            type: 'user',
            isSidechain: false,
            origin: { kind: 'human' },
            timestamp: new Date().toISOString(),
            message: { role: 'user', content: text },
          })}\n`,
        );
        if (runsLog) {
          appendFileSync(runsLog, `${JSON.stringify({ type: 'prompt', text, marker, refused, pid: process.pid })}\n`, 'utf8');
        }
        turnRunning = true;
        setStatus('busy');
        setTimeout(() => {
          const answer = refused
            ? refusalEntry()
            : {
                type: 'assistant',
                isSidechain: false,
                timestamp: new Date().toISOString(),
                message: { role: 'assistant', content: [{ type: 'text', text: 'carrying on' }] },
              };
          appendFileSync(transcript, `${JSON.stringify(answer)}\n`);
          if (refused) showRefusal(answer);
          turnRunning = false;
          setStatus(resting);
          if (refused) openLimitMenu();
          if (!refused) answered += 1;
          // Done once it has answered as many prompts as the test waits for,
          // after a moment for whoever is watching to see the answer.
          if (answered === Number(process.env.FAKE_CLAUDE_EXIT_AFTER_PROMPTS)) {
            setTimeout(() => {
              if (runsLog) appendFileSync(runsLog, `${JSON.stringify({ type: 'reread', marker: readMarker() })}\n`, 'utf8');
              process.exit(0);
            }, Number(process.env.FAKE_CLAUDE_EXIT_DELAY_MS) || 300);
          }
        }, Number(process.env.FAKE_CLAUDE_TURN_MS) || 100);
      };
      const read = () => {
        for (;;) {
          if (pasting) {
            const end = pending.indexOf(PASTE_END);
            if (end === -1) return; // the rest of the paste is still to come
            box += pending.slice(0, end);
            pending = pending.slice(end + PASTE_END.length);
            pasting = false;
            continue;
          }
          if (pending === '') return;
          if (pending.startsWith(PASTE_START)) {
            pending = pending.slice(PASTE_START.length);
            pasting = true;
            continue;
          }
          // A marker cut in two by the read: wait for the rest of it.
          if (PASTE_START.startsWith(pending)) return;
          const key = pending[0];
          pending = pending.slice(1);
          if (key === '\r') submit();
          else if (key >= ' ' && key !== '\x7f') box += key;
        }
      };
      try {
        process.stdin.setRawMode?.(true);
      } catch {
        /* not a terminal */
      }
      process.stdin.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        // The menu takes every key while it is open: Esc closes it, and
        // anything else is a choice in it, never text in the input box.
        if (menuOpen) {
          if (text === '\x1b') closeLimitMenu();
          else if (runsLog) appendFileSync(runsLog, `${JSON.stringify({ type: 'menu-key', text })}\n`, 'utf8');
          return;
        }
        pending += text;
        read();
      });
      process.stdin.resume();
    }

    // Turns over stream-json (streamTurns), one user message per line in and
    // its answer as events out. Each prompt goes into the record of the
    // conversation the process is in now, marked typed by a person when the
    // message says so (the editor's webview sends `origin: { kind: "human" }`,
    // and 2.1.302 keeps it), and the turn is refused when the login in use is
    // one FAKE_CLAUDE_REFUSE_ON names. "/clear" moves the process to a new
    // conversation, the next of FAKE_CLAUDE_CLEAR_TO. With
    // FAKE_CLAUDE_PROMPT_WITH_REFUSAL a refusal is written with a prompt typed
    // just after it, in one write, as when the person tried again before
    // anyone read the record. FAKE_CLAUDE_LAST_WORDS is written to standard
    // error as the input ends.
    if (streamTurns) {
      const recordNow = (entries) => {
        const file = path.join(configDir, 'projects', 'fake-project', `${recordedId}.jsonl`);
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
      };
      const say = (event) => process.stdout.write(`${JSON.stringify({ ...event, session_id: recordedId })}\n`);
      const textOf = (content) =>
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
            : '';
      const clearTo = (process.env.FAKE_CLAUDE_CLEAR_TO ?? '').split(',').filter(Boolean);
      const turn = (message) =>
        new Promise((done) => {
          const text = textOf(message.message?.content);
          if (text.trim() === '/clear') {
            writeRecord(clearTo.shift() ?? randomUUID());
            say({ type: 'result', subtype: 'success', is_error: false, result: 'cleared' });
            done();
            return;
          }
          // What a test asks of this one turn (`fake`): the limit its refusal
          // names and when that resets (`limitType`, `resetsAt` in epoch
          // seconds), or that a subagent meets it (`subagent`), whose record is
          // its own and whose prompt nobody typed.
          const asked = message.fake ?? {};
          const subagent = asked.subagent === true;
          if (!subagent) {
            recordNow([
              {
                type: 'user',
                isSidechain: false,
                ...(message.origin?.kind === 'human' ? { origin: { kind: 'human' } } : {}),
                timestamp: new Date().toISOString(),
                message: { role: 'user', content: text },
              },
            ]);
          }
          setStatus('busy');
          setTimeout(() => {
            const marker = loginForRequest();
            const refused = refusedOn(marker);
            const answer = refused
              ? refusalEntry(subagent ? { isSidechain: true, agentId: 'aturn01' } : {}, asked)
              : {
                  type: 'assistant',
                  isSidechain: false,
                  timestamp: new Date().toISOString(),
                  message: { role: 'assistant', content: [{ type: 'text', text: 'carrying on' }] },
                };
            const typedAfter =
              refused && process.env.FAKE_CLAUDE_PROMPT_WITH_REFUSAL
                ? [
                    {
                      type: 'user',
                      isSidechain: false,
                      origin: { kind: 'human' },
                      timestamp: new Date(Date.parse(answer.timestamp) + 1).toISOString(),
                      message: { role: 'user', content: 'trying again' },
                    },
                  ]
                : [];
            if (subagent) {
              const main = path.join(configDir, 'projects', 'fake-project', `${recordedId}.jsonl`);
              const file = path.join(path.dirname(main), recordedId, 'subagents', 'agent-aturn01.jsonl');
              mkdirSync(path.dirname(file), { recursive: true });
              appendFileSync(file, `${JSON.stringify(answer)}\n`);
            } else {
              recordNow([answer, ...typedAfter]);
            }
            if (runsLog) {
              appendFileSync(runsLog, `${JSON.stringify({ type: 'prompt', text, marker, refused, pid: process.pid })}\n`, 'utf8');
            }
            say({ type: 'assistant', message: answer.message });
            say({ type: 'result', subtype: 'success', is_error: refused, result: answer.message.content[0].text });
            setStatus(resting ?? 'idle');
            done();
          }, Number(process.env.FAKE_CLAUDE_TURN_MS) || 100);
        });
      // One turn at a time, in the order they came, as Claude takes them.
      let turns = Promise.resolve();
      let unread = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        unread += chunk;
        for (let end = unread.indexOf('\n'); end !== -1; end = unread.indexOf('\n')) {
          const line = unread.slice(0, end).trim();
          unread = unread.slice(end + 1);
          let message = null;
          try {
            message = line === '' ? null : JSON.parse(line);
          } catch {
            message = null;
          }
          if (message?.type === 'user') turns = turns.then(() => turn(message));
        }
      });
      process.stdin.on('end', () => {
        void turns.then(() => {
          const code = Number(process.env.FAKE_CLAUDE_EXIT_CODE) || 0;
          const last = process.env.FAKE_CLAUDE_LAST_WORDS;
          // Once written out: a pipe takes writes asynchronously.
          if (last) process.stderr.write(`${last}\n`, () => process.exit(code));
          else process.exit(code);
        });
      });
      say({ type: 'system', subtype: 'init' });
    }
  }
  // A conversation switch made inside the session (a /clear), at human speed,
  // or once a file the test names appears (FAKE_CLAUDE_SWITCH_WHEN).
  const switchTo = process.env.FAKE_CLAUDE_SWITCH_TO;
  const switchWhen = process.env.FAKE_CLAUDE_SWITCH_WHEN;
  if (switchTo && switchWhen) {
    const t = setInterval(() => {
      if (!existsSync(switchWhen)) return;
      clearInterval(t);
      writeRecord(switchTo);
    }, 50);
    if (t.unref) t.unref();
  } else if (switchTo) {
    const t = setTimeout(() => writeRecord(switchTo), Number(process.env.FAKE_CLAUDE_SWITCH_AFTER_MS) || 200);
    if (t.unref) t.unref();
  }
  process.on('exit', () => {
    try {
      rmSync(record, { force: true });
    } catch {
      /* gone */
    }
  });
}

// Simulate a resume that has nothing to resume. Only on --continue, exactly as
// the real CLI does, so the fresh retry that follows does NOT emit it again and
// the test cannot loop.
if (process.env.FAKE_CLAUDE_NO_CONVERSATION && applied.continue) {
  process.stdout.write('No conversation found to continue\n');
}

// Simulate a --continue replay re-rendering the PREVIOUS account's cap message.
// The watcher must NOT treat this as a fresh cap while the user has not typed
// (that is the false-cap cascade this guards against).
if (process.env.FAKE_CLAUDE_EMIT_CAP) {
  process.stdout.write("You've reached your Fable 5 limit. Run /usage-credits to continue.\n");
}

// Keep hitting the same wall, which is what a real one does: the operator
// tries again and the message comes back. A single emission can reproduce a
// session that was refused once, never one that is STUCK.
const capEvery = Number(process.env.FAKE_CLAUDE_CAP_EVERY_MS) || 0;
// Started late when asked, so a test can have ccx reading the conversation's
// own record before any of it reaches the screen.
const capFrom = Date.now() + (Number(process.env.FAKE_CLAUDE_CAP_AFTER_MS) || 0);
// With FAKE_CLAUDE_LOG_CAP_WORDS each showing goes to the runs log once it is
// written out, so a test can count how many times ccx was shown the words.
const logCapWords = Boolean(runsLog && process.env.FAKE_CLAUDE_LOG_CAP_WORDS);
// FAKE_CLAUDE_CAP_WORDS shows other words instead, such as another version's.
const capWords =
  process.env.FAKE_CLAUDE_CAP_WORDS ?? 'You have reached your Fable 5 limit. Run /usage-credits to continue.';
if (capEvery > 0) {
  const t = setInterval(() => {
    if (Date.now() < capFrom) return;
    process.stdout.write(`${capWords}\n`, () => {
      if (logCapWords) appendFileSync(runsLog, `${JSON.stringify({ type: 'cap-words' })}\n`, 'utf8');
    });
  }, capEvery);
  if (t.unref) t.unref();
}

// Calls of the Artifact tool, made the way the real CLI makes them (measured
// on 2.1.296): the hooks in the session's settings whose matcher is "Artifact"
// are run as a program and its arguments, the call's description on standard
// input, before the call and after it (PostToolUseFailure when it failed). A
// "deny" from a before-hook stops the call. Which account's login was in the
// session's folder when the call went out, and when it was over, goes to the
// runs log: that is the account a page would have been published as.
// After every call, as after every batch of tool calls, the PostToolBatch hooks
// run before the next model request, which is noted at once with the login it
// would go out on. FAKE_CLAUDE_ARTIFACT is a JSON list of calls: { afterMs, id,
// input, response?, fail?, takesMs?, skipAfterHook?, writeResult?,
// refuseDuring?, sayDuring?, deniedByOtherHook?, loginToKeychain? }. deniedByOtherHook: another
// PreToolUse hook (the person's own) refuses the call after ccx's has run, as a
// permission rule or plan mode can, so no after-hook runs for it.
if (process.env.FAKE_CLAUDE_ARTIFACT && firstLaunch) {
  const sessionId = applied.sessionId ?? valueOf('--resume') ?? '00000000-0000-4000-8000-000000000000';
  const transcript = path.join(configDir, 'projects', 'fake-project', `${sessionId}.jsonl`);
  const note = (entry) => {
    if (runsLog) appendFileSync(runsLog, `${JSON.stringify(entry)}\n`, 'utf8');
  };
  // A later time on the login file at a call than at the start means ccx told
  // Claude to read the login again in between.
  const loginTime = () => {
    try {
      return statSync(path.join(configDir, '.credentials.json')).mtimeMs;
    } catch {
      return 0;
    }
  };
  const loginTimeAtStart = loginTime();
  const record = (entry) => {
    mkdirSync(path.dirname(transcript), { recursive: true });
    appendFileSync(transcript, `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, 'utf8');
  };
  const hooksFor = (event) => {
    const groups = readObject(path.join(configDir, 'settings.json')).hooks?.[event];
    return (Array.isArray(groups) ? groups : [])
      .filter((group) => group?.matcher === 'Artifact')
      .flatMap((group) => (Array.isArray(group.hooks) ? group.hooks : []));
  };
  /** Run one hook and give back what it printed, parsed when it is JSON. */
  const runHook = (hook, input) =>
    new Promise((resolve) => {
      const child = spawn(hook.command, hook.args ?? [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('error', () => resolve(null));
      child.on('close', () => {
        try {
          resolve(JSON.parse(out));
        } catch {
          resolve(null);
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
    });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** PostToolBatch has no matcher: every hook under it runs, after every batch. */
  const batchHooks = () => {
    const groups = readObject(path.join(configDir, 'settings.json')).hooks?.PostToolBatch;
    return (Array.isArray(groups) ? groups : []).flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []));
  };
  const endBatch = async (call, toolResponse) => {
    for (const hook of batchHooks()) {
      await runHook(hook, {
        session_id: sessionId,
        transcript_path: transcript,
        cwd: process.cwd(),
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_name: 'Artifact', tool_input: call.input, tool_use_id: call.id, tool_response: toolResponse }],
      });
    }
    // The next model request goes out the moment the batch hooks are done.
    note({ type: 'model-request', id: call.id, marker: readMarker() });
  };
  const makeCall = async (call) => {
    const base = {
      session_id: sessionId,
      transcript_path: transcript,
      cwd: process.cwd(),
      permission_mode: 'default',
      tool_name: 'Artifact',
      tool_input: call.input,
      tool_use_id: call.id,
    };
    // As Claude does once it has saved the login to the Keychain: the file goes.
    if (call.loginToKeychain) rmSync(path.join(configDir, '.credentials.json'), { force: true });
    record({ type: 'assistant', message: { content: [{ type: 'tool_use', id: call.id, name: 'Artifact', input: call.input }] } });
    for (const hook of hooksFor('PreToolUse')) {
      const said = await runHook(hook, { ...base, hook_event_name: 'PreToolUse' });
      const decision = said?.hookSpecificOutput;
      if (decision?.additionalContext) note({ type: 'artifact-context', id: call.id, context: decision.additionalContext });
      if (decision?.permissionDecision === 'deny') {
        note({
          type: 'artifact-denied',
          id: call.id,
          reason: decision.permissionDecisionReason,
          marker: readMarker(),
          // Who the session's own record says it is signed in as.
          identity: readObject(path.join(configDir, '.claude.json')).oauthAccount?.emailAddress ?? null,
        });
        return;
      }
    }
    if (call.deniedByOtherHook) {
      const refusal = 'Blocked by the person\'s own hook.';
      note({ type: 'artifact-denied-by-other', id: call.id, marker: readMarker() });
      record({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: call.id, is_error: true, content: refusal }] } });
      await endBatch(call, refusal);
      return;
    }
    // The call itself: whichever login is in the folder now is the one it goes out as.
    note({ type: 'artifact-call', id: call.id, marker: readMarker(), loginReread: loginTime() > loginTimeAtStart });
    // Words on the screen while the call is out, as when a subagent is refused.
    if (call.sayDuring) process.stdout.write(`${call.sayDuring}\n`);
    if (call.refuseDuring) {
      record({
        type: 'assistant',
        isSidechain: false,
        isApiErrorMessage: true,
        error: 'rate_limit',
        apiError: 'rate_limit_error',
        apiErrorStatus: 429,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Out of room on this account for now.' }] },
      });
    }
    const started = Date.now();
    await wait(call.takesMs ?? 50);
    if (call.writeResult) {
      record({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: call.id, content: 'ok' }] } });
    }
    // The account it went out as, right to its end.
    note({ type: 'artifact-end', id: call.id, marker: readMarker() });
    if (!call.skipAfterHook) {
      const event = call.fail ? 'PostToolUseFailure' : 'PostToolUse';
      for (const hook of hooksFor(event)) {
        const said = await runHook(hook, {
          ...base,
          hook_event_name: event,
          duration_ms: Date.now() - started,
          ...(call.fail ? { error: 'the page could not be published' } : { tool_response: call.response ?? {} }),
        });
        const context = said?.hookSpecificOutput?.additionalContext;
        if (context) note({ type: 'artifact-context', id: call.id, context });
      }
      await endBatch(call, call.fail ? 'the page could not be published' : (call.response ?? {}));
    }
    note({ type: 'artifact-over', id: call.id, marker: readMarker() });
  };
  const calls = JSON.parse(process.env.FAKE_CLAUDE_ARTIFACT);
  let over = 0;
  for (const call of calls) {
    setTimeout(() => {
      void makeCall(call).then(() => {
        over += 1;
        // End the run a while after the last call, when asked, saying first
        // which login is in the folder by then.
        const thenExit = Number(process.env.FAKE_CLAUDE_ARTIFACT_THEN_EXIT_MS) || 0;
        if (over === calls.length && thenExit > 0) {
          setTimeout(() => {
            note({ type: 'reread', marker: readMarker() });
            process.exit(0);
          }, thenExit);
        }
      });
    }, call.afterMs ?? 0);
  }
}

// Stay alive when asked, so a test can interrupt the run (cap or switch) before
// it exits. Killed by the parent (child.kill) ends it immediately.
// One that does not stop when asked keeps running well past any test, unless
// made to; so does one cut off mid-write, which is only ever ended from outside
// (finishing would print its next event straight after the half line, which a
// real run never does).
const runsUntilEnded =
  firstLaunch && (process.env.FAKE_CLAUDE_IGNORE_TERM || process.env.FAKE_CLAUDE_PARTIAL_LINE);
// A launch that resumes can be given a shorter stay of its own, so a test
// that ends on a relaunch does not wait out the first launch's time again.
const stayMs = (!firstLaunch && process.env.FAKE_CLAUDE_RESUMED_IDLE_MS) || process.env.FAKE_CLAUDE_IDLE_MS;
const idleMs = runsUntilEnded ? 60_000 : Number(stayMs) || 0;
// How a run that ends by itself exits: 0, unless a test asks for a failure.
const endCode = Number(process.env.FAKE_CLAUDE_EXIT_CODE) || 0;
if (idleMs > 0) {
  setTimeout(() => {
    // Simulate Claude re-reading its credential file from disk (its ~30s cache
    // TTL) before the run ends, so a seamless in-place swap is observable.
    if (runsLog) appendFileSync(runsLog, `${JSON.stringify({ type: 'reread', marker: readMarker() })}\n`, 'utf8');
    printResult(() => process.exit(endCode));
  }, idleMs);
} else if (!streamTurns) {
  // A run taking its turns over stream-json ends when its input does instead.
  printResult(() => process.exit(endCode));
}
// Ended once a file the test names appears, the stay above being only a
// backstop then: a test that must see something happen before Claude goes
// ends it once it has, however slow the machine was to get there.
const exitWhen = process.env.FAKE_CLAUDE_EXIT_WHEN;
if (exitWhen && idleMs > 0) {
  const t = setInterval(() => {
    if (!existsSync(exitWhen)) return;
    clearInterval(t);
    printResult(() => process.exit(endCode));
  }, 50);
  if (t.unref) t.unref();
}

// Ordinary output with no limit in it. Used to prove a single cap message does
// not keep re-matching from the rolling buffer as later output arrives. With
// FAKE_CLAUDE_CHATTER_STAMP=1 each line ends with when it was written
// (Date.now()), so a test can tell how long ccx held it before relaying it.
const chatterEvery = Number(process.env.FAKE_CLAUDE_CHATTER_EVERY_MS) || 0;
if (chatterEvery > 0) {
  const stamp = process.env.FAKE_CLAUDE_CHATTER_STAMP === '1';
  const c = setInterval(() => { process.stdout.write("working on it" + (stamp ? ` ${Date.now()}` : '') + String.fromCharCode(10)); }, chatterEvery);
  if (c.unref) c.unref();
}