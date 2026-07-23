# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
semantic versioning.

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
