# ccx (claude-auto-switch)

Run Claude Code across several of your Claude accounts. When one account's
usage is spent, ccx moves the session to another account and the conversation
carries on: same terminal, same conversation, same model.

It runs on your machine against your own accounts. No server, no telemetry.

![The ccx dashboard: accounts in the order ccx would pick them, what is left of each window with its reset beside it, the accounts out of room below, and where a session goes when its account runs out](docs/img/dashboard.svg)

## Quick start

```sh
npm install -g claude-auto-switch
ccx add work        # sign in through your browser
ccx add personal    # sign out of claude.ai first, or use another browser profile
ccx on              # route `claude` through ccx
claude              # use Claude as usual
```

`ccx on` sets up four things, and `ccx off` removes them:

- a `claude` function in your shell profile that runs Claude through ccx
- the Claude Code extension in Cursor and VS Code
- ccx's part of Claude's status line (an existing status line is kept, wrapped)
- the `/ccx` command inside Claude

`ccx doctor` checks the whole setup, including which account each profile is
really signed in as. Two profiles holding one account would end each other's
logins on renewal, so ccx refuses such a sign-in and keeps the previous login.

## How it works

**A config folder per session.** Claude reads its login from its config folder
(`CLAUDE_CONFIG_DIR`). ccx runs each session on its own folder,
`~/.claude-auto-switch/sessions/<pid>`, holding that session's login. Changing
account means replacing that login; Claude picks it up at its next request,
without a restart.

**Everything else is your `~/.claude`.** The session folder links your projects
and transcripts, prompt history, `/rewind` checkpoints, plugins, skills, agents,
todos and memory. Settings start as a copy of your `settings.json`. What Claude
changes during a session (a model picked with `/model`, a permission, a hook, an
MCP server, a trusted folder) is merged back into your own `settings.json` and
`~/.claude.json`, and logged. If you changed the same setting elsewhere, yours
wins.

**Detecting a spent account.** Claude writes every refused turn into the
conversation's transcript, with error codes. ccx reads that record, never the
screen, and confirms against the account's real usage before it acts. Text on
screen that talks about usage limits never moves a session.

**Moving.** A refused turn has already ended, so the session needs another
account and to be told to carry on. ccx replaces the login under the running
Claude, so its subagents, background commands and scheduled loops keep running,
then types a short carry-on prompt into it once Claude is back at its prompt
with nothing typed in the input box (set the prompt with `ccx resume-prompt`, or
`resume` in the config). A subagent's refused turn starts the same move, before
the main thread meets the limit. ccx relaunches Claude with
`--resume <conversation>` and the prompt instead when the limit is one model's,
when the next account's login has to be renewed first or is only a long-lived
token, when the session was started with a long-lived token, or when the
session has stopped and the prompt cannot be typed safely: something is typed
in the input box, a dialog stays open, or Claude does not say what it is doing.
A switch you make yourself (`ccx use`, `/ccx`) happens in place, by the same
rule; when it needs a restart instead, ccx waits until Claude has been idle for
20 seconds (`--now` restarts at once).

**One session at a time.** Each session moves on its own: a refused turn moves
that session and no other. A switch you make from the dashboard or with
`ccx use` moves the only running session, or, with several running, the ones
you name (`ccx use <name> --session <pid>`, `--here`, `--all`; the dashboard
asks).

**Updates.** When a newer ccx is installed, each running session moves to it
when Claude is next relaunched or has been idle for 20 seconds, never mid-turn.

## Which account is next

`ccx order`, `o` in the dashboard, or its settings (`s`) pick the rule:

- **smart** (default): the account that can run longest before any window stops
  it. An account has a 5-hour window, a weekly window, and a weekly window per
  model (Fable). ccx measures them in one unit, full 5-hour windows of work:
  weekly room is converted using what one 5-hour window costs that account's
  week, learned from its own readings (15% until measured). So a 5-hour window
  90% used, or a week 99% used, both mean almost no runway.
  - A week 80% or more used (the account's, or the model's own) is **held
    back**: that account comes after every healthy account that can run at
    least half a 5-hour window, however fresh its own window. What is left of a
    nearly spent week is the least certain number on screen, a second session
    can drain it twice as fast, and kept for last it bridges the hours when
    every healthy account is waiting on its 5-hour window. Against a healthy
    account with less than half a window, it competes on runway: holding back a
    full window for 40% of one would only mean another move within two hours.
    Set the line with `ccx config holdBackAtPercent <50-99|off>`.
  - Among accounts within a tenth of a window of each other, the one whose
    leftover weekly budget would expire unused soonest goes first, then your
    priority order.
  - An account with under a quarter window left is used only when nothing
    better exists: a move rereads the whole conversation without a cache.
