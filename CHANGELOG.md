# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
semantic versioning.

## [1.10.2]

### Fixed

- **No more false "every account is capped" cascade.** When one account really
  hit its limit, rotating to the next relaunched it with `--continue`, which
  replays the prior conversation and re-renders that cap message; the watcher
  matched the replayed text and falsely capped every account in turn (and the
  rapid churn could corrupt a login). Cap detection is now gated on user
  activity, so a cap message shown at startup or during a `--continue` replay
  (before you have typed) is treated as historical, not a fresh cap.
- **A corrupt or half-written session credential can no longer overwrite a good
  account login** (guards against a killed OAuth refresh logging an account out).
- **Quitting the dashboard with `q` exits immediately**, instead of leaving a
  dangling refresh timer that kept the process (and the terminal) hung.

## [1.10.1]

### Fixed

- **`ccx on` now sets up your editor even when `settings.json` has comments.**
  Editor settings are JSONC (comments and trailing commas are allowed), which
  plain JSON parsing rejects, so ccx used to refuse with a "could not safely
  parse" warning and silently skip the editor setup for most VS Code / Cursor
  users. It now reads and edits JSONC safely, applying minimal edits that
  preserve every comment and your formatting, backs the file up first, and still
  refuses only a genuinely malformed file.

## [1.10.0]

### Changed

- **Switching a running session is now seamless by default.** Picking an account
  (dashboard Enter, or `ccx use <name>`) swaps the credential file under the
  running session; Claude re-reads it within ~30s (its credential cache TTL) and
  the SAME session moves to the new account, no restart, nothing lost. Before,
  the switch restarted the session with `--continue`, which reloaded the TUI and
  lost live state.

### Added

- **Force-now (instant) switch** for when you want it immediately: `ccx use <name>
  --now`, or press `f` on a row in the live dashboard. This keeps the old instant
  behavior (restart + `--continue`), trading the TUI reload for zero latency.

## [1.9.0]

### Added

- **Switch a running session in place.** Pick an account in the live dashboard
  (Enter) or run `ccx use <name>` while a session is running, and that session
  swaps to the chosen account and resumes the SAME conversation with `--continue`,
  no restart. Before this, picking an account only affected your next session;
  now it reaches the session you are already in. (Caps still auto-switch as
  before.) A logged-out or already-current pick is ignored.

## [1.8.4]

### Fixed

- **Dashboard: press Enter to use the account under the cursor.** The live
  dashboard now activates the highlighted account when you press Enter (or `u`),
  so you can pick any account, including the 3rd or 4th, not just cycle the top
  two with `r rotate`. The footer hint is now `enter use`; the old `p pin` label
  was misleading (it silently did the same thing). Your next `claude`, in the
  terminal and the editor, uses the account you pick.

## [1.8.3]

### Fixed

- `ccx on` now installs the transparent `claude` shim into the PowerShell
  profile your shell actually loads. It asks PowerShell for its real `$PROFILE`
  and falls back to the OneDrive-redirected Documents folder, so on the common
  Windows setup where OneDrive redirects Documents the shim no longer lands in a
  profile that never loads. Before this, `claude` kept running the real binary
  and nothing auto-switched, including inside the Cursor / VS Code terminal.

## [1.1.0]

### Added

- **Always-on daemon** (`ccx daemon`): makes rotation happen everywhere with zero
  action, including the IDE extension. It points the OS-level `CLAUDE_CONFIG_DIR`
  at a junction it controls, so every Claude client follows the active account.
- **Free limit detection** by watching `usage-cache.json` (percent used, reset
  times, rate-limited flag), the signal Claude Code already shares across
  clients. Rotates proactively at `capThresholdPercent` (default 95%) to the
  account with the most headroom.
- `ccx daemon install` / `uninstall` (junction + env var, never touches
  `~/.claude`), `status`, `start` / `stop` (background watcher), and `run`
  (foreground).

## [1.8.1]

### Fixed

- The editor uses its own pointer (`editor-active`) instead of sharing the
  daemon's `active` link, so `ccx editor off` and `ccx daemon uninstall` no
  longer disturb each other.

