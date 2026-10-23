# Lending logins to another machine

Running ccx (or `ccx worker`) on a second machine normally needs a sign-in of
each account on that machine too. Copying a login over instead does not last:
a refresh token works once, so when one copy renews, every other copy of the
old token stops working, and whichever machine renews second is signed out.

Lending fixes that. The machine that holds a login (the owner) shares only its
access token with the machines it lends to (receivers), never the refresh
token. The owner renews the login ahead of its expiry and sends the fresh
access token again before the old one runs out. A receiver cannot renew a lent
login at all, so it can never sign the owner out, and it needs no sign-in of
its own.

```sh
# once, to try it: lend one account to a machine you reach over SSH
ccx lend export work | ssh build-1 ccx lend import

# from then on, on the owner, every 15 minutes: renew ahead and re-deliver
ccx lend sync --quiet
```

## How it works

- **The owner** keeps the only refresh token, as it does today. `ccx lend sync`
  renews a login once it has less than `renewAheadMinutes` left, through the
  same renewal every other part of ccx uses: under the login's own lock, read
  again there, and never while a session or the editor is using that login.
- **A lend** is a small versioned JSON bundle: the access token, when it
  expires, its scopes and plan, and who the account is. It never contains the
  refresh token; `ccx lend import` refuses any bundle that does.
- **A receiver** installs the lend as an account of its own (registering it
  when it is new) and marks it as lent. ccx never tries to renew a lent login.
  Once one has less than `expiryMarginMinutes` left it is not picked for new
  work, workers included, and it reads as "lend expired", not "signed out".
- **Running sessions keep going.** A session on a receiver picks up a fresh
  lend within seconds of it arriving, the same way it picks up a login renewed
  elsewhere, so a long session or worker never has to restart for it.

## Setting it up

On the receiver, install ccx (2.7.0 or later). Nothing else is needed: an
account appears the first time a lend for it arrives.

On the owner, add a `lending` section to `~/.claude-auto-switch/config.json`
with one target per receiver:

```json
{
  "lending": {
    "renewAheadMinutes": 90,
    "expiryMarginMinutes": 10,
    "targets": [
      {
        "name": "build-server",
        "transport": { "type": "ssh", "host": "user@build-1" },
        "accounts": ["work-a", "work-b"]
      },
      {
        "name": "shared-dir",
        "transport": { "type": "directory", "path": "/srv/ccx-lends" },
        "accounts": "all"
      },
      {
        "name": "custom",
        "transport": { "type": "command", "run": "my-uploader --stdin" },
        "accounts": ["work-c"],
        "renewAheadMinutes": 120
      }
    ]
  }
}
```

Then check what it would do, and do it:

```sh
ccx lend sync --dry-run    # what would be renewed and sent; prints no token
ccx lend sync
ccx lend                   # what this machine lends, and what is lent to it
```

## Commands

| Command                     | What it does                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `ccx lend`                  | what this machine lends (its targets) and what is lent to it, with expiries (`--json`)         |
| `ccx lend export <account>` | the bundle that lends an account, to standard output or `--out <file>` (owner-only)            |
| `ccx lend import [file]`    | on a receiver: install the lend in a bundle, from a file or standard input (`--as <name>`)     |
| `ccx lend sync`             | renew ahead where needed and send every target a fresh lend (`--target <name>`, `--dry-run`)   |
| `ccx lend revoke <account>` | take a lend back through the targets that have it (`--target <name>`; `--local` on a receiver) |
| `ccx renew <account>`       | renew a login now when it has less than `--ahead` left (default 90m), or always with `--force` |

`ccx lend export` will not print to a terminal, so a token is not left in your
scrollback by accident: pipe it, use `--out`, or add `--force`. A bundle is
refused when it carries a refresh token, is malformed, is from a newer ccx, or
has already expired. Importing a lend that is no fresher than the one already
installed changes nothing, so delivering the same bundle twice is harmless.

`ccx lend sync` exits non-zero when anything that should have been sent was
not, so a scheduler can tell you. With `--quiet` it prints only those
failures.

## Configuration

| Key                                     | Default       | Meaning                                                                  |
| --------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| `lending.renewAheadMinutes`             | `90`          | the owner renews a login it lends once less than this is left            |
| `lending.expiryMarginMinutes`           | `10`          | a lent login with less than this left is not used; never sent that close |
| `lending.targets[].name`                |               | the target's name, for `--target` and messages                           |
| `lending.targets[].transport`           |               | how a bundle reaches it: `ssh`, `directory` or `command` (below)         |
| `lending.targets[].accounts`            |               | a list of account names, `"all"` or `"all-except-active"`                |
| `lending.targets[].renewAheadMinutes`   | the section's | this target's own renew-ahead time                                       |
| `lending.targets[].expiryMarginMinutes` | the section's | this target's own margin                                                 |

Without a `lending` section, lending is off and `ccx lend sync` says so. A
receiver needs no section; it may set `expiryMarginMinutes` for its own margin.
`renewAheadMinutes` must be more than `expiryMarginMinutes`.