- **most-room**: the least-used account, by its tighter percentage.
- **priority**: your own order, set with `ccx priority <name> <n>` or `[` and `]`
  in the dashboard.

A pinned account (`ccx use <name>`) always wins.

## Models

A spent model window stops that model, not the account. ccx keeps a session on
its model while any account has room for it, and only then moves down your
preference chain:

```sh
ccx models                            # show the current chain
ccx models opus fable                 # Opus, then Fable (the default)
ccx models opus                       # Opus only, never fall back
ccx models --strategy account-first   # use each account up across the chain instead
```

`M` in the dashboard cycles the common chains, and its settings (`s`) take a
chain of your own. This applies when a model is in play (`--model`, or `model`
in your settings); otherwise ccx rotates on account capacity alone.

## Seeing where you stand

- **Status line**: the account this session is on and its tightest window,
  e.g. `work 5h 64% left` or `! work week spent resets 2d`.
- **`ccx usage`**: every window on every account, with reset times.
- **`ccx dashboard`**: a live view, drawn to be read at a glance.
  - Accounts you can use come first, numbered in the order ccx would pick
    them, with the next one marked. Accounts that are out of room are listed
    under their own heading, soonest back first, and signed-out or disabled
    ones last.
  - Every bar and number is what is LEFT of that window, as on the status
    line: a full bar is an untouched window.
  - When a window resets is beside its own bar: `resets in 4h 16m (3:15 AM)`,
    with the clock time for a wait under a day. The cell is blank while no
    5-hour window is running (one starts at first use). An account that is
    out says `back in ...`, which is when the last thing blocking it lifts,
    under the window blocking it, or at the end of the row when it waits on
    ccx's own record of being refused.
  - The end of a row says what else matters about the account: `next in
    line`, `held back` (its week is nearly spent, so it waits behind healthier
    accounts), and how many sessions are running on it. `*` marks the account
    new sessions start on.
  - A column for one model's own weekly limit (`FABLE LEFT`) appears only
    while that limit is in play: the model is spent on some account, or has
    less left there than the account's week.
  - `when one runs out →` says where a session goes next and why, and
    `recent` the last few things that happened.
  - A row never wraps. As a terminal narrows, the table gives up the clock
    times, then the bars, then the words `resets in`; the numbers and reset
    times stay.

![ccx usage: every window per account, with a bar, a percentage and when it comes back](docs/img/usage.svg)

`s` in the dashboard opens the settings: every setting with its value, what it
does, and when a change reaches running sessions. The arrows step a value, enter
types one, `d` puts the default back. `ccx config` shows and sets the same
settings from a shell.

