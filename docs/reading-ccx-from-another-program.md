# Reading ccx from another program

ccx keeps its state in `~/.claude-auto-switch/`. Do not read those files.

They are ccx's own bookkeeping, they change shape between releases without
warning, and reading them has already cost real time: a consumer that probed
those directories to find Claude sessions went blind when ccx started giving
each login its own config root, and reported a live session as absent while its
transcript grew to 87MB.

Use the commands below instead. They are a contract; the directory layout is not.

## Everything, in one read

```sh
ccx state
```

Always JSON, no flag needed. It is built the same way the live dashboard is, so
both judge the state by the same rules. Each call is a snapshot of the moment it
was taken, not a subscription: poll it if you want to keep up.

```json
{
  "schemaVersion": 1,
  "ccxVersion": "1.46.0",
  "now": 1786928494464,
  "active": "maxed",
  "preferredModel": "fable",
  "nextUp": "staying here, on fable (92% left)",
  "whenOut": { "account": null, "model": null, "changesModel": false },
  "settings": {
    "accountOrder": "smart",
    "modelPreference": ["fable", "opus"],
    "modelStrategy": "model-first",
    "preferSameModel": true,
    "holdBackAtPercent": 80,
    "proactivePercent": null
  },
  "accounts": [
    {
      "name": "main",
      "email": "you@example.com",
      "plan": "max",
      "loggedIn": true,
      "onHold": false,
      "enabled": true,
      "active": false,
      "priority": 0,
      "tags": [],
      "pool": "lanes",
      "configDir": "/home/you/.claude-auto-switch/profiles/main",
      "loginCheckedAt": 1786928490112,
      "cappedUntil": 1787011199665,
      "usage": {
        "fiveHour": 0,
        "sevenDay": 1,
        "fiveHourReset": null,
        "sevenDayReset": 1787011199665,
        "models": [{ "name": "Fable", "utilization": 1, "resetsAt": 1787011199665 }],
        "readAt": 1786928201337,
        "windowCost": 0.18
      },
      "runway": {
        "windows": 0,
        "binding": "weekly",
        "weeklyWindowsLeft": 0,
        "weekLeft": 0,
        "worthMoving": false
      },
      "heldBack": true,
      "pick": null,
      "status": {
        "state": "blocked",
        "label": "fable",
        "until": 1787011199665,
        "blockedBy": [
          { "label": "week", "until": 1787011199665 },
          { "label": "fable", "until": 1787011199665 }
        ]
      }
    }
  ],
  "sessions": [
    {
      "pid": 41872,
      "account": "maxed",
      "cwd": "/home/you/work/api",
      "configDir": "/home/you/.claude-auto-switch/sessions/41872",
      "lastSeen": 1786928480001
    }
  ],
  "events": ["23:33  session on maxed"]
}
```

### Use `status`, do not recompute it

`status.state` is one of `ready`, `blocked`, `disabled`, `logged-out`,
`on-hold`. `on-hold` is an account Anthropic put on hold: its login was refused
with `account_on_hold`, and signing in again does not bring it back.

It is shipped rather than left for you to derive because the rule is easy to get
subtly wrong, and getting it wrong is invisible. ccx itself had two surfaces
deciding this separately, and they drifted: the dashboard printed `ready` beside
a window reading 100% while rotation refused to use that same account.

- `label` is what to name to a person: a model when the model is what is spent,
  otherwise `5h`, `week` or `capped`.
- `until` is when the account can be used again, which is when the LAST thing
  blocking it lifts, not the first. Null when nothing is blocking, or when no
  reset time is known.
- `blockedBy` is everything blocking it, when you want to explain the wait
  rather than just state it.

### Tags

Every account carries `tags`, a list of the labels given it with `ccx tag`
(`["bot", "pat"]`), empty when it has none. Lowercase, sorted, each 1 to 32
characters of letters, digits, `.`, `_` and `-`. Tags never change rotation.

### Pools

Every account carries `pool`, the one group it is drawn from (`ccx pool <name>
lanes`), or null when it is in none. A tag says what an account is and an
account has many; a pool says which group a program takes it from, so it is in
one at most. Written the way a tag is. Pools never change rotation: ccx moves a
session by the same rules whatever pool its account is in. A ccx older than
2.6.32 drops pools, and tags, when it rewrites the accounts file.

### Where it stands, and why

What the dashboard works out for every account, as values:

- `runway` is where it stands for the next move, by the rule rotation picks by:
  `windows` is the work it can do before a window stops it, in full 5-hour
  windows (0 to 1), `binding` the window that would stop it first (`5-hour`,
  `weekly`, `model`, or `none`), `weeklyWindowsLeft` what is left of its week in
  5-hour windows, `weekLeft` the share of its week left (the tighter of the
  account's week and the preferred model's own), and `worthMoving` whether that
  is enough to move a session onto. Given for every account, picked or not.
- `heldBack` is true when its week is so nearly spent that rotation picks it
  after every healthy account (`settings.holdBackAtPercent`).
- `pick` is its place in the order rotation picks from, `rank` 1 being the next
  pick, with the `binding` window; null for an account rotation would not pick
  now (disabled, signed out, capped).
- `onHold` is true for an account Anthropic put on hold (its `status.state` is
  then `on-hold`).
- `configDir` is its profile folder, the `CLAUDE_CONFIG_DIR` a session on it
  reads its login from.

### When the numbers were read

