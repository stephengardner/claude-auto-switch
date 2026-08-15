# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
semantic versioning.

## [1.46.0]

### Fixed

- **A limit ccx could not explain no longer leaves you stuck.** ccx never turns
  text on screen into a limit by itself: it asks the API, which is why a
  conversation that merely talks about rate limits does not end your session.
  That check had one failure mode, and it was the worst kind. When the API
  could not account for a limit that was genuinely happening, ccx declined to
  switch, and declined again, and kept declining, while the log filled with
  reasons not to act.

  Those refusals are now counted. A replayed message arrives in a burst
  seconds after a session resumes; a real limit keeps coming back minutes
  apart. Once the same unexplained limit has recurred three times over five
  minutes, ccx stops trusting the check and moves you, scoped to the model you
  are actually on and without recording a limit nobody could measure.

- **ccx now knows which model you are really running.** It remembered the model
  it picked when the session started, and that outlasted everything. The moment
  you changed model with `/model`, the two disagreed, and a real limit on the
  model you were actually using was dismissed as a limit on one you were not.
  Claude reports the model on every status line render, so that is what ccx
  uses now.

### Added

- **Logs say which ccx wrote them.** Every entry records the version, `ccx
  history` marks the point where the build changed rather than repeating one
  number down the page, and the dashboard title shows the running version. A
  report of "it did this" can now be tied to the code that did it.

- **A refusal records what it was based on.** When ccx declines to switch, the
  log keeps the model as ccx believed it and as Claude reported it, side by
  side. When those two disagree, every decision after them is answering about
  the wrong model, and the log now shows that instead of printing one of them.

## [1.45.0]

### Fixed

- **The dashboard could say "ready" about an account it would not use.** A row
  showed its five-hour window at 100% and "ready" on the same line. The status
  came only from ccx's own record of limits it had been refused by, while the
  numbers beside it came from the API, and nothing compared the two. Rotation,
  which reads the numbers, would meanwhile have skipped that account entirely.

  Status is now worked out from the same numbers the row is drawing, so the
  table and the switching logic cannot disagree.

- **A switch could put you in a different conversation.** Picking the
  conversation back up after a swap used "continue the most recent conversation
  in this directory". Most recent in the DIRECTORY, not the one this terminal
  was in: with two sessions open on one project, a switch in either could
  resume the other one's thread. Each run now names its own conversation and
  resumes it by name, so nothing depends on which one was touched last.

### Added

- **How long until a spent model comes back.** When a model reads 100%, the
  status says which model and when it returns, counting from the last window
  that has to lift rather than the model's own: `fable spent 2d 20h`. Knowing
  it is out is only half the question.

## [1.44.0]

### Fixed

- **A ccx session no longer freezes your Claude settings.** When a session
  ended, ccx copied its whole settings file aside so a `/model` pin would
  survive into the next one. That copy wins over `~/.claude/settings.json`,
  so copying everything froze every setting you happened to have at that
  moment: editing the real file changed nothing inside a ccx session, and the
  frozen value could not be removed by any normal means.

  Found the hard way, with `"tui": "fullscreen"` stuck on a machine and
  surviving every edit to the real settings, because a copy from an old
  session kept putting it back. Sixteen keys were overriding that file,
  including hooks, permissions and a status line captured before `ccx on`
  wrapped it.

  Only the keys that actually differ from your real settings are carried now.
  A `/model` pin still sticks, a setting you turn off actually turns off, and
  a hook you add later reaches your next session. It also repairs itself: once
  the real settings agree, the override drops out on its own.

## [1.43.1]

### Added

- **`ccx doctor` now checks the status line.** The shim is transparent by
  design, so without the status line nothing on screen says ccx is running at
  all. The checkup reports whether Claude will show your account, whether a
  status line of your own is there instead, and points at `ccx on` when it is
  missing.

### Fixed

- **A command pointed at one home no longer edits another.** Working out where
  the PowerShell profile lives means asking the real PowerShell, which knows
  nothing about a home directory passed in for a test. So a command aimed at a
  temporary home was handed the real profile path and edited it. Passing an
  environment now means "this is the machine", and everything stays inside it.

## [1.43.0]

### Added

- **`ccx on` now sets up Claude's status line for you.** Until now, seeing
  which account you were on meant reading the README and hand-editing
  `settings.json`, which nobody does on a new machine. The shim is transparent
  by design, so without this there was nothing on screen to say ccx was even
  running. Setup now covers it, on any machine.

  The edit is deliberately narrow, because that file holds your hooks and your
  permission rules. It merges one key and carries everything else through
  untouched. A status line you already had is **wrapped**, never replaced: it
  keeps printing and ccx adds its part to the end. `ccx off` puts your original
  back exactly as it was, fields and all. A settings file that does not parse
  is left alone rather than rewritten, the file is replaced by an atomic rename
  so a failed write cannot leave you with half a settings file, and ccx will
  not wrap your line at all if it cannot first save a copy to restore.

  `statusLine` is the only thing ccx adds to `~/.claude`. Skip it with
  `ccx on --no-statusline`.

