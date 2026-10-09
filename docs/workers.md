# Workers: one task, one account

`ccx worker` runs one task headless (`claude -p`) on one of your accounts, for
an orchestrator: a Claude session that hands work out, or a program of your
own. It is the out-of-process version of a Claude Code subagent. A subagent
runs inside its parent's process and shares its single login, so every
subagent spends the same account. A worker is its own process, on the account
ccx picks for it, so ten workers can run on ten accounts.

```sh
ccx worker --agent coder --cwd ../wt-billing --permission-mode acceptEdits \
  "Make the billing retry idempotent. Run npm test before you finish."
```

## What a worker gets

- **Your own Claude.** Like a ccx session, a worker runs in a folder of its own
  that shares your `~/.claude`: your settings, agents, skills, plugins, MCP
  servers and memory. An agent defined in `~/.claude/agents` or the project's
  `.claude/agents` is there.
- **The account pick.** `--account best` (the default) takes the pick order
  (`ccx order`), held-back weeks and disabled accounts included. Workers spread
  out: each prefers a healthy account that no other session or worker is using,
  so five workers started together do not all land on the best one. A worker
  started on a named account spreads out the same way once that one runs out.
- **Running out mid-task is not the end of the task.** When the account runs
  out, ccx confirms it against the account's usage, moves to the next account
  and resumes the same conversation with a note to carry on. The task is not
  started over, so a coder that has edited files keeps its place.
- **Nothing global moves.** The account your sessions start on, the editor's
  link and your terminal are left alone.
- **A clean start from inside Claude.** Started by a Claude session's Bash tool,
  a worker takes none of that session's own variables: not its login token,
  which would put the worker on the orchestrator's account, and not the ones
  that tie it to Claude Desktop or to the session that started it.
- **It shows up while it runs**, in `ccx sessions` and the dashboard, and can be
  moved like a session (`ccx use <account> --session <pid>`).

## Options

| Option                     | Meaning                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `--agent <name>`           | run as this agent definition (`.claude/agents/<name>.md`)                    |
| `--account <name\|best>`   | start on this account; `best` (default) is the pick order, spread out        |
| `--model <model>`          | the model to run                                                             |
| `--output <format>`        | `json` (default), `stream-json` or `text`                                    |
| `--permission-mode <mode>` | Claude's permission mode; a worker cannot stop to ask, so set what it may do |
| `--cwd <dir>`              | work in this folder                                                          |
| `--brief-file <path>`      | read the brief from a file, or `-` for standard input                        |
| `--timeout <minutes>`      | end the worker, Claude and everything it started after this long (exit 124)  |
| `-- <claude flags>`        | anything else goes to Claude as is (`--allowedTools`, `--max-turns`, ...)    |

The brief is the words after the options, best quoted as one argument, or
`--brief-file` (not both). Any length works: one too long for a command line
goes to Claude by standard input. A brief that starts with a dash, or whose
words look like a worker option, goes in a file, since ccx would read it as
an option.

## What it prints

Claude's answer is the worker's standard output, exactly as `claude -p` prints
it, with a report of which accounts did the work. ccx's own messages go to
standard error, prefixed `[ccx]`.

- **json**: Claude's result object, with a `ccx` field added. Always one
  object, so a program can always parse it:

  ```json
  {
    "type": "result",
    "subtype": "success",
    "is_error": false,
    "result": "Done. Retries now carry an idempotency key...",
    "session_id": "4057bbd0-f753-432c-87db-238d2de3044c",
    "ccx": { "accounts": ["work", "spare"], "moves": 1, "sessionId": "4057bbd0-..." }
  }
  ```

  Only the launch that finished is printed. One that ended because its account
  ran out printed a failure the task has since recovered from. When Claude gave
  no result at all (no account could run it, or it ended without one), the
  object is ccx's own, in the same shape: `"subtype": "error_ccx"`,
  `"is_error": true`, and the reason as `result` and as `ccx.error`.