`"all"` lends every enabled account this machine holds a login of its own for,
and skips the rest with a note; `"all-except-active"` leaves out the account
new sessions start on here. An account a target names by name must be
lendable, or the sync counts it as a failure.

### Transports

Each transport hands the bundle over on standard input or in an owner-only
file, never on a command line, where other users of either machine could read
it in the process list.

- **`ssh`**: `{ "type": "ssh", "host": "user@build-1" }` runs `ccx lend import`
  on the other machine, through its login shell as `ccx login --host` does,
  with the bundle on its standard input. Set `"remoteCommand"` when ccx is not
  on that shell's `PATH`, for example
  `"/home/me/.nvm/versions/node/v22.19.0/bin/node /home/me/.nvm/versions/node/v22.19.0/bin/ccx lend import"`.
  ssh runs with `BatchMode=yes`, so it never stops to ask for a password: use
  a key (an agent works).
- **`directory`**: `{ "type": "directory", "path": "/srv/ccx-lends" }` writes
  `<account>.json` there, replaced whole and owner-only. The receiver imports
  from it on its own schedule, for example `ccx lend import /srv/ccx-lends/work-a.json`
  for each account. Useful for a shared or synced folder, or a mounted volume.
- **`command`**: `{ "type": "command", "run": "my-uploader --stdin" }` runs
  through the shell with the bundle on its standard input, and with
  `CCX_LEND_ACCOUNT` and `CCX_LEND_KIND` (`lend` or `revoke`) set. Zero exit
  means delivered. Its output is shown only with the token taken out of it.

## Keeping lends fresh

Run `ccx lend sync` on the owner more often than `renewAheadMinutes` minus
`expiryMarginMinutes`; every 15 minutes suits the defaults. It renews each
login at most once a run, so running it often costs nothing extra. Use the
full path to ccx (`command -v ccx`), since a scheduler does not read your
shell's profile.

cron:

```sh
*/15 * * * * /usr/local/bin/ccx lend sync --quiet
```

launchd (`~/Library/LaunchAgents/ccx.lend-sync.plist`, then
`launchctl load` it):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ccx.lend-sync</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/ccx</string><string>lend</string><string>sync</string><string>--quiet</string></array>
  <key>StartInterval</key><integer>900</integer>
</dict>
</plist>
```

systemd (user units, then `systemctl --user enable --now ccx-lend-sync.timer`):

```ini
# ~/.config/systemd/user/ccx-lend-sync.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/ccx lend sync --quiet

# ~/.config/systemd/user/ccx-lend-sync.timer
[Timer]
OnBootSec=1min
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
```

## On a receiving machine

A lent account works like any other: rotation, `ccx worker`, `ccx use` and the
dashboard all see it. `ccx list` shows it as `lent, until 14:05`, or
`lend expired` once it is inside the margin, and `ccx state` gives its expiry
as `lent.expiresAt`, with `status.state` `lend-expired` once it is inside the
margin (see [reading ccx from another program](reading-ccx-from-another-program.md)).
Nothing on the receiver ever renews it: it waits for the owner. `ccx login
--all` skips lent accounts, and `ccx doctor` names an expired lend instead of
telling you to sign it in.

`ccx login <account>` on the receiver gives that machine a login of its own
instead. From then on lends for that account are refused there (a lend never
replaces a login of the machine's own), and the owner's sync reports it until
you take the account out of that target.

## Taking a lend back

```sh
ccx lend revoke work-a                    # on the owner, through every target that lends it
ccx lend revoke work-a --target shared-dir
ccx lend revoke work-a --local            # on the receiver itself
```

The receiver removes the lent login, and the account too when the lend was
what registered it. It never touches a login of its own. Revoking does not
change your config: take the account out of the target's `accounts` too, or
the next sync lends it again (revoke says so).

A session already running on the receiver keeps the copy it has until that
token expires, at most the lend's remaining life. To cut access at once, sign
the account out at claude.ai, which ends every login of it, the owner's
included.

## Security notes

- A refresh token never leaves the owner: not in a bundle, a delivery, a log,
  an error or a dry run. A receiver refuses a bundle that carries one.
- An access token is still a credential for as long as it lives. Bundles and
  lent logins are written owner-only (0600) and atomically, ccx never prints a
  token, and its messages name the account and the step, never a value.
- A receiver trusts what it imports. Whoever can write to its import (its ssh
  login, the shared directory, your command) can point its sessions at an
  account of their choosing. Keep the directory writable by you alone (ccx
  creates it owner-only) and the ssh key yours.
- Lent logins on a shared machine are as private as that machine: anyone with
  root there can read them.

## Limits

- A receiver needs a fresh lend before the last one expires. While the owner
  is off or asleep, its lends run out, and the receiver says so.
- The margin covers clock differences between the machines and the minutes
  Claude itself wants before an expiry: keep it at 10 minutes or more.
- The owner never renews a login a session of its own is using. That session
  renews it itself, near its expiry, and the next sync sends the result.
- A receiver cannot lend what it was lent; only the owner lends a login.
- Both machines spend the same account's usage limits.
