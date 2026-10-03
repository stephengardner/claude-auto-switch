# Claude Auto-Switch (`ccx`)

**One Claude account hits its limit? ccx moves you to the next one, automatically.**
Same conversation, same model, no interruption.

Add your Claude accounts once, run `ccx on`, then use Claude the way you always
have, in your terminal or in Cursor / VS Code. The moment you hit a usage limit,
ccx checks that the limit is real, moves you to an account that still has room,
and carries your conversation with it. You never think about it again.

It runs on your own machine against your own accounts. There is no server of
ours, and no telemetry.

![The ccx dashboard: every account, what it has left, and which one is in use](docs/img/dashboard.svg)

## Install and go

```sh
npm install -g claude-auto-switch

ccx add work        # log in an account (opens your browser)
ccx add personal    # add another to switch between
ccx on              # set up once: terminal, editor, status line, /ccx
```

That is the entire setup. Now use Claude normally.

`ccx on` does four things and tells you about each one: it makes `claude` run
through ccx in your shell, points the Claude Code editor extension at your
accounts, adds a line to Claude's own status bar so you can always see which
account you are on, and adds `/ccx` to Claude so you can see every account and
swap from inside a session. `ccx off` undoes all four.

> Adding a second account? Your browser is still signed in to the first one, so
> sign out at claude.ai first (or use a different browser profile). Otherwise
> both profiles end up holding the same account, and that is worse than useless:
> signing in again replaces a login, so renewing one profile would end the other.
> ccx **refuses** that sign-in: the profile goes back to the login it had before,
> or, if it had none, the refused login is removed rather than left active. So
> you cannot end up there by accident, whichever command you used.
> `ccx doctor` checks for it at any time.

## Using it in your terminal

After `ccx on`, just run `claude` exactly as before:

```sh
claude
```

ccx runs underneath, watches for the limit, and switches accounts the moment you
hit one. Nothing new to learn, nothing to remember.

> Prefer not to touch your shell? `ccx run -- <args>` runs a single session
> through ccx without installing anything.

## Using it in Cursor / VS Code

`ccx on` also points the Claude Code extension at your accounts (or run
`ccx editor on` for just the editor). Restart your editor and use Claude in it as
usual. It only changes _which account_ the editor uses, never _how_ it launches
Claude, so it cannot break Claude in your editor.

## Using it with Claude Desktop

