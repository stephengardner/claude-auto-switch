# Claude Auto-Switch (`ccx`)

Stay in flow across your Claude usage limits. When the account you're working on
hits its model cap, Claude Auto-Switch detects it, switches to another of your
accounts that still has headroom, and continues the same conversation, in place,
without you doing anything.

It runs entirely on your own machine, against your own accounts.

> Validated on Windows and Linux. macOS uses a token-based path (see
> [Platform support](#platform-support)).

## Why

Claude Code stores one account per config directory. If you have more than one
subscription and you hit a model's usage limit mid-session, you normally have to
stop, switch accounts by hand, and start over. Claude Auto-Switch makes that
switch automatic and invisible: you keep working, on the same model, on the next
account with headroom.

## How it works

- **You keep typing `claude`.** A small `PATH` shim (the same trick `pyenv` and
  `nvm` use) routes it through `ccx`. In editors, point the extension's
  "Claude process wrapper" setting at `ccx`. Nothing about how you work changes.
- **`ccx` becomes the invisible parent of the session.** It runs the real
  `claude` inside a pseudo-terminal, relays it to your terminal transparently,
  and watches the output for the usage-limit message.
- **On a cap, it hot-swaps.** It switches the active account to one with
  headroom and relaunches your conversation with `--continue`, in the same
  place. If there is nothing to resume (you capped on the very first message),
  it starts a fresh session on the new account instead of dead-ending.
- **Each account is isolated.** Every account gets its own profile folder, so
  logins and token refreshes never collide.

Detection is based on the actual limit message Claude prints (the usage cache on
disk is not reliable for this), so it works for the real, per-model caps you
actually hit.

## Install

Requires Node.js 20+. Installing compiles a small native dependency
([`node-pty`](https://github.com/microsoft/node-pty)), so you need the usual
build tools for your OS (a C/C++ toolchain).

```
npm install -g claude-auto-switch
```

Or from source:

```
git clone https://github.com/stephengardner/claude-auto-switch
cd claude-auto-switch
npm install
npm run build
npm link            # puts `ccx` on your PATH
```

## Quick start

```
ccx add work        # register an account and log it in (opens your browser)
ccx add personal    # repeat for each account you want to rotate between
ccx dashboard       # live view of every account (or `ccx list` for a one-shot)
ccx run             # start a Claude session that auto-switches on a cap
```

Use `ccx run` exactly like `claude`. Pass arguments through after the command
(for example `ccx run -- -p "summarize this repo"`). To make plain `claude`
route through it, install the transparent shim with `ccx on`.

## Commands

| Command | What it does |
| --- | --- |
| `ccx add <name>` | Register a new account (its own profile) and log it in |
| `ccx run [-- <args>]` | Run a Claude session that hot-swaps accounts on a cap |
| `ccx dashboard` (alias `watch`) | Live, auto-refreshing view of every account; keys to pin/enable/rotate |
| `ccx list` | Every account with live health (email, plan, logged-in, capped-until) |
| `ccx status [name]` | Detailed health for one or all accounts |
| `ccx use <name>` | Pin which account a new session starts on |
| `ccx rotate` | Manually switch to the next healthy account |
| `ccx enable` / `disable <name>` | Include or exclude an account from rotation |
| `ccx priority <name> <n>` | Set rotation order (lower is preferred first) |
| `ccx cap <name>` | Manually mark or clear a cap (`--until` / `--minutes` / `--clear`) |
| `ccx login <name>` / `--all` | Repair a logged-out account via the browser |
| `ccx remove <name>` | Deregister an account (add `--purge` to delete its folder) |
| `ccx on` / `ccx off` | Install / remove the transparent `claude` shim |
| `ccx doctor` | Verify config, git-safety, and the resolved `claude` binary |

## Platform support

- **Windows and Linux:** rotation swaps the account's credential file into one
  reused session directory. No extra setup beyond `ccx add`.
- **macOS:** credentials live in the Keychain, which a separate config directory
  does not isolate, so macOS rotates by swapping a long-lived token
  (`CLAUDE_CODE_OAUTH_TOKEN`, minted once per account with `ccx token <name>`).
  A token can only make model requests, so Remote Control and claude.ai
  connectors are unavailable under it; normal coding is unaffected. `ccx doctor`
  detects which mechanism your machine needs.

## Configuration

Optional `~/.claude-auto-switch/config.json` (all keys optional):

```json
{
  "priorityOrder": ["personal", "work"],
  "rotation": { "capThresholdPercent": 95, "defaultBackoffMinutes": 300 }
}
```

Environment overrides use the `CAS_` prefix (for example `CAS_BROWSER_DEBUG_PORT`).

## Your credentials stay yours

Everything runs locally against your own accounts. There is no server, no
network call of its own, and no telemetry.

- Each account's login is the same one Claude Code already saves, just kept in
  its own folder under `~/.claude-auto-switch/`. Nothing is ever committed to
  this repo, and files that hold a login are written owner-only.
- It never sees your password; logins go through your normal browser.

More detail in [SECURITY.md](SECURITY.md). One thing worth knowing: rotating
across multiple paid accounts to stretch your usage is a gray area of
Anthropic's terms, so use your own judgment there.

## Development

```
npm run verify   # typecheck + lint + tests
npm test         # tests only
```

Tests never touch a real account or spend model tokens: everything routes
through a fake `claude` (see `test/fake-claude/`).

## License

MIT. See [LICENSE](LICENSE).
