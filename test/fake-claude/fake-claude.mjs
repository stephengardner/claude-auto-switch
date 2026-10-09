#!/usr/bin/env node
// Fake `claude` for tests. Impersonates the subset of the real CLI that
// claude-auto-switch drives: `auth status`, `auth login`, and a generic run.
// Behavior is driven by a scenario JSON, resolved from FAKE_CLAUDE_SCENARIO or
// <CLAUDE_CONFIG_DIR>/fake-scenario.json. No network, no model spend, no logins.
import { readFileSync, writeFileSync, writeSync, existsSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? process.cwd();

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
// Print mode with an output format, as a worker runs it. The prompt is read
// the way Claude's own parser reads it: the first operand that is not some
// option's value, where an option such as --allowedTools takes EVERY operand
// up to the next option. With no operand, it is standard input, and with
// neither, Claude refuses, as the real one does.
const printMode = args.includes('-p') || args.includes('--print');
const formatAt = args.indexOf('--output-format');
const outputFormat = printMode && formatAt >= 0 ? args[formatAt + 1] : null;
const VALUE_FLAGS = new Set([
  '--output-format',
  '--session-id',
  '--resume',
  '--agent',
  '--model',
  '--permission-mode',
  '--max-turns',
  '--append-system-prompt',
  '--settings',
  '--effort',
  '--fallback-model',
  '--input-format',
]);
const MANY_VALUE_FLAGS = new Set([
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
const operandPrompt = () => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return args[i + 1] ?? null;
    if (!arg.startsWith('-')) return arg;
    if (arg.includes('=')) continue;
    if (VALUE_FLAGS.has(arg)) i += 1;
    else if (MANY_VALUE_FLAGS.has(arg)) while (i + 1 < args.length && !args[i + 1].startsWith('-')) i += 1;
  }
  return null;
};
let printPrompt = null;
let promptVia = null;
if (outputFormat) {
  const operand = operandPrompt();
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
      pid: process.pid,
      // What it would sign in with, besides the session folder.
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
    })}\n`,
    'utf8',
  );
}
const printSession = () => {
  for (const flag of ['--session-id', '--resume']) {
    const i = args.indexOf(flag);
    if (i >= 0 && args[i + 1]) return args[i + 1];
  }
  return null;
};
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
const firstLaunch = !args.includes('--resume');
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
// On standard error in print mode with a format: standard output there is the
// answer, and a program reads it whole.
(outputFormat ? process.stderr : process.stdout).write(`fake-claude ran: ${args.join(' ')}\n`);

// Arbitrary output at start, standing in for a replayed conversation.
if (process.env.FAKE_CLAUDE_SAY) process.stdout.write(`${process.env.FAKE_CLAUDE_SAY}\n`);

// The real CLI's answer to resuming a conversation that was never written (a
// swap before the first message): a message on stderr and exit 1, at once.
const resumeAt = args.indexOf('--resume');
const resumed = resumeAt >= 0 ? args[resumeAt + 1] : undefined;
if (process.env.FAKE_CLAUDE_NOTHING_TO_RESUME && resumed) {
  process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
  process.exit(1);
}

// A fork is only saved with its first message. With this set, every fork this
// fake starts is remembered as unsaved, and resuming one by its own id finds
// nothing, as with the real CLI when a swap lands before that message.
if (process.env.FAKE_CLAUDE_UNSAVED_FORKS) {
  const unsaved = path.join(configDir, 'unsaved-forks.txt');
  const sessionAt = args.indexOf('--session-id');
  if (args.includes('--fork-session') && sessionAt >= 0) {
    appendFileSync(unsaved, `${args[sessionAt + 1]}\n`, 'utf8');
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
  const valueAfter = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : null;
  };
  const record = path.join(configDir, 'sessions', `${process.pid}.json`);
  const startedAt = Date.now();
  // Idle a minute already when asked: the status Claude keeps while it waits
  // for the next message.
  const idle = process.env.FAKE_CLAUDE_IDLE_STATUS
    ? { status: 'idle', statusUpdatedAt: Date.now() - 60_000 }
    : {};
  const writeRecord = (sessionId) =>
    writeJson(record, { pid: process.pid, sessionId, cwd: process.cwd(), startedAt, kind: 'interactive', ...idle });
  const recordedId =
    valueAfter('--session-id') ??
    valueAfter('--resume') ??
    process.env.FAKE_CLAUDE_LANDS_ON ??
    '00000000-0000-4000-8000-000000000000';
  writeRecord(recordedId);

  // The conversation's own record, at <config dir>/projects/<folder>/<id>.jsonl
  // where the real CLI keeps it. A refused turn is written the way Claude
  // 2.1.284 writes one (measured): an answer flagged isApiErrorMessage, with
  // Claude's code, the API's code and the HTTP status.
  if (process.env.FAKE_CLAUDE_TRANSCRIPT) {
    const transcript = path.join(configDir, 'projects', 'fake-project', `${recordedId}.jsonl`);
    mkdirSync(path.dirname(transcript), { recursive: true });
    appendFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
    // Only on the accounts named, when some are: an account with room does
    // not refuse.
    const refuseOn = process.env.FAKE_CLAUDE_REFUSE_ON;
    const refusesHere = !refuseOn || refuseOn.split(',').includes(readMarker() ?? '');
    const refuse = () => {
      if (!refusesHere) return;
      appendFileSync(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          isApiErrorMessage: true,
          error: 'rate_limit',
          apiError: 'model_requires_usage_credits',
          apiErrorStatus: 429,
          message: {
            model: '<synthetic>',
            role: 'assistant',
            content: [{ type: 'text', text: 'Out of room on this account for now.' }],
          },
        })}\n`,
      );
      // Print mode ends the run on a refused turn, with an error result and
      // exit 1, where the terminal app stays up and waits.
      if (process.env.FAKE_CLAUDE_REFUSAL_ENDS_RUN && outputFormat) {
        const failed = {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'Out of room on this account for now.',
          session_id: printSession(),
        };
        if (outputFormat === 'text') process.stderr.write(`${failed.result}\n`, () => process.exit(1));
        else process.stdout.write(`${JSON.stringify(failed)}\n`, () => process.exit(1));
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
  }
  // A conversation switch made inside the session, at human speed.
  const switchTo = process.env.FAKE_CLAUDE_SWITCH_TO;
  if (switchTo) {
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
if (process.env.FAKE_CLAUDE_NO_CONVERSATION && (args.includes('--continue') || args.includes('-c'))) {
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
if (capEvery > 0) {
  const t = setInterval(() => {
    if (Date.now() < capFrom) return;
    process.stdout.write("You have reached your Fable 5 limit. Run /usage-credits to continue.\n");
  }, capEvery);
  if (t.unref) t.unref();
}

// Stay alive when asked, so a test can interrupt the run (cap or switch) before
// it exits. Killed by the parent (child.kill) ends it immediately.
// One that does not stop when asked keeps running well past any test, unless
// made to; so does one cut off mid-write, which is only ever ended from outside
// (finishing would print its next event straight after the half line, which a
// real run never does).
const runsUntilEnded =
  firstLaunch && (process.env.FAKE_CLAUDE_IGNORE_TERM || process.env.FAKE_CLAUDE_PARTIAL_LINE);
const idleMs = runsUntilEnded ? 60_000 : Number(process.env.FAKE_CLAUDE_IDLE_MS) || 0;
if (idleMs > 0) {
  setTimeout(() => {
    // Simulate Claude re-reading its credential file from disk (its ~30s cache
    // TTL) before the run ends, so a seamless in-place swap is observable.
    if (runsLog) appendFileSync(runsLog, `${JSON.stringify({ type: 'reread', marker: readMarker() })}\n`, 'utf8');
    printResult(() => process.exit(0));
  }, idleMs);
} else {
  printResult(() => process.exit(0));
}


// Ordinary output with no limit in it. Used to prove a single cap message does
// not keep re-matching from the rolling buffer as later output arrives.
const chatterEvery = Number(process.env.FAKE_CLAUDE_CHATTER_EVERY_MS) || 0;
if (chatterEvery > 0) {
  const c = setInterval(() => { process.stdout.write("working on it" + String.fromCharCode(10)); }, chatterEvery);
  if (c.unref) c.unref();
}