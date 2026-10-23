# On a server you reach over SSH

A server keeps Claude working while your laptop sleeps. ccx runs there as it
does anywhere, and you can do the server's sign-ins from your laptop.

Each machine needs its own login of each account. A refresh token can be used
once, so a login copied between machines ends whichever copy renews second.
To skip those sign-ins, one machine can lend its logins to the others instead,
access tokens only: see [lending logins to another machine](lending.md).

```sh
# on the server, once
npm install -g claude-auto-switch
ccx on
ccx keepalive on               # renew idle logins every four hours (cron)

# on your laptop, whenever the server needs signing in
ccx login --host my-server --all
```

`ccx login --host` asks ccx on the server which accounts need a sign-in and
registers any it is missing (the name and address, never a login). Then it
relays each sign-in: the server starts it and sends the link, your laptop's
browser approves it, and the code goes back. With Chrome started with
`--remote-debugging-port=9222` approving is automatic; otherwise ccx shows the
link and asks you to paste the code. The server's ccx still checks who signed
in, and refuses a login that belongs to a different account than the one the
profile is registered for. A profile registered without an address takes the
account that signs in and records it, unless another profile already holds that
account. Only an exact Claude Code sign-in
link is approved without you seeing it; any other link on an Anthropic address is
shown for you to check, and links anywhere else are never opened.

ccx runs on the server through your login shell, which is where an npm install
puts it on the PATH. When that shell does not find node and ccx (for example,
nvm set up only in `.bashrc`, below its line that stops non-interactive shells),
either move the nvm lines into the file your login shell reads (`~/.profile`,
`~/.bash_profile` when it exists, or `~/.zprofile` for zsh) or name both:
`--remote-ccx '/home/me/.nvm/versions/node/v22.19.0/bin/node /home/me/.nvm/versions/node/v22.19.0/bin/ccx'`.

Signed in on the server itself, `ccx login` sees there is no browser and lets
Claude print the link and take the pasted code.

Logins on a shared machine are as private as that machine: anyone with root
there can read them.
