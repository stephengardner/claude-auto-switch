# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
semantic versioning.

## [1.27.0]

### Added

- **`ccx usage` rewritten as a full report.** Every window for every account, with
  a bar, a percentage and when it comes back, then a line naming which window is
  actually closest to stopping that account, and finally where there is most room
  right now. The old output was a cramped table with the reset times on a second
  line, which left you to work out the useful part yourself.

  It is careful about one distinction the old version got wrong: a spent MODEL
  window (Fable, say) stops that model, not the account. Those accounts are still
  offered as places to work, with the model caveat spelled out, instead of being
  written off.

### Fixed

- **Ctrl-C in the dashboard now ends it exactly the way `q` does.** The signal
  handler called `process.exit` from inside itself, which skips the caller's own
  teardown and, on Windows, races the console being torn down. It now hands the
  terminal back first, then hands control to whoever claimed it: the dashboard
  winds its loop down through its normal exit path rather than being cut off
  mid-frame, and where there is no such owner the signal is re-raised, falling
  back to the conventional 128+signal exit code if it cannot be.

## [1.26.3]

### Fixed

- **A flaky test of our own.** The check that cancelling a sign-in does not block
  measured how long the call took, and failed on 2 runs in 4: starting a process
  on Windows can take most of a second even when the call itself does not block,
  so wall clock cannot separate the two cases. It now reads the source instead,
  which is deterministic and pins the same decision. A test that flakes is worse
  than no test, because it teaches people that red means nothing.

## [1.26.2]

### Fixed

- **A sign-in that worked is no longer reported as failed.** ccx judged a sign-in
  by whether it could drive the browser, and gave up the moment it could not,
  without waiting. So finishing the sign-in by hand, which is exactly what the
  message on screen told you to do, always ended with "did not finish" and
  "was not signed in", while the account was signed in and working.

  The verdict now comes from what actually ended up stored: a new login means it
  worked, whatever the browser step or the exit code said, and no new login means
  it did not, even if the helper exited cleanly. An account that was already
  signed in and unchanged reports that, rather than failure. When the browser
  cannot be driven, ccx says so and then waits, instead of walking away from a
  sign-in that is still in progress.

## [1.26.1]

### Fixed

- **The dashboard sign-in key works in lower case.** It was capital `L` only, so
  pressing `l` did nothing at all, which is what people press and what was
  reported. Hiding the action behind shift did not make it safe, it made it
  impossible to find.

  The reason for the capital was real (`l` sits next to `j` and `k`, so a stray
  press while moving would have handed the screen to a browser), and it is now
  handled properly: either case asks `Sign in "name" again? [y/N]` first. `y` or
  Enter goes ahead, any other key cancels and leaves everything as it was.

## [1.26.0]

### Added

- **Sign an account in again from the dashboard.** Highlight it and press `L`.
  The dashboard steps out of the way, the ordinary sign-in runs on the normal
  screen (browser and all), and the dashboard comes back when it finishes. Use it
  to re-authenticate an account whose login has died, or to point a profile at a
  different account: sign out at claude.ai first, and the same duplicate refusal
  applies as `ccx login`, so two profiles still cannot end up on one account.

  It is a capital `L` on purpose. It hands the screen to a browser sign-in, so it
  should be hard to hit while moving around with `j` and `k`.

  While the sign-in runs the dashboard is not on screen, because it cannot be:
  the sign-in needs the terminal it was holding. The screen says so, and says
  that Ctrl-C gives up and returns you to your shell.

## [1.25.0]

### Fixed

- **A session no longer starts on a login that is already dead.** ccx would copy
  a stored login into a new session and launch whatever the state of it, so an
  account whose login had expired hours earlier produced a fresh session where
  the first thing on screen was Claude saying you were logged out, with nothing
  to explain it. The login is now checked first. If it only needs renewing, it is
  renewed, which is safe at exactly that moment because nothing is using the
  account yet. If it is genuinely finished, ccx says which account and gives you
  the command that fixes it, instead of letting it look like a mystery sign-out.

