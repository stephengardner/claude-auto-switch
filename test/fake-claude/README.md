# fake-claude

A stand-in for the real `claude` CLI, used by the test suite so the whole tool
(health probing, selection, rotation, launching) can be exercised with **zero
real accounts, zero logins, and zero model spend**.

## How it works

`fake-claude.mjs` is plain Node (no build step) so tests can invoke it directly:

```
node test/fake-claude/fake-claude.mjs <args>
```

Its behavior is driven by a **scenario** JSON, resolved in this order:

1. `FAKE_CLAUDE_SCENARIO` environment variable (absolute path to a scenario file)
2. `<CLAUDE_CONFIG_DIR>/fake-scenario.json`
3. a built-in logged-out default

## Commands honored

- `auth status`: prints the scenario's `authStatus` JSON, exits 0 if `loggedIn` else 1.
- `auth login ...`: simulates a successful login by writing a logged-in
  `fake-scenario.json` into `CLAUDE_CONFIG_DIR`, exits 0.
- anything else (a "run", e.g. `-p "..."`): if the scenario is `capped`, prints
  `capMessage` to stderr and exits `capExitCode`; otherwise records the
  invocation to `<CLAUDE_CONFIG_DIR>/fake-last-run.json` and exits 0.

## Scenario shape

```json
{
  "authStatus": { "loggedIn": true, "email": "...", "subscriptionType": "max" },
  "capped": false,
  "capMessage": "Usage limit reached...",
  "capExitCode": 1
}
```

Ready-made scenarios live in `scenarios/`.