Claude Desktop runs its conversations on the account the Desktop app itself is
signed into. It hands each conversation that login on its own, so nothing
outside Desktop can switch a Desktop conversation to another account, ccx
included. What ccx does instead is move a conversation from Desktop to a
terminal window, where it does switch accounts: the conversation keeps all its
history (Desktop and ccx share Claude's conversation store), picks up on the
same model, effort and permission mode it had in Desktop, and carries on by
itself.

```sh
ccx desktop                  # which account Desktop spends, and what is open there
ccx desktop move 2           # carry conversation 2 on in a terminal
ccx desktop move 2 --wait    # the same, picking it up the moment Desktop stops
ccx desktop handoff credits  # do it by itself (off | limit | credits)
```

- `handoff limit` moves a conversation by itself when a Desktop turn ends on a
  usage limit.
- `handoff credits` does that too, and also holds back a message sent in Desktop
  once its account is past its plan, so it never spends usage credits: the
  conversation continues in a terminal on an account with room, with your
  message. A message too long to carry over (more than 15,000 characters) goes
  to Desktop as usual instead of being held.
- Both are hooks in `~/.claude/settings.json` that run node with ccx's hook
  script directly, with no shell, so they work the same whichever shell Claude
  would use. Every Claude session runs them, and anything that is not Desktop
  is gone before ccx is even loaded. `ccx doctor` checks they still point at
  your ccx, and `ccx on` points them at it again after an update.
- A moved conversation continues as a copy by default, so Desktop keeps the
  original exactly as it was (`ccx desktop mode fork`). `ccx desktop mode same`
  continues the conversation itself, so reopening it in Desktop later shows the
  work; send nothing to it in Desktop while the terminal carries on.
- It carries on with "Carry on where you stopped." unless you set
  `ccx desktop prompt "<text>"`.

The dashboard shows Desktop's line too, with keys for all of it: `d` steps
through when conversations move by themselves, `m` copy or same (both ask
first), `t` the carry-on text, and `D` moves one. Desktop's own built-in
terminal pane loads your shell profile, so `claude` typed there already runs
through ccx.

## Swapping from inside Claude: /ccx

Type `/ccx` (or `/ccx swap`) in any Claude session, including Claude Desktop.
It shows every account's 5-hour, weekly and model usage as bars, what is spent
and when it comes back, and which account has the most room, then asks which
one to move to. In a ccx session the swap happens in place and nothing
restarts; in Claude Desktop the conversation continues in a terminal on the
account you pick, once the reply ends. `/ccx status` shows the board only.
From a terminal, `ccx swap` draws the same board and `ccx swap <name>` swaps.

## Knowing where you stand

Running out of room is much less annoying when you can see it coming.

**In Claude itself.** `ccx on` puts the account and its remaining room into
Claude's own status line, so every session shows where you stand:

```sh
work Fable 87% left              plenty of room
work Fable 22% left              getting low
! work Fable spent resets 10h    out, and when it comes back
```

Restart Claude once after `ccx on` to see it. This works the same on a new
machine: it is part of setup, not something to remember.

Already have a status line? You keep it. ccx runs yours and adds its part to the
end, and `ccx off` puts your original back exactly as it was. Nothing else in
your settings is touched, and a settings file ccx cannot parse is left alone
rather than rewritten.

Prefer to wire it yourself? `ccx on --no-statusline` skips it, and
`ccx statusline --install` prints the snippet to paste. `--compact` drops the
account name if your line already shows it.

**On demand.** `ccx usage` spells out every window on every account, what is
closest to stopping each one, and where there is room right now:

![ccx usage: every window per account, with a bar, a percentage and when it comes back](docs/img/usage.svg)

Look at `personal` there. It is at 0% for the hour and 68% for the week, and it
still cannot run Fable, because that one model's window is spent. A single
"usage" number would hide that in one direction or the other, so ccx never shows
one: it names the window that will actually stop you, and it keeps offering that
account for the models that still work.

**Live.** `ccx dashboard` is a running view of the same thing, with keys to act
on it: `enter` to switch, `f` to switch instantly, `a` to add an account, `n` to
rename one, `l` to sign one in again, `e` to enable or disable, `r` to rotate.
The `#` column is each account's place in the order rotation picks from (1 is
next), and a settings line shows which model sessions prefer and how the next
account is picked, with the keys that change them: `M` cycles the model
preference, `o` the pick rule, and `[` and `]` move the highlighted account up
or down your priority order.

It also answers the question the numbers are really being read for, on the
`next →` line:

```sh
next → staying here, on fable (46% left)
next → over on phx, on fable (80% left)
next → staying here, on opus (changed)
```

That is not a guess. It runs the same planner the switch itself runs, over the
same usage figures and the same rule you configured, so it tells you where you
will land, which model you will be on, and whether the model is about to change.
No other tool can say it: it needs your usage, your policy and what this run has
already spent, together.

## Building something on top of it

`ccx state` prints everything ccx knows as JSON: every account, what it has
left, whether it can be used right now and when it comes back, and where
rotation goes next. It is built the same way the live dashboard is, so both
judge the state by the same rules.

```sh
ccx state
```

That is the supported way to read ccx from another program. The files under
`~/.claude-auto-switch/` are ccx's own bookkeeping and change shape between
releases. See [reading ccx from another
program](docs/reading-ccx-from-another-program.md).

## What you get

- **Switching on a real limit, not a guess.** Claude's limit message only starts
  the check; ccx then asks Anthropic whether that account is genuinely out
  before moving you. Text on screen can be a replay, or your own code talking
  about rate limits, and neither should cost you your session.
