# ccx (claude-auto-switch)

Run Claude Code across several of your Claude accounts. When one account runs
out, ccx moves the session to another and the conversation carries on: same
terminal, same conversation, same model. It moves the running Claude in place
when it safely can, and otherwise relaunches it with `--resume`.

Local only: your machine, your accounts. No server, no telemetry.

![The ccx dashboard: accounts in the order ccx would pick them, what is left of each window with its reset beside it, the accounts out of room below, then those out of rotation, and where a session goes when its account runs out](docs/img/dashboard.svg)

## Quick start

```sh
npm install -g claude-auto-switch
ccx add work        # sign in through your browser
ccx add personal    # sign out of claude.ai first, or use another browser profile
ccx on              # route `claude` through ccx in every shell, your editor and the status line
claude              # use Claude as usual
```

`ccx doctor` checks the setup. Node.js 20+ on Windows, macOS or Linux;
installing builds [`node-pty`](https://github.com/microsoft/node-pty), which
needs your platform's C/C++ build tools. Details: [setup](docs/setup.md).

## Everyday commands

| Command                 | What it does                                                                 |
| ----------------------- | ---------------------------------------------------------------------------- |
| `ccx`                   | status at a glance                                                           |
| `ccx dashboard`         | live view: every account, what is left, what happens next (`s` for settings) |
| `ccx usage`             | every window on every account, with reset times                              |
| `ccx use <name>`        | start new sessions on an account and move a running session to it, in place  |
| `ccx swap [name]`       | from inside a session (or `/ccx` in Claude): the room on every account; swap |
| `ccx add` / `ccx login` | add an account / sign one in again (`--host <server>` signs a server in)     |
| `ccx worker [brief...]` | one task headless on its own account, for an orchestrator                    |
| `ccx state`             | everything ccx knows, as JSON                                                |
| `ccx doctor`            | check the setup and who each profile is really signed in as (`--fix`)        |

Every command and setting: [reference](docs/reference.md).

## How it works

- **A config folder per session.** Each session runs on its own
  `CLAUDE_CONFIG_DIR` holding that session's login. Switching account replaces
  that login under the running Claude, which picks it up at its next request.
  Everything else (projects, history, settings, skills, agents, MCP servers) is
  your own `~/.claude`.
- **It reads the transcript, not the screen.** Claude records every refused
  turn with its error code. ccx confirms each one against the account's real
  usage before it moves anything; when that check cannot answer, a refusal
  Claude records as a spent usage limit (`usage_limit_reached`) that names its
  limit confirms it instead.
- **It moves in place.** Subagents, background commands and loops keep
  running; ccx closes Claude's own usage-limit menu (`/rate-limit-options`)
  and types a short carry-on prompt once Claude is back at its prompt with an
  empty input box. It relaunches with `--resume` only when that cannot be done
  safely.
- **It knows a dead login.** A login revoked at Anthropic leaves rotation, and
  an account put on hold shows as `on hold`.
- **It picks the account that can run longest** (`ccx order`: `smart`,
  `most-room` or `priority`), holds back nearly spent weeks, and keeps you on
  your model across accounts before falling back (`ccx models opus fable`).

More: [how it works](docs/how-it-works.md), [the dashboard](docs/dashboard.md).

## Workers: one task, one account

A Claude Code subagent shares its parent's login, so every subagent spends the
same account. `ccx worker` runs a task headless as its own process on an
account ccx picks, spread across accounts nothing else is using. When that
account runs out, it resumes the same conversation on the next one.

```sh
ccx worker --agent coder --cwd ../wt-billing --permission-mode acceptEdits \
  "Make the billing retry idempotent. Run npm test before you finish."
```

Options, output and parallel coders in worktrees: [workers](docs/workers.md).

## Build your own UI on `ccx state`

`ccx state` prints everything ccx knows as JSON: each account's room and
resets, its status (`ready`, `blocked`, `disabled`, `logged-out`, `on-hold`)
and when it comes back, and where rotation goes next. Acting on it is ordinary
commands with exit codes:

```sh
ccx state | jq '.accounts[] | {name, state: .status.state, until: .status.until}'
ccx use spare --all      # move every running session to "spare"
ccx disable old          # take an account out of rotation
```

That makes any local UI a short prompt away. Ask Claude for a page that polls
`ccx state` every few seconds and runs `ccx use <name>` when you click an
account, and you have a monitor and switcher of your own, styled however you
like. The contract: [reading ccx from another program](docs/reading-ccx-from-another-program.md).

## More

- [Claude Desktop](docs/desktop.md): move a Desktop conversation to a terminal, where it switches.
- [Servers over SSH](docs/servers.md): keep Claude working on a server, signed in from your laptop.
- [Artifact pages](docs/artifacts.md): keep pages Claude publishes on one account.

## Privacy and security

ccx talks to Anthropic only about your own accounts: reading usage, renewing a
stale login, and asking which account a login belongs to. Logins come from your
browser sign-in; ccx never sees a password. See [SECURITY.md](SECURITY.md).

Using several paid accounts to extend your usage may conflict with Anthropic's
terms. Use your own judgment.

## Development

```sh
npm run verify   # typecheck, lint and tests
```

Tests run against a fake `claude` (`test/fake-claude/`): no real account, no
model usage. Screenshots: `npm run build && node scripts/screenshots.mjs`.

MIT. See [LICENSE](LICENSE).