### Added

- **The dashboard shows every usage window, not just the worst one.** There are
  now separate columns for the 5-hour window, the weekly window, and the model
  window closest to its limit (for example `Fable 100%`), each coloured on its
  own. The single column it replaces showed only whichever number was worst, so
  an account could read `Fable 100%` with no way to see that the hour and the
  week were completely free, or read `6%` while a model window was spent.
- **A detail line for the highlighted account**, spelling out each window and
  when it comes back: `work: 5h 6% (back in 1h35m)   week 57% (back in 3d)
  Fable 100% (back in 2d)`.
- Long waits now read in days rather than dozens of hours: `back in 3d`, not
  `back in 72h0m`.

## [1.24.0]

### Fixed

- **"Login expired, please run /login" in the middle of working, having done
  nothing.** This was ccx's fault, and here is the mechanism. Renewing a login
  REPLACES it: the moment a new token is issued, the old one stops working. ccx
  copies an account's login into a shared folder so it can swap accounts under a
  running session, so while you work there are two copies of one login. Opening
  the dashboard (or `ccx usage`, or proactive rotation) renews every account whose
  numbers look stale, including the one you are using, and that renewal retired
  the token the running session was holding. The evidence was three different
  logins for one account sitting in three folders at once.

  A session now says which account it is using, for as long as it runs. Anything
  that renews logins skips those accounts and reads their usage from the session's
  own copy, which is the fresher one anyway. The announcement is ignored once its
  process is gone or it stops being refreshed, so a crashed session cannot block
  renewals forever.

- **The same protection for the account your editor uses.** The editor reads an
  account's login directly, so ccx is not involved in those sessions and cannot
  see that one is running. That account is now left alone too. The one exception
  keeps its usage readable: a running Claude refreshes its own login within
  minutes of expiry, so a login that has been dead for half an hour is held by
  nothing, and renewing it is safe.

- **The next terminal no longer starts on a dead login.** A token that Claude
  refreshed mid-session used to reach the account's own folder only when the
  session ended, so for as long as you kept working, that folder held a login that
  had already been retired, and the next `claude` started on it and asked you to
  sign in. The refreshed login is now copied back as soon as it changes.

- **Quitting the dashboard no longer kills the terminal.** Exiting with the
  terminal still in raw mode was measured to kill the shell in every trial, while
  setting and restoring it was harmless in every trial. The dashboard did restore
  it, but its keypress handler runs on its own stack, so an error raised while
  handling a key ended the program without unwinding, leaving raw mode on. Errors
  from a keypress are now shown in the dashboard instead of ending it, and the
  restore is registered with the process itself, so a crash, a signal, and Ctrl-C
  all hand the terminal back.

### Added