### Fixed

- **The dashboard no longer draws past the edge of the window.** Every line
  that carries free text (the account detail, the events, the `next →`
  prediction, the typing box and its errors, notices, confirmations and the
  title) is now measured against the terminal. The key hints are ordered by
  how much you need them and drop from the tail, so a narrow window loses
  `e enable` rather than `q quit`.

## [1.42.0]

### Added

- **The dashboard shows what it knows, and what it is about to do.** Every
  window is drawn with the same bar and colour scale as `ccx usage`, so the
  two pages describe the same numbers the same way. The model column is named
  after the model and holds that one model in every row. And a `next →` line
  runs the real rotation planner over live usage, the ledger's model caps and
  your `modelStrategy`, so the screen says where you will land before you land
  there rather than only what each account currently has.

### Fixed

- **The table shrinks to the terminal instead of wrapping off the edge of it.**
  It previously came to exactly 80 columns in an 80-column terminal, so a
  longer account name or a longer wait wrapped the row. The bars now narrow,
  then disappear, then the headings shorten, then names truncate: a row of
  bare percentages is plainer, a wrapped row is useless.

- **An unread window says `?`, never `0%`.** Zero claimed an account was
  completely free when the truth was that nobody had measured it, which on a
  fresh install is every account.

- **A model cap and a usage window are matched by name properly**, so a limit
  recorded as `claude-fable-5[1m]` and a window called `Fable` are one thing.
  Unmatched, an account read as having room on a model it was capped on.

- The title says which model rotation **prefers**, rather than claiming to
  know which one a running session is on, which it cannot see from outside
  that session.

## [1.41.0]

### Fixed

- **"could not resolve the real claude binary" on a machine where Claude is
  installed.** ccx only ever asked PATH. When an installer adds its directory
  to PATH, a shell (or editor) started before that never inherits it, so
  `where claude` found nothing and ccx reported the binary as missing while
  the operator could run it perfectly well themselves. It now looks where
  Claude Code actually installs itself as well: the native installer's
  `.local/bin`, the local install `claude migrate-installer` leaves behind,
  both npm global layouts, and bun.

- **A confusing line in the terminal.** A PATH miss let `where` print "INFO:
  could not find files for the given patterns" straight to the screen, which
  read as a fault. Finding nothing on PATH is now ordinary and silent.

- **The error, when there genuinely is nothing to find,** lists every place
  that was searched and both ways to point ccx straight at the binary,
  instead of naming a config key and stopping.

## [1.40.0]

### Fixed

- **Running out of one model no longer moves the whole run off that model.**
  One account running out of Fable was treated as every account running out of
  Fable: ccx switched to Opus for the rest of the run and never reconsidered,
  even after rotating onto an account with a quarter of its Fable week left.
  Spent models are now remembered per ACCOUNT, and the model is re-decided on
  every account change.

- **A session no longer gets capped by a model it is not running.** After
  moving to Opus, the account's spent Fable window stayed at 100% all week, so
  every replayed cap message from a resumed conversation re-confirmed it and
  ended the session within seconds. Measured on a real machine: ten rotations
  in six minutes, each session under twenty seconds. A spent window for a model
  you are not using is not a limit on you.

- **Rotation stopped walking through accounts whose model was also spent.**
  When a confirmed limit says which model ran out, that answer now picks the
  next account, so a Fable limit goes straight to an account with Fable left
  instead of trying two more spent ones by priority order first.

### Added

- **`ccx models`: choose what gets used up first.** `model-first` (the new
  default) stays on one model across every account before falling back;
  `account-first` uses each account up across the chain before moving on. A
  one-model chain (`ccx models fable`) means never fall back: ccx reports that
  Fable is gone everywhere rather than switching you to something you did not
  ask for. Interactive sessions and headless `ccx -p` runs follow the same
  planner, so the setting means one thing wherever you run.

### Changed

- The account choice and the model choice are made together, by one planner
  (`usage/rotation-plan.ts`), instead of by two pieces of code that disagreed.
  The in-session model switch used to fire before rotation could choose, which
  is what moved a whole run to Opus while another account still had Fable.

## [1.39.0]

### Fixed

- **"Please run /login" out of nowhere, at its root.** A refresh token is
  single-use: renewing rotates it, and every other copy dies that instant.
  With one directory per session, an account's login lived in several places
  at once (the profile plus every live session on that account), each renewing
  on its own clock, and whoever renewed first killed the rest. The profile was
  often the stalest copy, so new sessions started on a corpse and demanded a
  sign-in immediately. The profile is now the hub and sync runs both ways: a
  renewal that happened anywhere is carried into every running session before
  its next refresh can die, and a dead profile login is recovered from a live
  session of the same account instead of asking you to sign in.

