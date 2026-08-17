# Reading ccx from another program

ccx keeps its state in `~/.claude-auto-switch/`. Do not read those files.

They are ccx's own bookkeeping, they change shape between releases without
warning, and reading them has already cost real time: a consumer that probed
those directories to find Claude sessions went blind when ccx started giving
each login its own config root, and reported a live session as absent while its
transcript grew to 87MB.

Use the commands below instead. They are a contract; the directory layout is not.

## Everything, in one read

```
ccx state
```

Always JSON, no flag needed. This is the same view the live dashboard draws, so
the two cannot disagree.

```json
{
  "schemaVersion": 1,
  "ccxVersion": "1.46.0",
  "now": 1786928494464,
  "active": "maxed",
  "preferredModel": "fable",
  "nextUp": "staying here, on fable (92% left)",
  "accounts": [
    {
      "name": "main",
      "email": "you@example.com",
      "plan": "max",
      "loggedIn": true,
      "enabled": true,
      "active": false,
      "priority": 0,
      "cappedUntil": 1787011199665,
      "usage": {
        "fiveHour": 0,
        "sevenDay": 1,
        "fiveHourReset": null,
        "sevenDayReset": 1787011199665,
        "models": [{ "name": "Fable", "utilization": 1, "resetsAt": 1787011199665 }]
      },
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
  "events": ["23:33  session on maxed"]
}
```

### Use `status`, do not recompute it

`status.state` is one of `ready`, `blocked`, `disabled`, `logged-out`.

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

All times are absolute epoch milliseconds. Compare them against `now` from the
same payload, not against your own clock, so a slow read cannot make a live
window look expired.

## Acting on it

```
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

```
ccx status --json    # { schemaVersion, accounts: [...] }  health per account
ccx usage --json     # { schemaVersion, accounts: {...} }  raw usage windows
ccx list --json      # { schemaVersion, accounts: [...] }  the registry
ccx doctor --json    # { schemaVersion, ok, checks: [...] } what is wrong
ccx history --json   # { schemaVersion, credentialEvents } login history
```

`ccx state` is the one to build a UI on. The others answer narrower questions.

## Versioning

`schemaVersion` goes up when a field changes meaning or disappears. Adding a
field does not bump it, so read defensively and ignore what you do not know.

`ccxVersion` is the build that produced the payload, which is worth logging
next to anything you report: it is how "it did this" gets tied to the code that
did it.

## Cost

`ccx state` probes account health and refreshes usage, which touches the network
(TTL-cached, roughly one token per account per window). Polling every couple of
seconds is fine. Polling many times a second is not, and would tell you nothing
new anyway.