- **stream-json**: Claude's events as they arrive, whole lines only (from every
  launch, so a move is visible; a line cut off when a launch was ended is
  dropped), then a last line `{"type":"ccx","accounts":[...],"moves":1,...}`,
  with an `error` field when Claude gave no result.
- **text**: the answer, and a line on standard error:
  `[ccx] worker ran on work, then spare (session ...)`.

`accounts` names every account the worker ran on, in order, including one it
was moved to while running (`ccx use <account> --session <pid>`).

The exit code is Claude's (0 on success), 1 when no account could run it or
Claude gave no result, 2 for a worker refused before it started (no brief,
unknown account or output, no accounts added), 124 at its `--timeout`, and
128 plus the signal when it was stopped.

## Stopping a worker

Bound a worker with `--timeout <minutes>`. When it passes, ccx ends Claude and
everything Claude started (a test run, a dev server), and the worker exits with
124 and says why (`"result": "timed out after 30 minutes"`). That is the
safe way for an orchestrator to give up on one, on every platform.

Ending `ccx worker` from outside works too, with a signal: Ctrl+C, or SIGTERM
(what `kill` and Node's `child.kill()` send on macOS and Linux). ccx ends Claude
and everything it started, and the worker exits with 128 plus the signal. The
same happens when a worker moves to another account. SIGKILL cannot be caught,
so it leaves Claude running; send SIGTERM.

On Windows a program cannot send a signal: `child.kill()`, `execFile`'s own
timeout and Task Manager end the process outright, and nothing of ccx's runs.
Claude ends with it, but a command Claude was running in its Bash tool keeps
running, as it would under a plain `claude` ended that way. Use `--timeout`, or
end the whole tree: `taskkill /T /F /PID <pid>`.

## Agent definitions

The same file serves both ways. `.claude/agents/coder.md`:

```markdown
---
name: coder
description: Implements one well-specified change and verifies it.
tools: Read, Edit, Write, Bash, Grep, Glob
model: opus
---

You implement exactly the change in the brief. Read the code you touch first,
keep to its style, and run the tests before you finish. End with a short summary
of what changed and how you checked it.
```

In a Claude session it is a subagent; with `ccx worker --agent coder` it is a
worker on its own account.

## Running coders in parallel

Workers share whatever folder they run in, so two coders editing one checkout
collide. Give each its own git worktree:

```sh
git worktree add ../wt-retries -b fix/retries
git worktree add ../wt-export  -b feat/export
ccx worker --agent coder --cwd ../wt-retries --permission-mode acceptEdits "..." > retries.json &
ccx worker --agent coder --cwd ../wt-export  --permission-mode acceptEdits "..." > export.json &
wait
```

A worker cannot answer a permission question, so decide up front what it may
do: `--permission-mode acceptEdits` lets it edit files, and
`-- --allowedTools "Bash(npm test:*)"` lets it run your tests. Reserve
`--permission-mode bypassPermissions` for a sandbox.

## From an orchestrating Claude session

The orchestrator briefs each worker fully, as it would a subagent: a worker
starts with no memory of the orchestrator's conversation. Then it runs them
through its Bash tool and reads the JSON:

```sh
ccx worker --agent coder --cwd ../wt-retries --permission-mode acceptEdits \
  --brief-file briefs/retries.md > results/retries.json
```

## From a program

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const { stdout } = await run(
  'ccx',
  ['worker', '--timeout', '30', '--agent', 'coder', '--cwd', tree, brief],
  {
    maxBuffer: 64 * 1024 * 1024,
  },
);
const answer = JSON.parse(stdout);
console.log(answer.result, answer.ccx.accounts);
```

## Looking at a worker afterwards

Its conversation is saved in your own `~/.claude`, so
`claude --resume <sessionId>` in the folder it ran in opens it, whichever
accounts it ran on.

## What a worker is not

- **It does not share the orchestrator's context.** Like a subagent, it knows
  only its brief and what it reads. Put everything it needs in the brief.
- **It costs its own context.** Each worker loads Claude's context afresh on its
  account, more than a subagent sharing its parent's process.
- **It does not split one session's subagents across accounts.** That is not
  possible from outside Claude: one process has one login.
