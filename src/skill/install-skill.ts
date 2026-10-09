import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { defaultClaudeRoot } from '../session/shared-root.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import type { PathCtx } from '../config/paths.js';

/**
 * The `/ccx` skill: every account's room, a swap, and how accounts get
 * signed in here or on a server, from inside Claude.
 *
 * Installed into `~/.claude/skills/ccx` by `ccx on`, where plain `claude`,
 * Claude Desktop and every ccx session read it. ccx owns the file: `ccx on`
 * rewrites it when ccx changes it, and `ccx off` removes it, but only while it
 * still carries ccx's mark, so a copy the user took over is left alone.
 *
 * The board is drawn by `ccx swap --json`, not by the model: bars, numbers and
 * order come out right every time, and the skill only lays them out.
 */

/** The line that marks the file as ccx's. Removing it hands the file to the user. */
export const SKILL_MARK =
  '<!-- installed by ccx (claude-auto-switch): `ccx on` keeps this current and `ccx off` removes it -->';

export const SKILL_TEXT = `---
name: ccx
description: See how much room every one of your Claude accounts has left, swap this session to another account, and sign accounts in here or on a server, with ccx (claude-auto-switch). Use when the user runs /ccx, /ccx swap or /ccx status, asks to swap or switch Claude accounts, asks which account has room, asks about usage limits across their accounts, or wants accounts signed in, ccx set up on another machine or server over SSH, or a server's logins kept alive.
---

${SKILL_MARK}

# ccx: your accounts, swapping between them, and signing them in

To sign accounts in or set up a server, skip to "Signing in" at the end.

The argument says what to do: \`swap\` (also what no argument means), \`swap <account>\`, or \`status\`.

## 1. Read the board

Run \`ccx swap --json\` with the Bash tool. It prints JSON with:
- \`here\`: where this session runs (\`ccx\` for a ccx terminal session, \`desktop\` for Claude Desktop, \`none\`) and its \`account\`
- \`board\`: the whole picture, already drawn
- \`accounts\`: one per account, best first, each with \`name\`, \`status\`, \`eligible\`, \`recommended\`, \`here\` and a \`card\`
- \`recommended\`: the account with the most room, or null
- \`swap.effect\`: what a swap does from here, in one sentence

If the command fails or \`ccx\` is not found, say ccx is not installed or not on PATH, and stop.

## 2. Show it

Print \`board\` exactly as given, inside a \`\`\`text code block. Do not redraw it, round anything, or turn it into a markdown table: the bars and columns are aligned already.

Then one plain sentence: where this session is (from \`here\`), and which account has the most room (\`recommended\`).

For \`/ccx status\`, stop here.

## 3. Ask

If the argument already names an account, go to step 4 with it.

Otherwise ask with the AskUserQuestion tool, one question:
- header: \`Swap to\`
- question: \`Swap this session to which account?\` followed by \`swap.effect\`
- options: up to 4 accounts with \`eligible\` true and \`here\` false, in the order given. Label the first \`<name> (Recommended)\` when it is \`recommended\`, the rest just \`<name>\`.
- each option's \`description\` is the account's \`status\`, and its \`preview\` is the account's \`card\`, exactly as given

If no account is eligible, say so, name the soonest reset from the board, and stop.

## 4. Swap

Run \`ccx swap <name>\` and report what it printed, in one or two plain sentences.

In Claude Desktop the conversation then continues in a terminal window as soon as this reply ends: tell the user to carry on there and not to send anything more here.

## Signing in, here or on a server reached over SSH

Never copy a login between machines or profiles (\`~/.claude-auto-switch/profiles\`, \`.credentials.json\`, the Keychain). A refresh token works once: whichever copy renews second is logged out, usually within hours. Each machine signs each account in on its own.

A sign-in needs the person: they approve it in a browser signed in to that account, and may paste a code back. So give them the command to run in the user's own terminal rather than running it with the Bash tool, where it would wait for input that never comes.

- This machine: \`ccx login <name>\`, or \`ccx login --all\` for every account that is signed out.
- A server, from a machine with a browser: \`ccx login --host <ssh-host> --all\`. It registers the accounts the server is missing and relays each sign-in there. ccx on the server must be 2.3.0 or newer and found by a login shell; otherwise add \`--remote-ccx '<path to node> <path to ccx>'\`.
- On the server, once: \`ccx keepalive on\`, so its logins renew while nobody uses it. \`ccx doctor\` there says what is still missing.

A sign-in that comes back as a different account than the one asked for is refused and the previous login kept: the browser was signed in to the wrong account, so the fix is to switch it and run the same command again.
`;

export function skillPath(c: PathCtx = {}): string {
  return path.join(defaultClaudeRoot(c), 'skills', 'ccx', 'SKILL.md');
}

export type SkillOutcome = 'installed' | 'updated' | 'already' | 'user-owned' | 'failed';

/** Put the skill in place, or bring an older copy of ccx's up to date. */
export function installSkill(c: PathCtx = {}): SkillOutcome {
  try {
    const file = skillPath(c);
    if (existsSync(file)) {
      const current = readFileSync(file, 'utf8');
      if (current === SKILL_TEXT) return 'already';
      // Somebody took it over (the mark is gone): theirs now, never overwritten.
      if (!current.includes(SKILL_MARK)) return 'user-owned';
      writeFileAtomic(file, SKILL_TEXT);
      return 'updated';
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, SKILL_TEXT);
    return 'installed';
  } catch {
    return 'failed';
  }
}

export type SkillRemoval = 'removed' | 'not-present' | 'user-owned' | 'failed';

/** Take ccx's skill away again, leaving a copy the user took over in place. */
export function removeSkill(c: PathCtx = {}): SkillRemoval {
  try {
    const file = skillPath(c);
    if (!existsSync(file)) return 'not-present';
    if (!readFileSync(file, 'utf8').includes(SKILL_MARK)) return 'user-owned';
    rmSync(file, { force: true });
    try {
      // Only ccx's file was ccx's: anything the user put beside it stays, folder and all.
      rmdirSync(path.dirname(file));
    } catch {
      /* not empty */
    }
    return 'removed';
  } catch {
    return 'failed';
  }
}