- **A session signed in as the wrong account no longer refuses to switch.**
  After a mid-session /login the session can be a different account than ccx
  believes. The limit banner on screen belonged to the ACTUAL account, but the
  cap check asked the BELIEVED account, got "not capped", and refused to
  switch, on every render, forever. The check now asks the login the session
  is actually running on, resolves who it belongs to, records the cap against
  that account, and rotates; the next launch realigns the session with the
  chosen account.

- **Random characters in the terminal, third time, and why the second fix did
  not hold.** Killed children leave mouse tracking on, and the reset ran in
  onExit, which is BEFORE ConPTY flushes the dead child's trailing output;
  that flush re-enabled the modes the reset had just turned off. The reset now
  runs after the flush window, the run's last act is one more reset, and a
  crash guard covers a wrapper that dies without its finally blocks.

- **Usage is watched for every session, not only when a feature asks.**
  Refreshing the usage snapshot was coupled to proactive rotation (off by
  default), so with no dashboard open, nothing refreshed anything: a snapshot
  ten hours stale while seven sessions ran, rotation choosing targets from the
  morning's numbers, and idle profiles' logins quietly rotting. Every session
  now keeps the snapshot alive, cheaply (fresh-enough skip plus a try-lock so
  concurrent sessions never multiply the probes).

### Added

- **Several sessions can run one account at the same time, visibly.** Session
  leases are per session (account + pid) instead of per account, so every
  session keeps its no-renew protection instead of the last one silently
  taking the only slot.

- **The event log says why, not just what.** Events carry a kind and the
  evidence behind the decision (who was believed, who was actual, what the
  probe answered, what was recorded), so "why did it do that" is answerable
  from `ccx history` alone.

## [1.38.0]

### Fixed

- **Healthy accounts are no longer capped.** The cap check asked the SHARED
  session directory's credential, so with two ccx runs rotating at once an
  exhausted account answered on behalf of a healthy one. Measured on a real
  machine: five accounts capped for five hours each inside 87 seconds, one of
  them with 97% of its five-hour window still free. That account then refused
  to start anything, including with an explicit `--model`. The check now asks
  the account it is about to cap, using that account's own credential.

- **A limit is never recorded from screen text alone.** The headless path had
  no verification at all, so any output matching the cap patterns took an
  account out for hours. Both paths now share one rule, and anything short of
  a confirmed limit (an unreachable endpoint, a 429, a missing token) is not a
  cap. A limit that is real will trigger again; a healthy account wrongly
  capped stays broken for hours.

### Added

- **Running out of one model switches model instead of giving up.** A
  per-model limit stops that model, not the account, so ccx now changes model
  and carries on rather than rotating away from an account that still has room.
  The order is your `modelPreference` (default Fable then Opus). Rotating
  accounts solved nothing when every account shared the same spent model,
  which is how a machine with plenty of capacity reported that everything was
  capped.

## [1.37.1]

### Fixed

- **Stray characters like `;171;15M` no longer appear in the input box.**
  They were never random: that is an SGR mouse report, and the numbers are a
  cursor position. Claude's interface turns on mouse tracking and bracketed
  paste when it starts and turns them off when it exits normally, but ccx ends
  a session by killing it, on every rotation, every account switch and the
  no-conversation retry. A kill skips the child's exit handler, so those modes
  stayed on and the terminal carried on reporting into whatever read input
  next. With any-motion tracking still set, every mouse MOVE sent one.

  ccx now puts those modes back itself when a session ends. It cannot ask a
  process it just killed to do it, and it must not assume the next session
  will, because the reports are generated in the gap before anything is
  listening.

## [1.37.0]

### Fixed

- **ccx now says why it gave up.** With every account either capped or refused,
  running `claude` came straight back to a blank prompt. Refusing was right;
  saying so only in the event log was not. The ending went out through the
  channel that deliberately draws nothing, which exists so ccx never scribbles
  over Claude's screen mid-session. Nothing owns the screen once there is
  nothing left to run, so it now writes to stderr.

- **That message names every account that is out, not just the ones that ran
  out during this session.** Accounts capped before the session started were
  never mentioned, so you could be told two accounts needed signing in while
  the two that were actually out of room went unnamed.

