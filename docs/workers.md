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
  so five workers started together do not all land on the best one.
- **Running out mid-task is not the end of the task.** When the account runs
  out, ccx confirms it against the account's usage, moves to the next account
  and resumes the same conversation with a note to carry on. The task is not
  started over, so a coder that has edited files keeps its place.
- **Nothing global moves.** The account your sessions start on, the editor's
  link and your terminal are left alone.
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
| `-- <claude flags>`        | anything else goes to Claude as is (`--allowedTools`, `--max-turns`, ...)    |

The brief is the words after the options, or `--brief-file`. Any length works:
one too long for a command line goes to Claude by standard input.

## What it prints

Claude's answer is the worker's standard output, exactly as `claude -p` prints
it, with a report of which accounts did the work. ccx's own messages go to
standard error, prefixed `[ccx]`.

- **json**: Claude's result object, with a `ccx` field added:

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
  ran out printed a failure the task has since recovered from.

- **stream-json**: Claude's events as they arrive (from every launch, so a move
  is visible), then a last line `{"type":"ccx","accounts":[...],"moves":1,...}`.
- **text**: the answer, and a line on standard error:
  `[ccx] worker ran on spare, moved from work when it ran out (session ...)`.

The exit code is Claude's (0 on success), 1 when no account could run it, and 2
for a worker refused before it started (no brief, unknown account or output).

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
const { stdout } = await run('ccx', ['worker', '--agent', 'coder', '--cwd', tree, brief], {
  maxBuffer: 64 * 1024 * 1024,
});
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
