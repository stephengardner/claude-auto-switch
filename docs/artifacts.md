# Pages published with Claude's Artifact tool

A page Claude publishes with its Artifact tool is private to the account that
published it, and only that account can change it. With several accounts,
pages scatter, and a session on one account cannot update a page another
published. Two settings, both off by default, keep them together:

```sh
ccx config artifacts.home work        # every new page is published as "work"
ccx config artifacts.updates owner    # a change to a page goes out as the account that owns it
ccx artifacts                         # the pages ccx has recorded, and who owns each
```

For one call, ccx holds the session on the account the page belongs on: it
moves the session there in place when it is on another one, sends the call,
and moves it back, waiting up to 15 seconds for that to finish. If the move back
fails or takes longer, Claude's next request can still go out as the page's
account. When the session is on that account already,
ccx still holds it there and has Claude pick up the login in its folder, since
Claude can be up to 30 seconds behind an ordinary move. Two calls for the same
account at once share one move, and the session goes back after the later
one. The session never restarts, and the account new sessions start on is not
touched. A hold ends when the call is over, when its result shows up in the
conversation, before Claude's next request after the call (even one refused
by your own hook or a permission rule), or after two minutes, whichever comes
first. Ending it before that next request for a refused call needs Claude Code
2.1.294 or later (the oldest version checked); an older Claude may send that
request on the account the session was visiting, until the refusal shows up
in the conversation or the two minutes run out. If the call cannot be held there (the account is not signed in, the
session signs in with a `ccx token` of another account, it was signed in as
someone else from inside with `/login`, or `config.json` does not load), it is
refused with the reason, so a page never lands on the wrong account without
anyone knowing. A usage limit hit by the other account during the move is not
counted against the session's own.

ccx records each page a ccx session publishes while either setting is on, and
each page it deletes: a deleted page leaves `ccx artifacts`, and publishing
its file again makes a new page, on the home account when one is set. Past
512 KiB the record is folded to half that, dropping first the pages published
or listed least recently. A page dropped that way is unknown again: a call that
names its link goes out as the session's account until a scan records its
owner, and publishing its file again from the conversation that made it makes
a new page, as above, since no scan can tell which conversation and file it
came from. An update to a page
published before that goes out as the session's account, and ccx says so,
once for each page. `ccx artifacts scan` asks each signed-in account for the
pages it already has, with one headless Claude. It is best effort: it relies
on a Claude Code variable that is not documented (`CLAUDE_CODE_ARTIFACT=1`).

Turning either setting on adds four hooks to `~/.claude/settings.json`: three
on the Artifact tool and one that runs after each batch of tool calls and
leaves at once when no Artifact call is in it. Turning both off removes them.
The dashboard asks before it edits that file; `ccx config` edits it as soon as
you set the value. A running session picks the hooks up when its Claude next
starts. They do nothing in plain `claude`, Claude Desktop or the editor.

For one session alone, `CAS_ARTIFACTS_HOME=<account>` (or `off`) and
`CAS_ARTIFACTS_UPDATES=owner` (or `off`) in the environment of the `ccx` that
starts it take the place of the two settings. They do nothing unless the hooks
are already in `~/.claude/settings.json`.