- **Add and rename accounts from the dashboard.** `a` asks for a name and
  registers a new account; `n` renames the highlighted one. A rename moves its
  limit history and usage numbers with it (leaving those behind read as "my usage
  reset itself"), follows it with the active pointer, and renames the profile
  folder to match, unless a session is using it, it lives somewhere custom, or the
  name is taken, in which case it says why the folder stayed put.

## [1.23.0]

### Changed

- **Two profiles can no longer end up on the same login.** This was the single
  most damaging thing that could happen: signing in a second profile while the
  browser was still signed in to the first gave both profiles the same login.
  Renewing a login replaces it, so renewing either profile silently ended the
  other, and the account stayed dead until it was signed in again by hand. Two
  accounts were lost exactly that way. Four changes so it cannot recur:
  - **A sign-in is now accepted or refused in one shared place**, used by both
    `ccx add` and `ccx login`. This matters because `ccx add` is the path that
    actually creates duplicates (your browser is still signed in to the account
    you added last), and it used to run the login directly, so a check living in
    `ccx login` did not apply to it at all.
  - **A duplicate is refused, not warned about.** ccx asks who the new login
    belongs to, and if another profile already holds that account it puts the
    profile back to its previous login, or removes the refused login when there
    is no previous one to go back to. Either way the duplicate is never left
    active. From `ccx add`, the new registration is dropped too, so you end up
    exactly where you started.
  - Automatic renewal **skips** any profile that shares a login with another one.
    Only the renewal is skipped: usage still updates for that profile, and the
    reason is recorded once, when a renewal was actually due.
  - `ccx doctor` gained a `separate logins` check that spots shared logins with
    no network call, so it reports even when offline. It reads the local
    fingerprints, so it is also the check that still works when the API does not.

Nothing in the report ever contains a token: sharing is detected by comparing
hashes.

## [1.22.1]

### Fixed

- The tests that drive a real terminal now **skip loudly** where a machine will
  not allocate one, instead of failing. A skipped test says so and names the
  reason; it is not counted as covered.

## [1.22.0]

### Fixed

- **A used-up model no longer looks like being signed out.** Hitting the limit on
  one model (Fable, say) was recorded as the whole account being out, so ccx
  refused to start on any model and left the session with no login at all, which
  reads as "not logged in". Model limits are now recorded per model: other models
  keep working, the message says which model is out, and as a last resort ccx
  starts on the account you were already using rather than refusing.

## [1.21.0]

### Fixed

- **Renewing a login now takes Claude's own lock** before writing, so ccx and
  Claude cannot write the credential file at the same moment. Every credential
  change is also recorded to a log you can read with `ccx history` (no tokens,
  only what happened and when), which is what turned "I keep having to sign in
  again" from a mystery into a traceable event.

## [1.20.0]

### Fixed

- The status line only claims an account when ccx is **actually** running the
  session. Started Claude directly? It says `no ccx` instead of naming an
  account it is not managing.

## [1.19.0]

### Changed

- README rewritten to describe what ccx does now, in plain English.

## [1.18.0] and [1.17.1]

### Added

- The status line reports the room you have **left**, not the amount used, and
  mentions the reset time only when it is close enough to matter.
- `ccx statusline --wrap <command>` composes with a status line you already have,
  instead of replacing it.

## [1.17.0]

### Added

- **See which account you are on, without ccx getting in the way.** Claude owns
  the screen while it runs, so anything ccx prints is either scribbled over or
  steps on the interface. Two quiet channels instead:
  - `ccx statusline` prints one line for Claude's own status line (the account
    in use and the limit closest to stopping it). `ccx statusline --install`
    shows the settings snippet; it composes with a status line you already have.
  - A switch now asks the TERMINAL to notify you and updates the window title.
    Both are escape sequences that draw nothing, so the session is untouched,
    and terminals that do not support them simply ignore them.

### Fixed

- **A signed-out account is no longer treated as available.** A signed-out
  profile keeps a complete credential file with empty tokens, so ccx could pick
  it, fail to start, and record it as having hit its usage limit. Found by the
  first real cap test: a genuine limit correctly moved the session on, then a
  signed-out account was wrongly blamed for a limit it never hit.
- **A refused credential now clears the session instead of leaving the previous
  one in place**, which had let a session keep running as the account it was
  supposedly moving away from.

## [1.16.0]

### Added

- **The dashboard now shows the limit that will actually stop you.** An account
  can read 0% for the hour and 62% for the week and still be unusable because
  one model's weekly window is spent. The usage column now shows whichever
  window is closest to its limit (for example `Fable 100%`), coloured as it gets
  close, instead of a reassuring average.
- **`ccx doctor` reads like a report** rather than a log: plain-language names,
  a green / amber / red mark per check, and one list of the exact commands that
  would fix what it found. `--json` emits the same result for scripts.
- **Signing in records which account a profile holds**, so later checks compare
  against something known rather than what a profile claims about itself.

## [1.15.1]

### Changed

- **Moving a live session to another account is now opt-in.** It changes what
  you are working in, so it no longer happens unasked: `ccx proactive on`
  (optionally `--percent`), `ccx proactive off`, `ccx proactive` to see where it
  stands. Running `ccx auto` yourself still works while it is off.

