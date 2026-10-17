# Claude Desktop

Desktop runs its conversations on its own signed-in account, and nothing outside
Desktop can switch them. ccx moves a Desktop conversation to a terminal instead,
where it does switch, keeping its history, model, effort and permission mode:

```sh
ccx desktop                   # Desktop's account and its open conversations
ccx desktop move 2            # continue conversation 2 in a terminal (--wait)
ccx desktop handoff credits   # move by itself: off | limit | credits
```

- `handoff limit` moves a conversation when its turn is refused for a usage
  limit or for credits (`rate_limit` or `billing_error`), and only when another
  account has room and the move can be started. Any other refusal stays in
  Desktop.
- `handoff credits` also holds back a message once Desktop's account is past its
  plan, so it does not spend usage credits there, and continues it in a
  terminal on another account. The message goes to Desktop after all when it
  cannot be carried over (too long for a command line), no other account has
  room, there is no terminal program to open, or the move cannot be started;
  holding it with nowhere to send it would lose it.
- Both are hooks in `~/.claude/settings.json`. A moved conversation continues as
  a copy (`ccx desktop mode fork`, the default) or as itself (`mode same`).
