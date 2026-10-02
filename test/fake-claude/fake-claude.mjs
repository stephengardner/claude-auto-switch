#!/usr/bin/env node
// Fake `claude` for tests. Impersonates the subset of the real CLI that
// claude-auto-switch drives: `auth status`, `auth login`, and a generic run.
// Behavior is driven by a scenario JSON, resolved from FAKE_CLAUDE_SCENARIO or
// <CLAUDE_CONFIG_DIR>/fake-scenario.json. No network, no model spend, no logins.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
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
if (runsLog) {
  appendFileSync(runsLog, `${JSON.stringify({ type: 'launch', args, marker: readMarker() })}\n`, 'utf8');
}
process.stdout.write(`fake-claude ran: ${args.join(' ')}\n`);

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
    const refuse = () =>
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
    const after = Number(process.env.FAKE_CLAUDE_REFUSE_AFTER_MS) || 0;
    if (after > 0) {
      const t = setTimeout(refuse, after);
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
const idleMs = Number(process.env.FAKE_CLAUDE_IDLE_MS) || 0;
if (idleMs > 0) {
  setTimeout(() => {
    // Simulate Claude re-reading its credential file from disk (its ~30s cache
    // TTL) before the run ends, so a seamless in-place swap is observable.
    if (runsLog) appendFileSync(runsLog, `${JSON.stringify({ type: 'reread', marker: readMarker() })}\n`, 'utf8');
    process.exit(0);
  }, idleMs);
} else {
  process.exit(0);
}


// Ordinary output with no limit in it. Used to prove a single cap message does
// not keep re-matching from the rolling buffer as later output arrives.
const chatterEvery = Number(process.env.FAKE_CLAUDE_CHATTER_EVERY_MS) || 0;
if (chatterEvery > 0) {
  const c = setInterval(() => { process.stdout.write("working on it" + String.fromCharCode(10)); }, chatterEvery);
  if (c.unref) c.unref();
}