## [1.15.0]

### Added

- **Move to a roomier account before you run out.** A running session watches its
  own usage and, when the window that will actually stop you gets close to its
  limit, hands the conversation to the account with the most room left, in
  place. `ccx auto` does the same for scripts and scheduled runs, with
  `--once`, `--json`, `--dry-run`, `--model`, `--threshold`, and stable exit
  codes (0 switched, 2 nothing to do, 3 off, 1 error).
- **`ccx doctor` now verifies who each profile is actually logged in as.** Local
  files report the account a profile *claims*; only the API can say whose login
  a stored token really is. This catches profiles holding the wrong account, or
  two profiles sharing one login, and names the exact `ccx login` fix.
- **Stale accounts renew themselves.** An account you are not using goes stale
  within hours, and a stale token cannot report usage, which used to leave
  rotation blind to exactly the accounts it should switch to. Renewal writes the
  result immediately and atomically, keeps the previous generation, and reports
  a genuinely dead login as needing sign-in rather than changing anything.

### Fixed

- **A logged-out session can no longer destroy a stored login.** When a session
  is signed out, Claude leaves a complete but EMPTY credential; ccx treated that
  as real and could save it over a good account. Credentials must now actually
  contain a login to be written anywhere.
- **Writing a login into the wrong profile is refused.** If a session is signed
  in as a different account than the profile it came from, its credential is no
  longer saved back over that profile.
- **Usage is fetched one account at a time.** Asking for several at once made
  the usage endpoint turn most of them away, and those failures used to
  overwrite good numbers with blanks; failures now keep the last known values.

## [1.14.0]

### Fixed

- **Switching accounts inside an editor terminal no longer kills the session.**
  In a VS Code / Cursor integrated terminal (itself a pseudo-terminal), ending a
  session the way an account swap does sent Windows down an asynchronous
  teardown path that raced the next session's startup and corrupted the ccx
  process a few seconds later, taking the whole session with it. ccx now ends
  the session's process directly so the teardown is ordinary and ordered.
  Measured on the failing setup: 5 crashes in 7 swap runs before, 0 in 6 after.

### Added

- **Credential safety net.** Every credential write now keeps the previous one
  alongside it, so a failed swap rolls back instead of leaving an account logged
  out, and a corrupt or empty credential can never overwrite a good login.
- **Cooperation with Claude's own credential lock** during a swap, so a swap can
  no longer collide with Claude refreshing its token in the background. It is
  deliberately best-effort with a short bounded wait: it closes the race in the
  normal case and can never block your swap.

### Changed

- **Credential files are written atomically** (write beside, then replace), so a
  crash or a killed process can never leave a half-written login on disk.
- **The terminal is claimed once per run** instead of being re-configured by
  every session, so swapping accounts no longer toggles terminal state while a
  pseudo-terminal is being torn down.

## [1.13.0]

### Added

- **Real per-account usage in the dashboard and a new `ccx usage` command.**
  See each account's 5-hour and weekly utilization, reset times, and the
  per-model weekly windows (e.g. Fable), pulled from Anthropic's own usage
  endpoint. The dashboard gains a `USAGE` column; `ccx usage` prints the full
  breakdown including which model window is the binding one. Usage is
  TTL-cached (5 min) so it is fetched at most once per account per window.

### Changed

- **Usage and cap verification now use Anthropic's dedicated usage endpoint**
  (a plain GET) instead of reading rate-limit headers off a tiny message
  request. This costs zero tokens, and it exposes the per-model weekly windows
  the header approach could not see, so a per-model cap (Fable) is verified
  against Fable's own window rather than a healthy all-models number.

### Fixed

- **Running `/login` as a different account mid-session no longer corrupts the
  original profile.** The save-back now compares the session's current identity
  against the profile it would write to and refuses when they differ, so two
  profiles can never end up sharing one login.

## [1.12.1]