![The dashboard's settings: every setting under its group, the highlighted one explained](docs/img/settings.svg)

| Dashboard key   | Action                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `enter`         | make the highlighted account the one new sessions start on, and move a running session to it in place |
| `f`             | the same, restarting the session on it instead                                                        |
| `s`             | settings                                                                                              |
| `r`             | rotate to the next pick                                                                               |
| `M` / `o`       | cycle the model preference / the pick rule                                                            |
| `[` / `]`       | move the highlighted account up / down your priority order                                            |
| `e`             | enable or disable the highlighted account                                                             |
| `a` `n` `l`     | add an account, rename one, sign one in again                                                         |
| `x`             | remove the highlighted account, after asking (see below)                                              |
| `d` `m` `t` `D` | Claude Desktop: handoff, mode, carry-on text, move a conversation                                     |
| `q` / `esc`     | quit                                                                                                  |

`x` removes nothing until you answer it. It first says what the removal touches:
any session running on the account (it keeps going until it next moves, then
uses another account), whether new sessions start on it, and whether your
editor is on it. Enter alone or `esc` leaves the account as it is. `y` removes
it from ccx and keeps its folder and login. `purge <name>` also deletes the
folder: the login in it is deleted, and the account must be signed in again to
come back. A folder is not deleted while something is using it: a session
running on the account, your editor, the link `ccx daemon install` keeps, or
another account whose folder is the same one or inside it. `ccx remove --purge`
follows the same rule.

## Claude Desktop

Desktop runs its conversations on its own signed-in account, and nothing outside
Desktop can switch them. ccx moves a Desktop conversation to a terminal instead,
where it does switch, keeping its history, model, effort and permission mode:

```sh
ccx desktop                   # Desktop's account and its open conversations
ccx desktop move 2            # continue conversation 2 in a terminal (--wait)
ccx desktop handoff credits   # move by itself: off | limit | credits
```

- `handoff limit` moves a conversation when its turn is refused.
- `handoff credits` also holds back a message once Desktop's account is past its
  plan, so Desktop never spends usage credits.
- Both are hooks in `~/.claude/settings.json`. A moved conversation continues as
  a copy (`ccx desktop mode fork`, the default) or as itself (`mode same`).

## On a server you reach over SSH

A server keeps Claude working while your laptop sleeps. ccx runs there as it
does anywhere, and you can do the server's sign-ins from your laptop.

Each machine needs its own login of each account. A refresh token can be used
once, so a login copied between machines ends whichever copy renews second.

```sh
# on the server, once
npm install -g claude-auto-switch
ccx on
ccx keepalive on               # renew idle logins every four hours (cron)

# on your laptop, whenever the server needs signing in
ccx login --host my-server --all
```

`ccx login --host` asks ccx on the server which accounts need a sign-in and
registers any it is missing (the name and address, never a login). Then it
relays each sign-in: the server starts it and sends the link, your laptop's
browser approves it, and the code goes back. With Chrome started with
`--remote-debugging-port=9222` approving is automatic; otherwise ccx shows the
link and asks you to paste the code. The server's ccx still checks who signed
in, and refuses a login that belongs to a different account than the one the
profile is registered for. Only an exact Claude Code sign-in
link is approved without you seeing it; any other link on an Anthropic address is
shown for you to check, and links anywhere else are never opened.

ccx runs on the server through your login shell, which is where an npm install
puts it on the PATH. When that shell does not find node and ccx (for example,
nvm set up only in `.bashrc`, below its line that stops non-interactive shells),
either move the nvm lines into the file your login shell reads (`~/.profile`,
`~/.bash_profile` when it exists, or `~/.zprofile` for zsh) or name both:
`--remote-ccx '/home/me/.nvm/versions/node/v22.19.0/bin/node /home/me/.nvm/versions/node/v22.19.0/bin/ccx'`.

Signed in on the server itself, `ccx login` sees there is no browser and lets
Claude print the link and take the pasted code.

Logins on a shared machine are as private as that machine: anyone with root
there can read them.

## Inside Claude: `/ccx`

`/ccx` shows every account's room and swaps the current session to the one you
pick: in place in a ccx session, or, in Claude Desktop, by continuing the
conversation in a terminal. From a shell, `ccx swap [name]` does the same.

## Workers: one task, one account

A Claude Code subagent shares its parent's single login, so every subagent
spends the same account. `ccx worker` runs a task headless (`claude -p`) as its
own process, on the account ccx picks for it, for an orchestrator: a Claude
session handing work out, or a program of your own.

```sh
ccx worker --agent coder --cwd ../wt-billing --permission-mode acceptEdits \
  "Make the billing retry idempotent. Run npm test before you finish."
```

It runs as your own Claude (your agents, settings and MCP servers), spreads
across accounts other sessions are not using, and when its account runs out it
resumes the same conversation on the next one instead of starting the task
over. It prints Claude's answer (JSON by default) with the accounts that did
the work. See [workers](docs/workers.md) for the options, output, agent
definitions and parallel coders in git worktrees.

## Pages published with Claude's Artifact tool

A page Claude publishes with its Artifact tool is private to the account that
published it, and only that account can change it. With several accounts,
pages scatter, and a session on one account cannot update a page another
published. Two settings, both off by default, keep them together:

```sh
ccx config artifacts.home work        # every new page is published as "work"
ccx config artifacts.updates owner    # a change to a page goes out as the account that owns it
ccx artifacts                         # the pages ccx has recorded, and who owns each
```

For one call, ccx holds the session on the account the page belongs on: it
moves the session there in place when it is on another one, sends the call,
and moves it straight back. When the session is on that account already,
ccx still holds it there and has Claude pick up the login in its folder, since
Claude can be up to 30 seconds behind an ordinary move. Two calls for the same
account at once share one move, and the session goes back after the later
one. The session never restarts, and the account new sessions start on is not
touched. A hold ends when the call is over, when its result shows up in the
conversation, before Claude's next request after the call (even one refused
by your own hook or a permission rule), or after two minutes, whichever comes
first. If the call cannot be held there (the account is not signed in, the
session signs in with a `ccx token` of another account, it was signed in as
someone else from inside with `/login`, or `config.json` does not load), it is
refused with the reason, so a page never lands on the wrong account without
anyone knowing. A usage limit hit by the other account during the move is not
counted against the session's own.

