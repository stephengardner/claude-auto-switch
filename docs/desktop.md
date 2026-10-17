# Claude Desktop

Desktop runs its conversations on its own signed-in account, and nothing outside
Desktop can switch them. ccx moves a Desktop conversation to a terminal instead,
where it does switch, keeping its history, model, effort and permission mode:

```sh
ccx desktop                   # Desktop's account and its open conversations
ccx desktop move 2            # continue conversation 2 in a terminal (--wait)
ccx desktop handoff credits   # move by itself: off | limit | credits
```

- `handoff limit` moves a conversation when its turn is refused.
- `handoff credits` also holds back a message once Desktop's account is past its
  plan, so Desktop never spends usage credits.
- Both are hooks in `~/.claude/settings.json`. A moved conversation continues as
  a copy (`ccx desktop mode fork`, the default) or as itself (`mode same`).
