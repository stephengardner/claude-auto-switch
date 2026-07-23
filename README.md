# Claude Auto-Switch (`ccx`)

**One Claude account hits its limit? ccx moves you to the next one, automatically.**
Same conversation, same model, no interruption.

Add your Claude accounts once, run `ccx on`, then just use Claude the way you
always have, in your terminal or in Cursor / VS Code. The moment you hit a usage
cap, ccx switches you to another account that still has room and keeps going. You
never think about it again.

It runs entirely on your own machine, against your own accounts. No server, no
telemetry, nothing leaves your computer.

## Install and go

```
npm install -g claude-auto-switch

ccx add work        # log in an account (opens your browser)
ccx add personal    # add another to switch between
ccx on              # set up once: your terminal and your editor
```

That is the entire setup. Now use Claude normally.

## Using it in your terminal (Claude CLI)

After `ccx on`, just run `claude` exactly as before:

```
claude
```

ccx runs underneath, watches for the limit, and switches accounts the moment you
hit one. Nothing new to learn, nothing to remember.

> Prefer not to touch your shell? `ccx run -- <args>` runs a single session
> through ccx without installing anything.

## Using it in Cursor / VS Code

`ccx on` also points the Claude Code extension at your accounts (or run
`ccx editor on` to set up just the editor). Restart your editor, then use Claude
in it exactly as usual.

When you hit a limit, your next message picks up on a fresh account. It only
changes *which account* the editor uses, never *how* it launches Claude, so it is
completely safe: it cannot break Claude in your editor.

## What you get

- **Automatic switching** on the real usage limit, not a guess. ccx reads the
  actual "you've reached your limit" message Claude prints.
- **Your conversation continues** on the new account, in place. (If you cap on
  the very first message, it just starts fresh instead of getting stuck.)
- **A live dashboard** (`ccx dashboard`): every account at a glance, who is
  active, rested, or capped, with keys to pin, rotate, enable, or disable.
- **Isolated accounts**: each login lives in its own folder, so they never
  collide or refresh over each other.
- **Everywhere**: Windows, macOS, Linux; terminal, headless, and editor, all
  following the same active account.
- **Safe and local**: logins never leave your machine, and ccx never sees your
  password (they go through your normal browser).

## How it works

ccx runs the real Claude for you and quietly watches its output. When Claude
prints its usage-limit message, ccx marks that account capped and points your
next session at another account with headroom. There is one shared "active
account" that both your terminal and your editor follow, so a switch made
anywhere carries everywhere.

---

## Commands

The two you actually use are `ccx add` and `ccx on`. The rest are here when you
want them.

| Command | What it does |
| --- | --- |
| `ccx add <name>` | Log in an account and give it its own folder |
| `ccx on` / `off` | Set up (or remove) ccx everywhere: terminal + editors |
| `ccx editor on` / `off` | Set up (or remove) just an editor (Cursor / VS Code) |
| `ccx dashboard` (alias `watch`) | Live view of every account; keys to pin/rotate/enable |
| `ccx` | A quick status glance (or a getting-started guide if you're new) |
| `ccx setup` | Shows your next step, wherever you are in setup |
| `ccx list` / `status [name]` | Account health (email, plan, logged-in, capped-until) |
| `ccx use <name>` | Make an account active right now |
| `ccx rotate` | Switch to the next healthy account now |
| `ccx enable` / `disable <name>` | Include or exclude an account from switching |
| `ccx priority <name> <n>` | Set the order accounts are tried (lower first) |
| `ccx login <name>` / `--all` | Log a stale account back in |
| `ccx remove <name>` | Remove an account (`--purge` also deletes its folder) |
| `ccx doctor` | Sanity-check your setup |
| `ccx run -- <args>` | Run a one-off through ccx without installing the shim |

## Configuration

Everything works with no config. To tune it, add an optional
`~/.claude-auto-switch/config.json` (every key is optional):

```json
{
  "priorityOrder": ["personal", "work"],
  "rotation": { "defaultBackoffMinutes": 300 }
}
```

- `priorityOrder`: which accounts to prefer, in order (e.g. burn the personal
  one first, save work for last).
- `rotation.defaultBackoffMinutes`: how long to consider an account capped when
  Claude does not give a reset time.

## Requirements and platform notes

Node.js 20 or newer. Installing compiles one small native piece
([`node-pty`](https://github.com/microsoft/node-pty)), so you need your OS's
usual build tools (a C/C++ toolchain).

Windows and Linux switch accounts by swapping the account's login file behind the
scenes. macOS keeps logins in the Keychain, which a separate folder cannot
isolate, so on macOS each account uses a long-lived token (created once per
account with `ccx token <name>`); normal coding is unaffected. `ccx doctor` tells
you which applies to your machine.

## Your credentials stay yours

No server, no network calls of its own, no telemetry. Each account's login is the
same one Claude Code already saves, just kept in its own folder under
`~/.claude-auto-switch/`, written owner-only, and never committed. See
[SECURITY.md](SECURITY.md) for the full picture. One honest note: using several
paid accounts to stretch your usage sits in a gray area of Anthropic's terms, so
use your own judgment.

## Development

```
npm run verify   # typecheck + lint + tests
```

Tests never touch a real account or spend model usage: everything runs against a
fake `claude` (see `test/fake-claude/`).

## License

MIT. See [LICENSE](LICENSE).