- **Your conversation continues** on the new account, in place.
- **It is your own Claude, but for the account.** A ccx session runs Claude on
  a folder of its own, because that is the only place Claude reads its login
  from, and a login per session is what lets one session change account in
  place. Everything else is yours: `/resume`, prompt history, `/rewind`
  checkpoints, plugins, skills, agents, todos and memory are your normal
  `~/.claude`, whether you launch Claude through ccx or not. A session starts
  from your real `settings.json`, and what Claude saves during it (a model
  picked with `/model`, a permission allowed for good, an MCP server, a
  trusted folder, a theme) is saved back to your own files, where plain
  `claude` reads it. If you changed the same thing elsewhere meanwhile, your
  change wins. What ccx _adds_ to `~/.claude` is its own and comes back out
  with `ccx off`: the `statusLine` key, the `/ccx` skill, and the two Claude
  Desktop hooks when you turn the handoff on.
- **Careful with your logins.** Credentials are written whole or not at all, the
  previous one is always kept, and a signed-out or damaged credential is never
  written over a good account. Before a login is copied into an account, ccx
  asks Anthropic who it belongs to, so signing in as someone else mid-session
  cannot land in the wrong account.
- **It checks before it starts, not after.** A login that has expired is renewed
  before the session begins. One that is genuinely finished is named, with the
  command that fixes it, instead of turning into Claude saying you are logged
  out for no visible reason.
- **It stays out of your way.** While Claude is running it owns the screen, so
  ccx says nothing there: it uses the terminal's own notification, the window
  title, and a log you can read later with `ccx history`.
- **Honest about what it can see.** `ccx doctor` asks Anthropic who each profile
  is really signed in as, which is the only way to catch a profile holding the
  wrong account or two profiles sharing one login.
- **It follows the model you are on.** A spent model window stops that model, not
  the account, so ccx looks for another account that still has room on the SAME
  model before it considers anything else. Only when none does will it change
  model, in a configurable order (Fable then Opus by default), and it tells you
  when that happens.
- **Optional: move before you run out.** Off by default. `ccx proactive on` hands
  the session to a roomier account as the current one approaches its limit,
  rather than waiting to hit the wall.
- **Everywhere**: Windows, macOS, Linux; terminal, headless, and editor, all
  following the same active account.

## How it works

ccx runs the real Claude for you and follows the conversation's own record,
which Claude keeps on disk. When Claude records a turn as refused for usage (it
writes each one with its own codes, never needing anyone to read the screen),
ccx confirms it against your account's real usage, marks that account as out,
and moves your session to one with room, continuing the conversation. Words on
the screen decide nothing, so a session whose work is about limits is never
moved for talking about them. There is one shared "active account" that your
terminal and your editor both follow, so a switch made anywhere carries
everywhere.

Switching a running session is seamless: ccx swaps the login underneath it and
Claude picks it up within about half a minute, with nothing restarted. When you
want it immediately instead, `ccx use <name> --now` restarts the session on the
new account and resumes the same conversation.

A restarted session carries on by itself. Every relaunch, usually on another
account, tells it to carry on where it stopped, or, if its work was already
finished, to say so in one line and wait; an unattended session, a long
autonomous run, keeps going instead of waiting for someone to type. When a
session hits a verified usage limit it is relaunched rather than switched in
place for the same reason: the limit ended the turn it interrupted, and only a
relaunch can tell it to pick that turn back up. A switch made in place, such as
a seamless `ccx use` or a proactive move, says nothing: it does not interrupt
the session, so there is nothing to pick back up.

A session can say something else instead: `ccx resume-prompt "<text>"` from
inside it (it finds itself through the config folder Claude runs with), or for
one named with `--session <pid>` or `--here`. `--clear` makes that session come
back silent, and `resume.auto` in the config turns carrying on off everywhere.
Or start a session armed: `ccx run --resume-prompt "<text>" -- --resume <id>`
picks that conversation up with the prompt at once, and keeps it for every swap
after. A fresh conversation started because there was nothing to resume never
gets it.

Running sessions take updates by themselves. When a newer ccx is installed,
each session moves to it in the same terminal, on the same conversation and
account: when Claude is being relaunched anyway, or once it has been idle for
twenty seconds, never in the middle of a turn. On Windows, sessions load their
terminal library from a copy of their own, so `npm install -g` works while they
run (`update.follow` in the config turns the moving off).

