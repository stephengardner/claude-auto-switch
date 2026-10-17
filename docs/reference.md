# Reference

## Commands

| Command                                  | What it does                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ccx worker [brief...]`                  | one task headless on an account, for an orchestrator (`--agent`, `--account`, `--cwd`, `--timeout`; see [workers](workers.md)) |
| `ccx artifacts`                          | the pages ccx has recorded, and the account that owns each (`scan`: ask each account for its pages, best effort)               |
| `ccx add <name>`                         | add an account and sign it in through the browser                                                                              |
| `ccx on` / `ccx off`                     | set up / remove ccx in every shell you use, editors, status line and `/ccx` (`--shell <name>`: one shell)                      |
| `ccx`                                    | status at a glance (a setup guide when nothing is set up)                                                                      |
| `ccx dashboard`                          | live view with keys (alias `watch`)                                                                                            |
| `ccx usage`                              | every window on every account                                                                                                  |
| `ccx use <name>`                         | make an account active and move the only running session (`--now` restarts; `--session <pid>`, `--here`, `--all`)              |
| `ccx config [key] [value]`               | every setting; one explained; one changed (`default` resets it)                                                                |
| `ccx sessions`                           | the ccx sessions running now: pid, account, folder                                                                             |
| `ccx swap [name]`                        | the room on every account; swap this session                                                                                   |
| `ccx rotate`                             | switch to the next pick now                                                                                                    |
| `ccx order [smart\|most-room\|priority]` | the pick rule                                                                                                                  |
| `ccx models [models...]`                 | the model chain (`--strategy model-first\|account-first`)                                                                      |
| `ccx priority <name> <n>`                | an account's place in your order (lower first)                                                                                 |
| `ccx enable` / `disable <name>`          | include / exclude an account                                                                                                   |
| `ccx proactive on\|off`                  | move before an account runs out (off by default)                                                                               |
| `ccx auto`                               | run that check once (`--once`, `--json`)                                                                                       |
| `ccx resume-prompt "<text>"`             | what a session is told after ccx moves or relaunches it (`--clear`)                                                            |
| `ccx run -- <args>`                      | run one Claude session through ccx without `ccx on`                                                                            |
| `ccx desktop [...]`                      | Claude Desktop: status, `move`, `handoff`, `mode`, `prompt`                                                                    |
| `ccx login <name>` / `--all`             | sign a stale account back in                                                                                                   |
| `ccx login --host <host> [name]`         | sign in a server's accounts from here, over SSH (`--all`, `--remote-ccx <path>`)                                               |
| `ccx keepalive on\|off\|status`          | renew idle logins every four hours with cron, for a machine nobody uses                                                        |
| `ccx list` / `status [name]`             | account health: email, plan, signed in, capped until                                                                           |
| `ccx doctor`                             | check the setup, shell by shell, and who each profile really is (`--fix`: repair a broken npm install of Claude first)         |
| `ccx history`                            | what ccx did to logins, sessions and your settings                                                                             |
| `ccx state`                              | everything ccx knows, as JSON (see [reading ccx from another program](reading-ccx-from-another-program.md))                    |
| `ccx cap <name>`                         | mark an account out by hand (`--clear`)                                                                                        |
| `ccx token <name>`                       | mint a long-lived token for headless use                                                                                       |
| `ccx statusline`                         | the status line itself (`--install` prints the snippet, `--compact`)                                                           |
| `ccx setup`                              | the next setup step, wherever you are                                                                                          |
| `ccx editor on\|off`                     | set up / remove just the editor                                                                                                |
| `ccx daemon install`                     | always-on rotation outside a terminal                                                                                          |
| `ccx remove <name>`                      | remove an account (`--purge` also deletes its folder and login, once nothing is using them)                                    |

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
| each shell's startup files               | the `claude` function (`.zshrc`, `.bashrc`, bash's login file, PowerShell's `profile.ps1`)   |
| Cursor / VS Code settings                | `claudeCode.environmentVariables`                                                            |
| your crontab                             | one line marked `# ccx keepalive`, only after `ccx keepalive on`                             |

To read ccx from another program, use `ccx state`; the files above are internal
and change between releases. See
[reading ccx from another program](reading-ccx-from-another-program.md).
