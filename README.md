# Claude Auto-Switch (`ccx`)

**Never stop working because one Claude account hit its limit.**

Add your Claude accounts once, then use Claude exactly as you always do. The
moment you hit a usage limit, `ccx` moves you to another of your accounts that
still has headroom and picks your conversation right back up, same model, same
place, without you doing anything.

Runs entirely on your own machine, against your own accounts. No server, no
telemetry, nothing leaves your computer.

```
npm install -g claude-auto-switch
ccx add work        # log in an account (opens your browser)
ccx add personal    # add another to switch between
ccx on              # set up once (your terminal + your editor)
```

That is the whole thing. Now just use `claude` like you always have, in your
terminal or in Cursor / VS Code. When `work` hits its limit mid-session, ccx
continues on `personal` without a beat. You never think about it again.

## Why you'd want this

Claude Code uses one account at a time. If you pay for more than one plan, or
share a couple with a teammate, hitting a usage limit means stopping, logging
into another account by hand, and starting your session over. ccx makes that
switch invisible: you keep working, on the same model, on the next account with
room.

## How it works (plain version)

- You run `ccx on` one time. After that you just use `claude` exactly as before,
  nothing about your habits changes.
- Behind the scenes, ccx runs the real Claude for you and watches for the
  "you've reached your limit" message.
- The instant it sees one, it switches to another of your accounts and resumes
  your conversation in the same place. If you happened to cap on your very first
  message, it just starts fresh on the new account instead of getting stuck.
- Each account lives in its own folder, so logins never step on each other.

It reacts to the real limit message Claude prints, so it triggers on the actual
per-model caps you hit, not a guess.

## Where it works, after one `ccx on`

- **Your terminal, on every OS** (Windows, macOS, Linux): just type `claude`.
- **Editors (Cursor / VS Code), on every OS**: your editor's Claude uses your
  ccx accounts too, and follows the same switches. Safe, it only changes which
  account the editor uses, never how it launches Claude.
- **Headless and scripts**: work as usual; caps switch accounts there too.

One command does it all: `ccx on` sets up the terminal and any editor you have.
(Prefer not to install the shim? `ccx run -- <args>` runs a one-off without it.)

## A live dashboard

`ccx dashboard` is a clean, auto-refreshing view of all your accounts: who is
active, who is rested, who is capped and until when. Move the cursor with
`j`/`k` and pin, enable, disable, or rotate right from the keyboard.

## Install

Requires Node.js 20+. Installing compiles one small native piece
([`node-pty`](https://github.com/microsoft/node-pty)), so you need your OS's
usual build tools (a C/C++ toolchain).

```
npm install -g claude-auto-switch
```

Or from source:

```
git clone https://github.com/stephengardner/claude-auto-switch
cd claude-auto-switch
npm install && npm run build
npm link            # puts `ccx` on your PATH
```

## Commands

The two you actually use: `ccx add` to add accounts, and `ccx on` once. After
that you just type `claude`.

| Command | What it does |
| --- | --- |
| `ccx add <name>` | Log in an account and give it its own folder |
| `ccx on` / `off` | Set up (or remove) ccx everywhere: terminal + your editors |
| `ccx dashboard` (alias `watch`) | Live view of every account; keys to pin/enable/rotate |
| `ccx` | A quick status glance (or a getting-started guide if you're new) |
| `ccx setup` | Shows your next step, wherever you are in setup |
| `ccx list` / `status [name]` | Account health (email, plan, logged-in, capped-until) |
| `ccx use <name>` | Pick which account is active right now |
| `ccx rotate` | Switch to the next healthy account now |
| `ccx enable` / `disable <name>` | Include or exclude an account from switching |
| `ccx priority <name> <n>` | Set the order accounts are tried (lower first) |
| `ccx editor on` / `off` | Set up just an editor (Cursor / VS Code) |
| `ccx login <name>` / `--all` | Log a stale account back in |
| `ccx remove <name>` | Remove an account (`--purge` also deletes its folder) |
| `ccx doctor` | Sanity-check your setup |
| `ccx run -- <args>` | Run a one-off through ccx without installing the shim |

## Platform notes

Windows and Linux switch accounts by swapping the account's login file behind the
scenes, no extra setup beyond `ccx add`. macOS keeps logins in the Keychain,
which a separate folder can't isolate, so on macOS each account uses a long-lived
token (created once with `ccx token <name>`); normal coding is unaffected. `ccx
doctor` tells you which applies to your machine.

## Your credentials stay yours

Everything runs locally against your own accounts. No server, no network calls of
its own, no telemetry.

- Each account's login is the same one Claude Code already saves, just kept in
  its own folder under `~/.claude-auto-switch/`. Nothing is committed to this
  repo, and files that hold a login are written owner-only.
- ccx never sees your password; logins go through your normal browser.

See [SECURITY.md](SECURITY.md) for the details. One honest note: using several
paid accounts to stretch your usage sits in a gray area of Anthropic's terms, so
use your own judgment.

## Configuration

Optional `~/.claude-auto-switch/config.json` (every key optional):

```json
{
  "priorityOrder": ["personal", "work"],
  "rotation": { "defaultBackoffMinutes": 300 }
}
```

## Development

```
npm run verify   # typecheck + lint + tests
```

Tests never touch a real account or spend model usage: everything runs against a
fake `claude` (see `test/fake-claude/`).

## License

MIT. See [LICENSE](LICENSE).