ccx records each page a ccx session publishes while either setting is on, and
each page it deletes: a deleted page leaves `ccx artifacts`, and publishing
its file again makes a new page, on the home account when one is set. Past
512 KiB the record is folded to half that, and the pages used least recently
go first; one of those reads as unknown again until a scan. An update to a page
published before that goes out as the session's account, and ccx says so,
once for each page. `ccx artifacts scan` asks each signed-in account for the
pages it already has, with one headless Claude. It is best effort: it relies
on a Claude Code variable that is not documented (`CLAUDE_CODE_ARTIFACT=1`).

Turning either setting on adds four hooks to `~/.claude/settings.json`: three
on the Artifact tool and one that runs after each batch of tool calls and
leaves at once when no Artifact call is in it. Turning both off removes them.
The dashboard asks before it edits that file; `ccx config` edits it as soon as
you set the value. A running session picks the hooks up when its Claude next
starts. They do nothing in plain `claude`, Claude Desktop or the editor.

For one session alone, `CAS_ARTIFACTS_HOME=<account>` (or `off`) and
`CAS_ARTIFACTS_UPDATES=owner` (or `off`) in the environment of the `ccx` that
starts it take the place of the two settings. They do nothing unless the hooks
are already in `~/.claude/settings.json`.

## Commands