- **Pressing `l` in the dashboard no longer kills it.** Three faults, each able
  to end the program on its own: a terminal that goes away (`write EPIPE` from
  the sign-in's progress line, `read EPIPE` from stdin), a sign-in that could
  not start (a child that fails to spawn emits `error` and never `close`), and
  an unguarded loop body. All three arrive as events rather than throws, so
  nothing at the call site could catch them.

## [1.36.4]

### Fixed

- **`ccx list` no longer shows a refused login as signed in.** The table is
  where you look to find out which accounts you can use, and it repeated the
  health probe's answer. The probe reports a refused login as signed in, because
  the credential file still looks like one, so this was the most misleading
  place to say it.

- **The editor pointer stopped judging by whether the credential file exists.**
  A signed-out profile keeps a complete credential with empty tokens, so file
  presence was never the question. That check was replaced everywhere else in
  1.17.0 and survived here, which meant `ccx doctor` could report the editor as
  pointed at a working account when it was pointed at a signed-out or refused
  one.

## [1.36.3]

### Fixed

- **`ccx login --all` no longer skips the accounts that need signing in.** It
  asked the health probe which accounts were logged OUT, and the probe reports a
  refused login as signed in, because the file still looks like one. So the
  command that exists to fix a refused login skipped exactly those accounts and
  announced that they were all fine.

  It now targets whatever cannot actually be used, which is the same question
  the rest of ccx asks, taken the other way round.

## [1.36.2]

### Fixed

- **A refused login no longer counts as available to `ccx run`, `ccx rotate`,
  the dashboard or `ccx doctor`.** The health probe asks Claude whether a
  profile looks signed in, and it cannot know that the token endpoint refused
  that exact credential afterwards. Only the editor path subtracted those; the
  other four built the same set from the same expression and did not.

  So a login ccx already knew was finished could still be chosen to run on,
  rotated to, offered by the dashboard's rotate key, and counted in doctor's
  "N of M signed in".

  There is one shared answer now, and no copies of the raw expression are left.

## [1.36.1]

### Fixed

- **`ccx doctor` no longer calls it healthy when nothing is left to run on.**
  The limits check asked whether every ENABLED account was capped. An account
  whose login the token endpoint has refused is still enabled and cannot be
  used, so a couple of dead profiles made the total look fine while every
  account that could actually start a session was capped.

  Found on a real machine, where it reported ok with both working accounts
  capped and two refused logins padding the count.

  It counts the accounts that could actually run now, names the ones that need
  signing in first, and offers the command for them.

## [1.36.0]

### Fixed

- **A duplicated account is no longer left to expire in the background.** The
  usage refresh refused to renew any login another profile shared, because
  renewing rotates the token and would have retired the other copy. That refusal
  was symmetric: for a duplicated account it fired on BOTH halves, so neither
  was ever renewed there. Both tokens expired, their usage became unreadable,
  and the rotation policy went blind on exactly the accounts it exists to choose
  between.

  Now the renewal happens and is carried across to the profiles that shared it,
  using the same machinery as the session paths. A session using one of those
  profiles is still a reason to refuse, which is what the original guard was
  really protecting: renewing would sign that session out mid-work. That check
  reads the leases at the moment it decides, rather than from a snapshot taken
  before a loop that makes a network call per account.

  It narrows that window rather than closing it. A session claiming an account
  in the milliseconds before the token request still loses its credential,
  because the rotation happens at the server. Closing it needs a reservation
  that session start also takes, which is filed separately.

  Renewing across an `await` is one call rather than a snapshot and a renewal
  either side of it, because an ordering split across an await is even easier to
  get wrong than one split across three statements.

## [1.35.0]

### Added

- **`ccx doctor` now says when two sessions are sharing one session directory.** Every
  `ccx run` uses the SAME session directory, and starting a session copies that
  account's login into it. Two sessions at once therefore write the same file,
  and the later one silently takes the first one's account: the first terminal
  keeps working, on a login it was not given, while ccx still reports the
  account it chose. A limit hit there is recorded against the wrong account.

  Nothing is corrupted by this, because the save-back guard already refuses to
  write the borrowed login into the wrong profile. What was missing was any way
  to SEE it, which is what this reports, naming the sessions and their process
  ids.

  It also reports when the session's login belongs to a different account than
  the active one, and stays quiet for the two cases that look similar and are
  not faults: a running Claude that renewed its own token in place, and two
  profiles that legitimately share one login.

  Read-only, local, and no network: `ccx doctor` is what you run when a session
  behaved oddly, and it must not change anything while answering.

  This is a diagnostic, not the fix. Sessions sharing one directory is the
  underlying design issue and is filed separately.

## [1.34.1]

### Fixed

- **The login a RUNNING Claude refreshes is carried across too.** 1.34.0 fixed
  the renewal ccx does at session start. It left the path that fires far more
  often: a long-running Claude refreshes its own token every few hours, ccx
  saves that back into the active profile, and a profile sharing that login was
  still left holding the retired one. Same death, slower road.

  Both paths now carry the renewal across.

  The save and the carry are one call rather than three statements, because the
  order is the correctness property and it cannot be seen afterwards: the
  snapshot of who shares the login has to be taken BEFORE the write, since
  writing destroys the value that identifies them. As three statements at the
  call site, removing the carry entirely broke no test at all, which is exactly
  how it would come back.

## [1.34.0]

### Fixed

- **Two profiles holding the same login no longer kill each other.** Signing in
  twice can quietly produce a duplicate, because the browser stays signed in
  between `ccx login` runs. Renewing rotates the refresh token and retires the
  previous one immediately, so the moment either profile renews, the other is
  holding a dead token and the next thing to touch it gets `invalid_grant`.

  The usage refresh already refused to renew a shared login for exactly this
  reason. A session STARTING on one renewed it with no such check, and the
  sibling was finished from that moment.

  Refusing at session start would be the wrong answer, because the session needs
  a working token to run at all. So the renewal is carried across instead: the
  profiles are the same account, so they end up holding the same login, and both
  keep working. Each profile that gets carried across says so in `ccx history`.

  This is not hypothetical. It is how an account here died: the credential log
  shows a session start renewing one profile at the same moment its duplicate
  was refused with "Refresh token not found or invalid".

  A profile is only written when it still holds exactly the credential that was
  just retired. Anything else is left alone, because writing over it would be a
  guess about someone's login.

## [1.33.5]

### Fixed

- **Writing the event log can no longer crash a session, or lose events.**
  Several ccx processes share this log: a session writes swaps, the dashboard
  tails it, the editor launcher adds its own. Every write rewrote the whole file,
  which was wrong in two ways at once. Reproduced with four concurrent writers:

  - **It threw.** The rewrite renames a temp file onto the target, and on Windows
    that fails with `EPERM` when another process is doing the same. Three of four
    writers crashed. Nothing wrapped the call, so a log line could take down a
    session start or a swap. In a real terminal the old build prints a node
    stack trace over the session.
  - **It lost events.** Two writers read the same state and the second rewrite
    erased the first one's event: 74% of events disappeared.

  Events are now appended one line at a time, which cannot collide and needs no
  temp file, and a failed write is swallowed. Telemetry must never be able to
  stop the thing it is describing. Under the same test: nothing lost, nobody
  crashed, and a process hammering the log managed tens of thousands of writes
  in twenty seconds where the old one managed 432.

  Compaction never replaces the live file either. It moves it aside in one
  atomic step, so an event appended while a compaction is running lands in a
  fresh file that compaction does not touch. Doing it the obvious way, reading a
  snapshot and writing it back, would have reintroduced exactly the lost-update
  bug this change removes, in the one place left that still rewrites anything.

- **A storm no longer pushes real events out of the log.** Trimming folds
  repeated messages BEFORE taking the tail, so a caller stuck in a loop occupies
  one record however long it runs, and everything else survives alongside it.
  That displacement has happened twice on this machine, both times blinding
  `ccx dashboard` and `ccx history` exactly when they were the tools being
  reached for.

  Trimming is also triggered by file SIZE, which is free to ask for, rather than
  by counting lines, which meant reading the whole file on every append. That
  first version cost 51ms per event; it is now under 1ms.

## [1.33.4]

### Fixed

- **An account that was never signed in is no longer left out of the ending.**
  When the swap loop ran out of accounts it chose between "wait for a reset" and
  "sign in again" by looking at which logins had been refused. An account with
  no login at all was in neither group: it is invisible to selection, so nothing
  recorded it, and the session ended by suggesting a wait that could never
  produce a login.

  It is now named in its own words. "Sign in again" is wrong for an account that
  has never worked, so the two are kept apart: `refused needs signing in again.
  fresh is not signed in yet. Run: ccx login refused`.

  Scope worth being exact about: this is the mixed case, where something has a
  login so the swap loop runs and then runs out. When NO account has a login the
  loop is never entered, and that path already said `cannot run: no enabled
  account is logged in (run: ccx login --all)`, which was already right.

  The choice between these endings is now one pure function with the three
  states named, rather than conditionals at the call site. Telling someone to
  wait when waiting cannot help has been fixed on four separate surfaces in this
  project, each time locally, which is what made it worth having one place.

## [1.33.3]

### Fixed

- **Rotation no longer starts a session on a login that has already been
  rejected.** The swap loop only learned a login was finished by launching it
  and watching it fail, so an account the token endpoint had definitively
  refused was still picked first. What that looks like in a terminal is Claude
  opening on "Not logged in", with nothing to say which account is at fault or
  what to do about it.

  Accounts with a recorded refusal are now skipped before anything is launched.
  They are skipped by being put into the same set that a rejection discovered at
  runtime goes into, which is what keeps the ending honest: that set is what the
  closing message reads to choose between "wait for a reset" and "sign in
  again". Filtering them out of the selection instead would have left the set
  empty and produced "every account has hit its limit", sending you off to wait
  for a reset that cannot repair a sign-in.

  When some accounts are out of room AND others need a sign-in, both are now
  named, because waiting fixes one group and never fixes the other.

  `ccx doctor`, the editor launcher and the usage refresh ask the same stricter
  question now, so a rejected login is not reported as live and is not probed
  for usage it cannot return.

## [1.33.2]

### Changed

- **One shared answer to "does this account have a login".** The same expression
  was written out in five places, and the reasoning behind it existed in only
  one of them: a signed-out profile keeps a complete credential file with empty
  tokens, so the file being there is not a login. The other four copies carried
  the rule without the reason, which is how a rule quietly gets "simplified" by
  someone reading only one of them.

  No behaviour change: every copy was identical, and the existing tests all pass
  untouched. The point is to have one place left to change when the answer needs
  to get smarter, which it does: several commands still cannot see a login the
  token endpoint has definitively rejected. That change comes next, separately,
  so it arrives as a diff about the decision instead of hiding inside a move.

## [1.33.1]

### Fixed

- **`ccx usage` no longer sends you to an account that cannot sign in.** It
  ranked purely on how much room each account had, so a login the token endpoint
  had already rejected could be named as the roomiest place to go. Advice is
  worse than rotation here: rotation tries such an account and recovers on its
  own, while a recommendation just produces a failed session and no explanation.

  Those accounts are now left out of the suggestion and marked `NEEDS SIGN-IN`
  on their own row, so the advice is traceable to what it came from.

  When they are the only ones left, the report says to sign in and gives the
  command, rather than "every account has hit a limit". Waiting for a reset
  never fixes a login, and sending someone away to wait for something that
  cannot happen is the worse failure of the two.

## [1.33.0]

### Fixed

- **The status line says "needs sign-in" for a login that has actually been
  refused.** It already had that warning, but it could only see a credential
  FILE with no token material. A dead refresh token leaves a file that looks
  complete, so the warning never fired and the line instead reported healthy
  headroom, in Claude's own interface, for an account that cannot authenticate.

  When the token endpoint refuses a login for good, that verdict is now written
  down, keyed by the credential's contents. Signing in again produces different
  contents, so the note clears itself and no stale record can hold down an
  account that works.

  The same record spares a fresh session the request it used to spend
  rediscovering a refusal that was already known. Only a definitive refusal is
  recorded; a network blip or a server error stays retryable, because a bad
  moment must never bench a healthy account.

## [1.32.5]

### Fixed

- **`ccx history` no longer spends its whole screen on one repeated line.** The
  login trail is append-only, so a run of the same message stayed as one entry
  per occurrence and pushed everything else out of view. On the machine this was
  found on, seven of the eight most recent entries were the same "renewal
  refused" line, hiding two successful renewals and a refusal that had protected
  a running session.

  Consecutive identical events now collapse for DISPLAY, with a count and the
  time of the most recent one, shown as `(x7)`. The limit therefore counts
  things that happened rather than copies of one of them.

  Nothing is rewritten. Every occurrence stays in the file, because this is an
  audit trail and folding it on write would turn a cheap append into a read on
  the credential path. Folding when read costs nothing there and rescues what is
  already recorded.

## [1.32.4]

### Fixed

- **An event log that is ALREADY full of repeats is readable again.** 1.32.3
  collapsed a repeating message as it was written, which stops the log being
  emptied in future but does nothing for a log that has already been emptied.
  That is the log worth rescuing: two hundred copies of one line, with every
  real event pushed out, and nothing improving until all two hundred age out.

  Repeats are now folded when the log is READ as well, so an already-stormed log
  shows one entry with its count immediately, without rewriting a file you may
  still be watching. The limit counts things that happened rather than copies of
  one of them, so asking for the last five events no longer spends all five on a
  single repeat.

## [1.32.3]

### Fixed

- **One repeating message can no longer empty the event log.** `ccx dashboard`
  and `ccx history` read a bounded log of the last 200 events, so anything stuck
  repeating used to push every other event out of it. That happened twice, once
  filling all 200 entries with a single line, and both times it blinded exactly
  the tools you reach for when something is wrong.

  A message identical to the one before it now collapses into that entry with a
  count and the time of the most recent occurrence, shown as `(x200)`. Nothing
  is hidden: "this is happening, and a lot" is still there, and the rest of the
  history survives alongside it. Only consecutive repeats collapse, so the order
  of events is never rewritten.

  Each event still rewrites the file, so a repeating message still costs one
  small write apiece. What changed is the size: the file being rewritten holds
  one collapsed record rather than two hundred copies of the same line.

## [1.32.2]

### Fixed

- **A login that cannot be renewed is no longer asked again every few minutes.**
  When the token endpoint answers `invalid_grant`, that refresh token is gone for
  good: no number of retries can change the answer, and only signing in again
  can. ccx now remembers the refusal against the credential's contents, so it
  stops asking until the credential changes, which is exactly what `ccx login`
  does.

  This was costing a pointless request per account per check, and worse, a line
  in the credential log each time. On the machine this was found on, one dead
  login had been re-asked 472 times, and 98% of those came less than six minutes
  apart. That log is the first thing anyone reads to work out why a login broke,
  so burying it was the real damage. The first refusal is still recorded, since
  that is the one that answers the question.

  A temporary failure is deliberately NOT remembered, so a blip never benches a
  healthy account.

## [1.32.1]

### Fixed

- **A usage limit that has already reset is no longer treated as a live limit.**
  Usage figures are cached, and a number only climbs while its window is open, so
  a figure past its own reset time is not merely old, it is wrong: it reports
  "spent" about a limit that has already lifted.

  This was visible in several places at once. `ccx usage` painted such a window
  red as SPENT and named it as the thing stopping you; it left recovered accounts
  out of "most room right now"; the dashboard kept a column pinned at the number
  a model hit before its window rolled over, and could even name the wrong model
  as the tightest; and the status line inside Claude reported a model as spent
  for an account that was free.

  Rows for a window that has reset now read empty and say "reset since it was
  last read", so the change in the number is explained rather than silent.

  Rotation is affected too, and that is the part that cost real work: proactive
  rotation and the background daemon both decided where to move from these
  figures. An account whose usage cannot be read keeps its last known numbers
  while its fetch time is refreshed, so a dead or unreadable account could look
  permanently capped. A check based on how old the entry is would never have
  caught that; the reset time is the only honest signal, and every stored window
  carries one.

- **"No usage has been read yet" no longer appears for accounts that have been
  read.** Whether anything was measured and whether a limit is currently in
  force are different questions, and answering the first with the second sent you
  looking for a fault that did not exist. A run that read only per-model figures
  now says so, rather than claiming every account has hit an account-wide limit.

## [1.32.0]

### Added

- **Rotation follows the model you are using.** A per-model limit stops that
  model, not the account, so moving to another account whose Fable is also spent
  solves nothing. When the model in use runs out, ccx now looks for an account
  that still has room on THAT model first.

  Only when no account has any is the model changed, and then it follows a
  preference order rather than whatever happens to be free. The default is Fable
  then Opus, and it says so when it happens rather than quietly moving you.

  Both parts are configurable in `~/.claude-auto-switch/config.json`:

  ```json
  { "rotation": { "modelPreference": ["fable", "opus"], "preferSameModel": true } }
  ```

  Set `preferSameModel` to false to rotate on account limits alone, which is how
  ccx behaved before this existed.

  The chosen model is applied to the session that starts, not merely announced,
  and it stays applied for the rest of the run: a model that ran out does not
  come back within a session, so re-checking it would only churn. That includes
  the fresh retry after a resume finds no conversation, which used to fall back
  to the model that had just run out.

  Model preference applies only when a model is actually in play (`--model` or a
  pin in `settings.json`). With nothing pinned, Claude picks its own default and
  ccx cannot read which one, so those sessions rotate on account capacity alone
  rather than having a model imposed on them.

  Cached usage is read as current capacity rather than as history. Every stored
  number carries the time its window resets, and one past its own reset says
  "spent" about a limit that has already lifted, so it is ignored instead of
  acted on. Without this, a snapshot taken before a reset would move a session
  off a model that was available again, and announce a limit that no longer
  existed.

- Fixed: "starting fresh" after a failed resume kept the `--continue` you typed,
  so it repeated the same resume instead of starting fresh.

## [1.31.1]

### Fixed

- **A refused credential is no longer re-checked forever.** Before copying a
  login into an account, ccx asks Anthropic who it belongs to. That answer was
  recorded as handled only when the copy went ahead, so a login the guard
  REFUSED was asked about again on the very next tick, and the next, twice a
  second for as long as the session ran. Every one of those is a network call.
  It locked the machine up and wrote 200 identical lines to the log in 104
  seconds.

  A refusal is a settled answer about that particular login: nothing about it can
  change until the file does, so asking again can only produce the same refusal.
  It is now recorded as handled either way. A failed disk write and an
  unreachable API are still retried, because neither of those settled anything,
  and treating them as settled would leave a refreshed token unsaved.

## [1.31.0]

### Fixed

- **ccx writes nothing to the terminal while Claude owns it. Nothing at all.**
  The `[ccx]` messages were moved off the screen in 1.28.0 by sending them as a
  terminal notification instead, on the reasoning that an escape sequence renders
  nothing and is therefore safe. That reasoning was wrong.

  It renders nothing, but it is still bytes pushed into a terminal that is
  mid-draw. Land them inside a sequence Claude is writing and the terminal's
  parser is left half-way through one: text comes out garbled and overlapping,
  and the terminal can be left in a mode Claude is not expecting, so mouse
  reports arrive as ordinary typed text (`5;200;7M` appearing in the prompt).

  The rule is now absolute and enforced in one place rather than at each call
  site, because a rule checked at four call sites is one that gets missed at the
  fifth. While another program owns the terminal, every notification, title
  change and message goes to the log only. `ccx dashboard` and `ccx history`
  are where they are read.

## [1.30.0]

### Fixed

- **A broken account is rotated past, not blocked on.** ccx would start a session
  on an account whose stored login was finished, because the check for "has a
  login" only looked for token material and an expired token still has some. The
  session then began on a dead token, Claude said `Login expired`, and there was
  nothing on screen to act on.

  That turned into a loop. Signing in from inside the session put the new login
  in the session folder, ccx correctly refused to copy someone else's account
  into that profile, the profile kept its dead login, and the next session did
  the same thing again.

  An account whose login cannot be renewed and is rejected by the server is now
  skipped, exactly like one that has hit its limit, and the next account is used
  instead. It is deliberately NOT recorded as capped: nothing is exhausted, and a
  cap would keep it out of rotation for hours over something a sign-in fixes.
  When every login is finished, the message says to sign in and names the
  command, rather than telling you to wait for a reset that will never come.

## [1.29.0]

### Fixed

- **Signing in from inside a session can no longer overwrite the wrong account's
  login.** This is the one that hurt. Running `/login` in a running session makes
  Claude write the new credential into the shared session folder, and ccx copies
  a changed credential back to the account it believes it is on. The check meant
  to stop a wrong copy compared the identity file Claude keeps beside the
  credential, which is not updated at the same instant, so it compared a stale
  identity, found nothing to disagree with, and wrote the NEW account's login
  into the OLD account's profile.

  The result was two profiles holding one account, limits then read from the
  wrong place, and being capped out of accounts that had room, which forces
  another `/login` and goes round again.

  The check now asks the API who the credential actually belongs to before
  copying it anywhere, and that answer decides. It is the only input that cannot
  lag: refusing merely when the identity is unknown was not enough, because the
  stale file names the OLD account, which MATCHES, so the wrong write sailed
  through. The call is affordable because it happens on a credential that
  changed, not on every check: a refresh every few hours, or a sign-in. Anything
  it cannot confirm is refused. The two outcomes were never symmetric: refusing loses a refreshed
  token, which the next sign-in restores, while allowing overwrites a login with
  someone else's and corrupts the account map in a way local state cannot undo.

- **The identity-mismatch message no longer reaches the screen.** It can fire on
  every credential change, it explains an internal decision that cannot be acted
  on mid-session, and it was appearing inside Claude's interface. It goes to the
  log; `ccx doctor` reports the same mismatch properly.

## [1.28.2]

### Fixed

- **Every kind of escape sequence is now held, not only some of them.** The
  reassembly added in 1.28.1 covered CSI and OSC but let DCS, SOS, PM and APC
  fall through as if they were two-byte escapes, so those could still be cut in
  half and forwarded in pieces.

  Only OSC ends on a BEL character, which is an xterm compatibility rule rather
  than a general one. Applying it to the others would end a sequence early on a
  BEL byte that is simply part of its payload, forwarding the fragment: the same
  bug again, and harder to notice.

## [1.28.1]

### Fixed

- **Stray characters like `35;112;43M` no longer appear in Claude's input.**
  Those were mouse-motion reports with their `ESC[<` prefix missing. ccx relays
  your keystrokes to Claude, and the terminal delivers input in whatever chunks
  it likes, so a report split across two of them was forwarded as two separate
  writes. The reader then swallowed the prefix and showed the rest as if you had
  typed it. Motion tracking produces a flood of these, which is why it kept
  happening.

  The relay now reassembles a sequence before forwarding it, holding back a chunk
  that ends part-way through one. A lone Escape keypress looks exactly like the
  start of a sequence, so anything held is released shortly after if nothing
  follows, and Escape still works.



## [1.28.0]

### Fixed

- **ccx no longer writes into Claude's interface.** While a session runs, Claude
  owns the screen, so anything ccx printed landed inside its interface. That is
  exactly what those `[ccx]` lines appearing mid-conversation were.

  The worst of them fired whenever limit-looking text rendered and the API then
  refuted it, which includes a conversation that merely TALKS about rate limits,
  so it looked like it was appearing for no reason. It was.

  While a session is up, ccx now speaks through the terminal notification and
  title, which draw nothing, and through the event log that `ccx dashboard` and
  `ccx history` read. The one thing still printed is a login problem found before
  the session starts, which is worth interrupting for. The per-session
  `session on "name"` line is gone entirely: the account is already in Claude's
  status line (`ccx statusline`) and in the terminal title.

### Changed

- **`ccx usage` is properly coloured.** Every window below 90 percent used to
  render the same grey, so a page of numbers read as one flat block and an
  account at 5 percent looked like one at 85. Usage is now on a four-band scale
  (green with room, amber getting tight, red nearly gone, bright red spent), the
  filled part of each bar carries the colour while the remainder stays dim, and
  the closing recommendation is highlighted because it is the line you act on.

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