A swap resumes the conversation that is actually on screen, even after `/clear`
or `/resume`, and even in a session started with `--continue` or the picker:
ccx follows Claude's own record of which conversation each session is in.

---

## Commands

The two you actually use are `ccx add` and `ccx on`. The rest are here when you
want them.

| Command                           | What it does                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ccx add <name>`                  | Log in an account and give it its own folder                                                                                                                        |
| `ccx on` / `off`                  | Set up (or remove) ccx everywhere: terminal, editors, status line, `/ccx`                                                                                           |
| `ccx editor on` / `off`           | Set up (or remove) just an editor (Cursor / VS Code)                                                                                                                |
| `ccx swap [name]`                 | Every account's room as bars; swap the session you are in to `name` (`/ccx` inside Claude)                                                                          |
| `ccx desktop`                     | Claude Desktop: which account it spends, its open conversations; `move [n]` (`--wait`, `--to`), `handoff off\|limit\|credits`, `mode fork\|same`, `prompt "<text>"` |
| `ccx`                             | A quick status glance (or a getting-started guide if you're new)                                                                                                    |
| `ccx usage`                       | Real usage per account: hourly, weekly, and per model                                                                                                               |
| `ccx statusline`                  | One line for Claude's status line (`--wrap`, `--compact`)                                                                                                           |
| `ccx dashboard` (alias `watch`)   | Live view of every account, with keys to act                                                                                                                        |
| `ccx doctor`                      | Check the whole setup, including who each profile really is                                                                                                         |
| `ccx use <name>`                  | Make an account active (`--now` to switch instantly)                                                                                                                |
| `ccx resume-prompt "<text>"`      | What a session says to itself after a restart, instead of the default (`--clear` for nothing, `--session <pid>`, `--here`)                                          |
| `ccx rotate`                      | Switch to the next healthy account now                                                                                                                              |
| `ccx order [smart\|most-room\|priority]` | Which account to reach for first: longest runway (default), least-used, or by priority                                                                       |
| `ccx proactive on` / `off`        | Move to a roomier account before running out                                                                                                                        |
| `ccx auto`                        | Do that check once now (`--once`, `--json`, for scripts)                                                                                                            |
| `ccx list` / `status [name]`      | Account health (email, plan, signed in, capped until)                                                                                                               |
| `ccx enable` / `disable <name>`   | Include or exclude an account from switching                                                                                                                        |
| `ccx priority <name> <n>`         | Set an account's priority: the tiebreak by default, the full order under `ccx order priority` (lower first)                                                         |
| `ccx login <name>` / `--all`      | Sign a stale account back in                                                                                                                                        |
| `ccx remove <name>`               | Remove an account (`--purge` also deletes its folder)                                                                                                               |
| `ccx setup`                       | Shows your next step, wherever you are in setup                                                                                                                     |
| `ccx history`                     | What ccx has done to your logins, and when                                                                                                                          |
| `ccx cap <name>`                  | Mark an account limited by hand, or `--clear` one that is not                                                                                                       |
| `ccx daemon install`              | Always-on rotation, including outside a terminal                                                                                                                    |
| `ccx run -- <args>`               | Run a one-off through ccx without installing the shim (`--resume-prompt "<text>"` to start armed)                                                                   |

## Configuration

Everything works with no config. To tune it, add an optional
`~/.claude-auto-switch/config.json` (every key is optional):

```json
{
  "rotation": {
    "accountOrder": "smart",
    "modelPreference": ["opus", "fable"],
    "modelStrategy": "model-first",
    "preferSameModel": true,
    "defaultBackoffMinutes": 300,
    "proactivePercent": 0,
    "usageCheckSeconds": 300
  }
}
```

### Which account is next

`ccx order` shows and sets this, and so does `o` in the dashboard.

- **smart** (the default) goes where work can run longest: how much of a
  5-hour window's work the account can still do before any window stops it.
  The weekly window counts too, converted into 5-hour windows through what one
  full 5-hour window costs that account's week, which ccx learns from its own
  readings (it starts by assuming a tenth of a week). So an account whose
  5-hour window is 90% used is a poor move however much of its week is left,
  and so is one whose week is 99% used however fresh its 5-hour window.
  Between accounts that can run about as long, the one whose leftover weekly
  budget would expire unused soonest goes first, then your priority order.
  An account with less than a quarter of a window left is used only when
  nothing better exists: a move rereads the whole conversation on the new
  account, and that would use up most of it.
- **most-room** goes to the least-used account, by the tighter of its 5-hour
  and weekly percentages.
- **priority** follows your own order, lowest number first.

A pinned account (`ccx use`) wins under all three.

### Which runs out first, the model or the account

`ccx models` shows and sets this, and so does `M` in the dashboard; the config
keys are there if you prefer to edit the file.

```sh
ccx models                            what you have now
ccx models opus fable                 use Opus, fall back to Fable (the default)
ccx models opus                       only ever Opus, never fall back
ccx models --strategy account-first   use each account up instead
```

`modelStrategy` picks the rule rotation follows:

- **model-first** (the default) uses up the CURRENT MODEL everywhere before
  changing model: Opus on every account, and only when the last one is gone
  does it fall back to Fable and start again from your first account. This is
  what "stay on Opus as long as possible" means.
- **account-first** uses up each ACCOUNT before moving on: Opus then Fable on
  this account, then the same on the next one.

`modelPreference` is the chain both strategies walk. A chain of one
(`["opus"]`) means never fall back: when Opus is gone everywhere ccx says so
rather than moving you to a model you did not choose. `preferSameModel: false`
ignores models entirely and rotates on account limits alone (interactive
sessions only; headless runs always plan by model).

Both ways of running follow this: an interactive session and a headless
`ccx -p ...` request use the same planner, so the setting means one thing.

This applies only when a model is actually in play, meaning you passed
`--model` or set one in your `settings.json` (`/model` does). With nothing set,
Claude picks its own default, ccx has no way to read which one that is, and
imposing a model you never asked for would be the wrong answer. Those sessions
rotate on account capacity alone.

- `rotation.accountOrder`: how the next account is picked (see "Which account
  is next" above). Your own priority order is set per account, with
  `ccx priority <name> <n>` or `[` and `]` in the dashboard (for example, burn
  the personal one first and save work for last).
- `rotation.defaultBackoffMinutes`: how long to treat an account as out when
  Claude does not say when it resets.
- `rotation.proactivePercent`: move off an account once its binding limit reaches
  this percent. `0` is off, which is the default; `ccx proactive on` sets it.
- `rotation.usageCheckSeconds`: how often a running session checks its own usage.

## Requirements and platform notes

Node.js 20 or newer. Installing compiles one small native piece
([`node-pty`](https://github.com/microsoft/node-pty)), so you need your OS's
usual build tools (a C/C++ toolchain).

Windows and Linux store account logins in credential files. On macOS, ccx also
reads each profile's separate Claude Code Keychain entry, so `ccx add` and
`ccx login` work with normal browser sign-in. Account checks, usage probes, and
renewals use the same credential store. Existing Keychain entries stay in
Keychain; session copies and rollback snapshots use owner-only files. Renaming
a Keychain-backed account keeps its folder path because the Keychain entry is
bound to that path. The existing `ccx token <name>` flow remains available.

## Your credentials stay yours

There is no server of ours and no telemetry. ccx talks to Anthropic for exactly
three things, all about your own accounts: reading your usage, renewing your own
login when it goes stale, and asking which account a login belongs to. That last
one is what stops a login being copied into the wrong account, and it is asked
only when a stored login changes. Nothing else leaves your machine.

Each account's login is the same one Claude Code already saves. File-backed
logins are kept in per-account folders under `~/.claude-auto-switch/`, written
owner-only; macOS Keychain-backed logins use separate Claude Code Keychain
entries for each account. Credentials remain yours and are never committed.
Logins are created through your normal browser, so ccx never sees your password.
See [SECURITY.md](SECURITY.md) for the full picture.

One honest note: using several paid accounts to stretch your usage sits in a gray
area of Anthropic's terms, so use your own judgment.

## Development

```sh
npm run verify   # typecheck + lint + tests
```

Tests never touch a real account or spend model usage: everything runs against a
fake `claude` (see `test/fake-claude/`).

## License

MIT. See [LICENSE](LICENSE).