| Command                                  | What it does                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ccx worker [brief...]`                  | one task headless on an account, for an orchestrator (`--agent`, `--account`, `--cwd`, `--timeout`; see docs/workers.md) |
| `ccx artifacts`                          | the pages ccx has recorded, and the account that owns each (`scan`: ask each account for its pages, best effort)         |
| `ccx add <name>`                         | add an account and sign it in through the browser                                                                        |
| `ccx on` / `ccx off`                     | set up / remove ccx in your shell, editors, status line and `/ccx`                                                       |
| `ccx`                                    | status at a glance (a setup guide when nothing is set up)                                                                |
| `ccx dashboard`                          | live view with keys (alias `watch`)                                                                                      |
| `ccx usage`                              | every window on every account                                                                                            |
| `ccx use <name>`                         | make an account active and move the only running session (`--now` restarts; `--session <pid>`, `--here`, `--all`)        |
| `ccx config [key] [value]`               | every setting; one explained; one changed (`default` resets it)                                                          |
| `ccx sessions`                           | the ccx sessions running now: pid, account, folder                                                                       |
| `ccx swap [name]`                        | the room on every account; swap this session                                                                             |
| `ccx rotate`                             | switch to the next pick now                                                                                              |
| `ccx order [smart\|most-room\|priority]` | the pick rule                                                                                                            |
| `ccx models [models...]`                 | the model chain (`--strategy model-first\|account-first`)                                                                |
| `ccx priority <name> <n>`                | an account's place in your order (lower first)                                                                           |
| `ccx enable` / `disable <name>`          | include / exclude an account                                                                                             |
| `ccx proactive on\|off`                  | move before an account runs out (off by default)                                                                         |
| `ccx auto`                               | run that check once (`--once`, `--json`)                                                                                 |
| `ccx resume-prompt "<text>"`             | what a session is told after ccx moves or relaunches it (`--clear`)                                                      |
| `ccx run -- <args>`                      | run one Claude session through ccx without `ccx on`                                                                      |
| `ccx desktop [...]`                      | Claude Desktop: status, `move`, `handoff`, `mode`, `prompt`                                                              |
| `ccx login <name>` / `--all`             | sign a stale account back in                                                                                             |
| `ccx login --host <host> [name]`         | sign in a server's accounts from here, over SSH (`--all`, `--remote-ccx <path>`)                                         |
| `ccx keepalive on\|off\|status`          | renew idle logins every four hours with cron, for a machine nobody uses                                                  |
| `ccx list` / `status [name]`             | account health: email, plan, signed in, capped until                                                                     |
| `ccx doctor`                             | check the setup and who each profile really is                                                                           |
| `ccx history`                            | what ccx did to logins, sessions and your settings                                                                       |
| `ccx state`                              | everything ccx knows, as JSON                                                                                            |
| `ccx cap <name>`                         | mark an account out by hand (`--clear`)                                                                                  |
| `ccx token <name>`                       | mint a long-lived token for headless use                                                                                 |
| `ccx statusline`                         | the status line itself (`--install` prints the snippet, `--compact`)                                                     |
| `ccx setup`                              | the next setup step, wherever you are                                                                                    |
| `ccx editor on\|off`                     | set up / remove just the editor                                                                                          |
| `ccx daemon install`                     | always-on rotation outside a terminal                                                                                    |
| `ccx remove <name>`                      | remove an account (`--purge` also deletes its folder and login, once nothing is using them)                              |

## Configuration

`~/.claude-auto-switch/config.json`. Every key is optional. Change one with
`ccx config <key> <value>` or the dashboard's settings (`s`), which check the
value first; running sessions pick a change up at their next move, restart or
usage check, as `ccx config <key>` says.

| Key                                    | Default                         | Meaning                                                           |
| -------------------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| `rotation.accountOrder`                | `"smart"`                       | `smart`, `most-room` or `priority`                                |
| `rotation.holdBackAtPercent`           | `80`                            | smart: a week this full waits behind healthy accounts (`100` off) |
| `rotation.modelPreference`             | `["opus", "fable"]`             | the model chain                                                   |
| `rotation.modelStrategy`               | `"model-first"`                 | or `account-first`                                                |
| `rotation.preferSameModel`             | `true`                          | `false` ignores models and rotates on account capacity alone      |
| `rotation.proactivePercent`            | `0`                             | move once the tightest window reaches this percent (`0` is off)   |
| `rotation.proactiveHysteresisPercent`  | `10`                            | the target needs this many points more room                       |
| `rotation.usageCheckSeconds`           | `300`                           | how often a session reads its own usage                           |
| `rotation.defaultBackoffMinutes`       | `300`                           | how long an account counts as out when no reset time is known     |
| `rotation.autoRotateHeadless`          | `true`                          | headless runs (`claude -p`) rotate too                            |
| `rotation.capThresholdPercent`         | `95`                            | the daemon's threshold for treating an account as out             |
| `resume.auto`                          | `true`                          | tell a session to carry on after ccx moves or relaunches it       |
| `resume.prompt`                        | "This session was restarted..." | the carry-on prompt; a move without a restart says so instead     |
| `update.follow`                        | `true`                          | running sessions move to a newer installed ccx                    |
| `desktop.handoff`                      | `"off"`                         | `off`, `limit` or `credits`                                       |
| `desktop.mode`                         | `"fork"`                        | `fork` or `same`                                                  |
| `desktop.prompt`                       | "Carry on where you stopped."   | what a moved Desktop conversation continues with                  |
| `artifacts.home`                       | off                             | publish every new page as this account                            |
| `artifacts.updates`                    | `"off"`                         | `owner`: change a page as the account that owns it                |
| `realClaudePath`                       | found on `PATH`                 | the real `claude` binary, when finding it fails                   |
| `browser.debugPort`, `browser.channel` | `9222`, `"chrome"`              | the browser `ccx add` and `ccx login` use                         |

## What ccx writes

| Where                                    | What                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `~/.claude-auto-switch/profiles/<name>/` | each account's login, owner-only (separate Keychain entries on macOS)                        |
| `~/.claude-auto-switch/sessions/<pid>/`  | per-session config folders, cleared after the session ends                                   |
| `~/.claude-auto-switch/config.json`      | your settings                                                                                |
| `~/.claude-auto-switch/events.jsonl`     | what ccx did (`ccx history`)                                                                 |
| `~/.claude-auto-switch/rescued/`         | session changes that could not be merged back                                                |
| `~/.claude-auto-switch/artifacts.jsonl`  | each page a session published while page routing was on, and its owner                       |
| `~/.claude/settings.json`                | the `statusLine` key; the Desktop hooks and the Artifact hooks when enabled; session changes |
| `~/.claude.json`                         | session changes to your preferences, MCP servers and folder trust                            |
| `~/.claude/skills/ccx/`                  | the `/ccx` command                                                                           |
| your shell profile                       | the `claude` function                                                                        |
| Cursor / VS Code settings                | `claudeCode.environmentVariables`                                                            |
| your crontab                             | one line marked `# ccx keepalive`, only after `ccx keepalive on`                             |

To read ccx from another program, use `ccx state`; the files above are internal
and change between releases. See
[reading ccx from another program](docs/reading-ccx-from-another-program.md).

## Privacy and security

ccx talks to Anthropic only about your own accounts: reading usage, renewing a
stale login, and asking which account a login belongs to, so a login is never
stored under the wrong account. Logins come from your browser sign-in; ccx never
sees a password. See [SECURITY.md](SECURITY.md).

Using several paid accounts to extend your usage may conflict with Anthropic's
terms. Use your own judgment.

## Requirements

Node.js 20 or newer, on Windows, macOS or Linux. Installing builds
[`node-pty`](https://github.com/microsoft/node-pty), which needs your platform's
C/C++ build tools.

## Development

```sh
npm run verify   # typecheck, lint and tests
```

Tests run against a fake `claude` (`test/fake-claude/`): no real account, no
model usage.

## License

MIT. See [LICENSE](LICENSE).