### Fixed

- **A real session limit no longer terminates your session.** Claude exits
  itself when the session limit hits; the cap verification introduced in 1.11.0
  was asynchronous, so Claude's exit beat the verdict and ccx concluded "normal
  exit" and quit, killing the whole session instead of rotating. The exit path
  now waits for the in-flight verdict (and checks the final output flush, which
  ConPTY delivers after exit) before deciding: a confirmed cap at exit rotates
  to the next account and continues the conversation, exactly like a cap during
  a live session.
- **A bare 429 no longer counts as proof of a cap.** Verified live: some models
  (Fable) return 429 for every account, capped or not, with no usage headers;
  trusting that would have rotated accounts on a phantom cap. Only a response
  carrying the unified usage headers can confirm a limit; anything else falls
  back to a base-model check of the account-wide state, and an unconfirmable
  match never switches accounts.
- **Fixed a crash a few seconds after an account switch or cap rotation**
  (Windows heap corruption, `0xC0000374`, found and fixed in live end-to-end
  runs with real accounts): the per-session exit path released the terminal's
  input handle and re-killed an already-killed pseudo-terminal; the next
  session's relaunch then resumed that corrupted input handle and the whole ccx
  process died during its startup. Terminal-input release now happens once,
  after the last session ends, and a swapped-out session is never killed twice.
  Verified live: start on one account, real reply, forced switch, second
  session healthy with no crash.

## [1.12.0]

### Added

- **`ccx doctor` now verifies every integrity invariant**, so one command
  answers "is ccx healthy and leaving Claude alone?":
  - `terminal-shim`: installed in the profile your shell actually loads, and
    carries the safe fallback (uninstalling ccx can't break `claude`);
    `ccx on` upgrades an outdated block in place.
  - `shared-history`: the session root links to `~/.claude/projects` (your
    `/resume` lists and memories are one store, not forked).
  - `accounts`: REAL probed login state per account (a dead token with a
    leftover credential file is reported as needing login, not as healthy),
    with the exact `ccx login <name>` fix named.
  - `caps`: which accounts are currently marked capped, and a hard failure if
    every enabled account is (the "nothing can run" state).

## [1.11.1]

### Fixed

- **Uninstalling ccx can no longer break `claude`.** The shell shim now falls
  back to the real Claude binary when ccx is not on PATH (both PowerShell and
  bash/zsh), so removing the package without running `ccx off` first leaves
  `claude` working normally. Verified live in both shells, both branches.
- **Closed another replayed-text trap before it bit anyone:** the
  "No conversation found to continue" detector now only watches the first flush
  of output on an actual `--continue` launch, so a replayed conversation that
  merely CONTAINS that phrase can no longer interrupt a session (same failure
  class as the false-cap cascade, found by auditing for it).

## [1.11.0]

### Fixed

- **ccx sessions now share your real Claude history and memories.** ccx used to
  run sessions under its own private config root, which made `/resume` look
  empty in every repo and hid your project memories from ccx-launched sessions
  (and hid ccx sessions from plain `claude`). The session root's `projects`
  folder is now a link to `~/.claude/projects`, so both see ONE store: `/resume`
  is complete everywhere, memories are shared, and nothing forks again. Existing
  ccx-side history is merged in automatically (never overwriting anything), with
  a backup kept.
- **Cap detection is now verified against the API, ending the false-switch
  loops for good.** Rendered text (a replayed cap message during `--continue` /
  the resume picker, or even code that mentions rate limits) can no longer
  trigger a rotation: a match only triggers a minimal API check with the live
  credential, and ccx acts solely when the API confirms the account is actually
  limited. This kills the resume-picker switch loop the previous fix missed.
- **ccx sessions now run with your real settings** (hooks, permissions, status
  line): the user-level `~/.claude/settings.json` is merged into the session,
  with session-specific keys (like the model pin) winning.
- **The ccx process exits promptly when a session ends** instead of hanging on
  lingering terminal handles.

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
