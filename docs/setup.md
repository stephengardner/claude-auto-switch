# Setup

## What `ccx on` sets up

`ccx on` sets up four things, and `ccx off` removes them:

- a `claude` function that runs Claude through ccx, in every shell you use
  (see [which shells](#which-shells))
- the Claude Code extension in Cursor and VS Code, on a config folder of its
  own (see [the editor's own folder](how-it-works.md#moving-a-session))
- ccx's part of Claude's status line (an existing status line is kept, wrapped)
- the `/ccx` command inside Claude

`ccx doctor` checks the whole setup: shell by shell, whether typing `claude`
goes through ccx there, and which account each profile is really signed in as.
Two profiles holding one account would end each other's logins on renewal, so
ccx refuses such a sign-in and keeps the previous login.

## Which shells

Each shell reads its own startup files, so `ccx on` puts the `claude` function
in every file a shell reads when it starts, once per shell:

- **Windows**: Windows PowerShell always, since it comes with Windows and is
  what the Start menu opens, and PowerShell 7 when it is installed. Each has its
  own `profile.ps1`, the profile every host reads: Windows Terminal, a
  standalone window, the terminal in Cursor or VS Code, and the PowerShell
  extension's terminal alike. Git Bash too, when it is installed and has been
  used. cmd has no profile, so `claude` there runs on its own; use `ccx run` in
  cmd, or PowerShell.
- **macOS and Linux**: zsh in `.zshrc`, and bash in `.bashrc` and in the login
  file bash reads instead of it (`.bash_profile`, `.bash_login` or `.profile`),
  unless that file loads `.bashrc` already. A Mac terminal starts bash as a
  login shell, which reads only the login file.

zsh, bash and Git Bash are set up when the shell is your login shell, has a
startup file or a history file, or already has the function. One with none of
those has never been set up or opened here, so ccx leaves it alone rather than
create files for it, and `ccx on --shell <name>` (`zsh`, `bash`, `powershell` or
`pwsh`) sets it up anyway. After updating from an older ccx, which set up only one shell, run
`ccx on` once to add the others.

A Windows execution policy of `Restricted` or `AllSigned` stops PowerShell
running any profile, and npm's `ccx` command with it. ccx writes no profile
there, since PowerShell would show an error in every window it opens.
`ccx doctor` names the policy. When it is your own or the machine's setting,
doctor gives the command that allows local scripts for you alone, but never
runs it:
`powershell -NoProfile -Command Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
(`pwsh` for PowerShell 7). Then run `ccx on` again. When Group Policy sets it,
that command changes nothing, so doctor says to ask an administrator instead.

## Finding Claude on Windows

ccx starts Claude's own program, `claude.exe`, never npm's `claude.cmd`, which
Windows cannot start without a shell. It looks on `PATH`, where Claude installs
itself, and beside npm's `claude.cmd` in
`node_modules\@anthropic-ai\claude-code\bin\claude.exe`.

npm installs that file as a short placeholder script, and Claude Code's setup
step then puts the real program over it from a second package,
`@anthropic-ai/claude-code-win32-x64` (or `-arm64`). Sometimes the install
loses that program and keeps only the placeholder, nothing, or not even its
package folder, while npm's `claude.cmd` still points there. The suspected
cause, not yet confirmed, is an update that ran while Claude was open, since
Windows can refuse to delete or overwrite the file of a program that is
running. ccx repairs such an install before it starts Claude: from the second package when it is
still there, with no download, or else by reinstalling the same version with
npm. It does not repair an install that changed in the last three minutes,
which npm may still be writing, though it starts Claude from the second
package once that has been left alone for half a minute. It does not repeat a
repair that failed for an hour, or until the install changes. `ccx worker`
never repairs. `ccx doctor` reports such an install and `ccx doctor --fix`
repairs it, and holds off npm while the install's files are still changing.
That check reads file times, so it can miss an npm at work when every file is
dated more than two seconds ahead of this machine's clock. If the repair cannot
help, close every Claude window, then run
`npm i -g @anthropic-ai/claude-code`, or install the
[native build](https://code.claude.com/docs/en/setup). To point ccx at a Claude
somewhere else, set `realClaudePath`.

## Inside Claude: `/ccx`

`/ccx` shows every account's room and swaps the current session to the one you
pick: in place in a ccx session, or, in Claude Desktop, by continuing the
conversation in a terminal. From a shell, `ccx swap [name]` does the same.
