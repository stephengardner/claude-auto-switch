# How ccx works

## Moving a session

**A config folder per session.** Claude reads its login from its config folder
(`CLAUDE_CONFIG_DIR`). ccx runs each session on its own folder,
`~/.claude-auto-switch/sessions/<pid>`, holding that session's login. Changing
account means replacing that login, without a restart. Claude picks it up at
its next request, because ccx then changes the time on the folder's
`.credentials.json`, which Claude watches. When Claude has moved the session's
login into the macOS Keychain itself, which leaves no such file, ccx creates
it as `{}`, which holds no login, for the same reason. Only if that cannot be
done may Claude keep using the previous login for up to about 30 seconds after
a move.

**Everything else is your `~/.claude`.** The session folder links your projects
and transcripts, prompt history, `/rewind` checkpoints, plugins, skills, agents,
todos and memory. Settings start as a copy of your `settings.json`. What Claude
changes during a session (a model picked with `/model`, a permission, a hook, an
MCP server, a trusted folder) is merged back into your own `settings.json` and
`~/.claude.json`, and logged. If you changed the same setting elsewhere, yours
wins.

**Detecting a spent account.** Claude writes every refused turn into the
conversation's transcript, with error codes. ccx reads that record, never the
screen, and confirms against the account's real usage before it acts. When the
usage check cannot answer (its budget is shared by every session on the
machine), only one kind of refusal confirms it instead: one Claude recorded
for the current turn with the code for a spent usage limit
(`usage_limit_reached`) and a limit it can name. It holds as wide as that
limit, the whole account or one model, until the reset the refusal names.
When it names none, an account-wide limit keeps the end another session
already recorded for the account, if there is one; anything else takes the
configured backoff. Any other refusal waits for the usage check, and even the
right one never counts while ccx knows of another live Claude on the same
conversation, since every Claude on a conversation writes to the same record.
That covers sessions in the terminal, workers and `claude -p` runs whose
conversation is named or reported in JSON, not yet the editor launch. Text on
screen that talks about usage limits never moves a session.

**Detecting a finished login.** A login can be revoked long before its stored
expiry: signed out at claude.ai, or the account put on hold. ccx asks Anthropic
rather than trusting the expiry. A token the usage endpoint turns away is
renewed at once (never one a session or your editor may be using), and when the
token endpoint refuses that, the account leaves rotation. A session start asks
first, and a "Please run /login" inside a running session is checked the same
way; when the login really is finished, the session moves to the next account
and carries on. An account Anthropic put on hold shows as `on hold`, since
signing in again does not bring it back.

**Moving.** A refused turn has already ended, so the session needs another
account and to be told to carry on. ccx replaces the login under the running
Claude, so its subagents, background commands and scheduled loops keep running,
then types a short carry-on prompt into it once Claude is back at its prompt
with nothing typed in the input box (set the prompt with `ccx resume-prompt`, or
`resume` in the config). A subagent's refused turn starts the same move, before
the main thread meets the limit. On a limit Claude opens its own usage-limit
menu (`/rate-limit-options`) and waits there; after a move ccx closes that menu
so the carry-on prompt can be typed, and answers no other dialog. When the next account's login is due for
renewal, ccx renews it first and then moves in place, unless another session may
be using that login, since renewing it would sign that session out. Your editor
being on it does not stop this: Claude renews a login under the same lock ccx
takes, and reads it again under it. (On macOS, once the editor's Claude has
saved a login it keeps it in a Keychain item of its own and no longer follows
the account ccx points it at: #129.)
When every account looks out of room, ccx moves the session in place to the
account a relaunch would have started it on anyway, and says so, because that
judgement is cached and can be wrong. It never guesses its way onto an account
the session itself has seen run out while that limit lasts; when that leaves
nothing to try, the relaunch takes over, as before. A session started anyway,
because every account looked out of room, lets the limit it started under be,
and acts on limits again as soon as another account has room. ccx relaunches Claude with
`--resume <conversation>` and the prompt instead when the limit is one model's,
when the next account has only a long-lived token, when the session was started
with a long-lived token, when the next account's login is due for renewal and
cannot be renewed here, or when the session has stopped and the prompt cannot
be typed safely: something is typed in the input box, a dialog stays open, or
Claude does not say what it is doing. A switch you make yourself (`ccx use`,
`/ccx`) happens in place, by the same rule, renewing a login that is due first;
when it needs a restart instead, ccx waits until Claude has been idle for 20
seconds (`--now` restarts at once).

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

A pinned account (`ccx use <name>`) comes first while it is enabled, signed in
and not out of room; otherwise the rule above picks, as if nothing were pinned.

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
