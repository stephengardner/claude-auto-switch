# fake-claude

A stand-in for the real `claude` CLI, used by the test suite so the whole tool
(health probing, selection, rotation, launching) can be exercised with **zero
real accounts, zero logins, and zero model spend**.

## How it works

`fake-claude.mjs` is plain Node (no build step) so tests can invoke it directly:

```
node test/fake-claude/fake-claude.mjs <args>
```

Its behavior is driven by a **scenario** JSON, resolved in this order:

1. `FAKE_CLAUDE_SCENARIO` environment variable (absolute path to a scenario file)
2. `<CLAUDE_CONFIG_DIR>/fake-scenario.json`
3. a built-in logged-out default

## Commands honored

- `auth status`: prints the scenario's `authStatus` JSON, exits 0 if `loggedIn` else 1.
- `auth login ...`: simulates a successful login by writing a logged-in
  `fake-scenario.json` into `CLAUDE_CONFIG_DIR`, exits 0.
- anything else (a "run", e.g. `-p "..."`): if the scenario is `capped`, prints
  `capMessage` to stderr and exits `capExitCode`; otherwise records the
  invocation to `<CLAUDE_CONFIG_DIR>/fake-last-run.json` and exits 0.
- a run reads its arguments the way the real CLI's parser does (short options
  in clusters, option values, nothing after `--` as an option). With
  `FAKE_CLAUDE_RUNS_LOG` set, each launch logs what it applied (`applied`) and
  whether it ran in a terminal (`tty`). Like 2.1.302, it refuses `--session-id`
  beside `--continue` or `--resume` without `--fork-session`. With
  `FAKE_CLAUDE_LOG_FOLDER` too, it logs what its config folder holds of the
  user's Claude (`folder`: where `projects` and `skills` land, its settings,
  and the address its state is signed in as).
- a test that must order something after an event, not after a length of time,
  names a file: `FAKE_CLAUDE_REFUSE_WHEN` refuses the main thread's turn once it
  appears (with `FAKE_CLAUDE_SESSION_RECORD` and `FAKE_CLAUDE_TRANSCRIPT` set),
  and `FAKE_CLAUDE_EXIT_WHEN` ends the run once it appears, leaving
  `FAKE_CLAUDE_IDLE_MS` as a backstop. `FAKE_CLAUDE_SWITCH_WHEN` moves the
  process to the conversation `FAKE_CLAUDE_SWITCH_TO` names once it appears,
  as a `/clear` does (without it, the move comes `FAKE_CLAUDE_SWITCH_AFTER_MS`
  in). `FAKE_CLAUDE_REFUSALS_AT_ONCE` writes that many refused turns in one
  write each time the main thread is refused. With `FAKE_CLAUDE_LOG_CAP_WORDS`, each
  showing of the repeated limit words (`FAKE_CLAUDE_CAP_EVERY_MS`) is logged as
  `cap-words`, so a test can count them. `FAKE_CLAUDE_CAP_WORDS` replaces those
  words with a test's own.
- with `--input-format stream-json` (and `FAKE_CLAUDE_SESSION_RECORD` and
  `FAKE_CLAUDE_TRANSCRIPT` set) it is the editor's Claude: it takes one turn per
  stream-json user message on standard input and answers each as stream-json
  events on standard output, staying up until its input ends. Each prompt is
  recorded in the conversation the process is in now, typed by a person when
  the message says `origin: { kind: "human" }`, and refused when the login in
  use is one `FAKE_CLAUDE_REFUSE_ON` names. A message's own `fake` asks for
  one turn: the limit its refusal names and when that resets (`limitType`,
  `resetsAt` in epoch seconds), or that a subagent meets it (`subagent`), in a
  record of its own with no prompt typed. `/clear` moves it to the next
  conversation in `FAKE_CLAUDE_CLEAR_TO`. `FAKE_CLAUDE_PROMPT_WITH_REFUSAL`
  writes each refusal together with a prompt typed after it, and
  `FAKE_CLAUDE_LAST_WORDS` goes to standard error as the input ends.
  `FAKE_CLAUDE_SESSION_RECORD_AFTER_MS` writes the per-process record only that
  late, as when Claude takes its first turn before it registers itself.
- `FAKE_CLAUDE_NOTE_TERM` (with `FAKE_CLAUDE_RUNS_LOG`): a SIGTERM is logged
  as `signal` before the run ends with 143.

## Scenario shape

```json
{
  "authStatus": { "loggedIn": true, "email": "...", "subscriptionType": "max" },
  "capped": false,
  "capMessage": "Usage limit reached...",
  "capExitCode": 1
}
```

Ready-made scenarios live in `scenarios/`.