## [1.8.0]

### Added

- `ccx doctor` now reports editor integration status (which editors are set up).

### Verified

- Traced the Cursor / VS Code extension's own code: it reads the
  `environmentVariables` setting and injects it into the Claude process. Combined
  with the pointer resolving to the active account, the editor path is confirmed
  end to end from the extension's actual code.

## [1.7.1]

### Changed

- Messaging centered on "set up once with `ccx on`, then just use `claude`".

## [1.7.0]

### Changed

- **Nicer dashboard**: a framed layout with rules, colored status dots, and
  clearer active/selected markers. No faked data (no usage bar without real,
  fresh usage numbers).

### Added

- **Safe, all-platform editor integration**: `ccx editor on` points Cursor /
  VS Code at your active account via `CLAUDE_CONFIG_DIR`, and the pointer follows
  your account switches (including terminal caps). It never changes how the
  editor launches Claude, so there is no risk to your editor.

## [1.6.0]

### Changed

- Friendlier, clearer README that leads with the value and states plainly where
  it works (terminal everywhere; editors on macOS/Linux; Windows editor support
  in progress).

### Fixed

- The editor launcher now runs the exact command an editor hands it, on the
  chosen account (correct wrapper behavior).
- `ccx editor on` refuses safely on Windows (where the extension cannot launch
  the wrapper yet) instead of breaking Claude in the editor.

## [1.5.0]

### Added

- **Dashboard priority column** (`PRI`), completing the account fields the
  dashboard shows (account, email, plan, status, active, priority, events).
- **`ccx setup`**: a state-aware onboarding guide that prints the single clearest
  next step for where you are.
- **First-run shim tip**: after your first `ccx run`, a one-time tip points you
  to `ccx on` for transparent `claude`.

## [1.4.0]

### Added

- **Live swap events**: `ccx dashboard` shows swaps as they happen, via a shared
  event log that `ccx run` writes to, so an open dashboard reacts to a session
  running in another terminal.
- **Smart bare `ccx`**: running `ccx` with no command shows a getting-started
  guide (when no accounts exist) or a quick status glance (when they do),
  instead of raw help.

## [1.3.0]

### Added

- **Live dashboard** (`ccx dashboard`, alias `ccx watch`): an auto-refreshing
  view of every account (status, active marker, capped-until) with a selection
  cursor and keys to pin, enable/disable, and rotate without leaving the screen.
  `--once` prints a single frame for scripts.

## [1.2.0]

### Added

- **Transparent hot-swap**: run Claude Code through `ccx` and it switches to
  another account when the active one hits its model cap, continuing the same
  conversation in place.

### Security

- Account names validated and destructive operations contained to the profiles
  tree; credential/identity/token files written owner-only; Windows resolves the
  real `claude` binary; malformed config fails cleanly.

## [1.0.0]

### Added

- **Foundation** (Phase 1): isolated per-account profiles, health probing via
  `claude auth status`, the account registry, the selector policy, the launcher,
  and the `ccx` commands (`add`, `list`, `status`, `use`, `rotate`, `run`,
  `remove`), the transparent shim (`ccx on` / `off`), and `ccx doctor`.
- **Rotation brain** (Phase 2): a rate-limit ledger, cap detection, auto-rotate
  on cap for headless runs, `ccx cap` for manual caps, and a `CAPPED UNTIL`
  column in `ccx list`.
- **Real-browser auto-login** (Phase 3): `ccx login <name>` / `--all` drives your
  real Chrome over the DevTools protocol to click Authorize, plus a browser-port
  reachability check in `ccx doctor`.
- **Polish** (Phase 4): `ccx enable` / `disable` / `priority` for shaping the
  rotation order, bash/zsh shim variants alongside PowerShell, and `ccx token`
  for minting a long-lived headless token via `claude setup-token`.
- Fake `claude` test harness for zero-spend, zero-login testing; GitHub Actions
  CI on Ubuntu and Windows; 0 dependency vulnerabilities.