`usage.readAt` is when the numbers in `usage` were last read successfully, null
when that is not known (an entry no read of this version has written, or one an
older ccx has written numbers to since). It is not how recently ccx tried: a
read that fails keeps the old numbers, so numbers that look current can be days
old, and this is how to tell. `usage.windowCost` is what one full 5-hour window costs the
week on that account, learned from its own readings, so `1 / windowCost` is
about how many 5-hour windows its week holds.

### Sessions, the next move, the settings

- `sessions` lists the ccx sessions running now, one per process: `pid`, the
  `account` it is on, the folder it started in (`cwd`, when known), the
  `configDir` it reads its login from, and `lastSeen`.
- `whenOut` is where a session on the active account goes once that account
  cannot be used: rotation's plan without it, so never the active account
  itself. `account` (null when no other account has room), the `model` it would
  run there (null when nothing pins one), and `changesModel`. Null when there is
  nothing to plan for.
- `settings` are the rotation settings in force: `accountOrder`,
  `modelPreference`, `modelStrategy`, `preferSameModel`, `holdBackAtPercent`
  and `proactivePercent`, each null when that behaviour is off.

### A cheap read

Most of what one `ccx state` costs is checking every account's login, a run of
`claude auth status` each. `ccx state --cached-logins <seconds>` uses a login
check at most that many seconds old instead, where one is remembered: `ccx
state`, `ccx list`, `ccx status` and an open `ccx dashboard` (every 20 seconds)
remember the checks they make. A check is used only for the same account in the
same folder, and never once its login file has changed since; a login kept in
the macOS Keychain has no file, so only the age bounds its check.
`loginCheckedAt` on each account says when its check was made, so you always
know how old what you are reading is; `--cached-logins 0` asks again.
Usage still refreshes on its own schedule either way.

### An account with no 5-hour limit

A verified Ultra account has no 5-hour limit, only weekly ones (since
2026-10-30). Its `usage` then carries `"noFiveHourLimit": true`, with
`fiveHour` and `fiveHourReset` null. Without that field, a null `fiveHour`
means only that no number was read. Such an account is never blocked by `5h`.

All times are absolute epoch milliseconds. Compare them against `now` from the
same payload, not against your own clock, so a slow read cannot make a live
window look expired.

## Acting on it

```sh
ccx use <name>       # switch the active account
ccx rotate           # move to the next account with room
ccx enable <name>    # put an account back in rotation
ccx disable <name>   # take it out without removing it
ccx login <name>     # sign an account in again
```

These are ordinary commands with exit codes: zero means it happened.

## The rest of the JSON surface

Every machine-readable output carries `schemaVersion` and wraps its rows, so you
never have to remember which ones do:

```sh
ccx status --json    # { schemaVersion, accounts: [...] }  health per account
ccx usage --json     # { schemaVersion, accounts: {...} }  raw usage windows
ccx list --json      # { schemaVersion, accounts: [...] }  the registry
ccx doctor --json    # { schemaVersion, ok, checks: [...] } what is wrong
ccx history --json   # { schemaVersion, credentialEvents, switchEvents }
ccx tags --json      # { schemaVersion, tags: [...] }       every tag in use
ccx pools --json     # { schemaVersion, pools, unpooled }   every pool in use
ccx resume-prompt --session <pid> --json   # { schemaVersion, pid, armed, ... }
```

`ccx tag`, `ccx untag`, `ccx pool` and `ccx unpool` answer `--json` with what
the account carries now (`{ schemaVersion, account, tags }`, or `account`,
`pool` and `previous`), and a refusal as `{ schemaVersion, error }` with exit 1.

### History

Each of `credentialEvents` has a `reason`, why it happened, as a value: the
`detail` beside it is a sentence for a person and may be reworded. One per
thing ccx does to a login, for example `idle-renewal`, `renewed-before-start`,
`carried-shared-login`, `on-hold`, `renewal-refused`, `no-login`,
`renewal-unavailable`, `session-using-it` or `saved-cut-short`; `unknown` for a
record ccx cannot place.

`switchEvents` are the account moves, each with `at`, `kind`, `from`, `to` and
`reason`. `kind` is `moved` (in place, no restart), `move-failed`,
`move-waiting`, `move-asked`, `editor-moved`, `ran-out` or `started`; `reason`
is `capacity`, `asked`, `proactive`, `follows-active`, `session-start`,
`continued` or `unknown`; `from` and `to` are account names or null. A move
made early, by `ccx auto` or by a session itself, says `proactive` at each step;
one asked for by a person says `asked`. The same move several times in a row is
one, with `count`. A record from before 2.6.33 that wrote only words for a move
is not among them. With `--logins`, only `credentialEvents` is given.

`ccx state` is the one to build a UI on. The others answer narrower questions.

## Versioning

`schemaVersion` goes up when a field changes meaning or disappears. Adding a
field does not bump it, so read defensively and ignore what you do not know.

`ccxVersion` is the build that produced the payload, which is worth logging
next to anything you report: it is how "it did this" gets tied to the code that
did it.

## Cost

`ccx state` checks every account's login with Claude, all at once, and refreshes
the usage of any account read more than 5 minutes ago, one at a time, over the
network (roughly one token per account per window). That is not cheap: on one
machine with 17 accounts, measured on 2026-11-07, one read took 48.75 s and 8 to
18 s of CPU, almost all of it the login checks. Read it on a slow cadence, one
read at a time, or with `--cached-logins` (see [a cheap read](#a-cheap-read)),
which leaves out every login check it can.
