import { randomUUID } from 'node:crypto';

/**
 * Staying in the SAME conversation across an account swap.
 *
 * A swap ends the child and starts another, and the new one has to pick the
 * conversation back up. That was done with `--continue`, which Claude documents
 * as "continue the most recent conversation in the current directory". Most
 * recent IN THE DIRECTORY, not the one this terminal was in: with two sessions
 * open on the same project, a swap in one of them could resume the other one's
 * conversation, and the operator would find themselves in somebody else's
 * thread with no way back.
 *
 * So the run names its own conversation instead. Claude takes `--session-id` on
 * a fresh start and `--resume <id>` afterwards, and resuming keeps the same id
 * (creating a new one needs `--fork-session`, which a relaunch never passes).
 * Nothing then depends on which conversation happens to have been touched last.
 */

/** Flags that mean "carry on the most recent conversation", with no id. */
const CONTINUE_FLAGS = new Set(['--continue', '-c']);
/** Flags that take a conversation id, or open a picker when given none. */
const RESUME_FLAGS = new Set(['--resume', '-r']);
const SESSION_ID_FLAG = '--session-id';
/**
 * Resume into a COPY of the conversation instead of continuing it.
 *
 * It means something only on the launch that makes the copy. Carried into a
 * relaunch it copies again, so every swap left another duplicate of the thread
 * behind, and a swap that did not know the copy's id copied the ORIGINAL again,
 * dropping everything done since.
 */
const FORK_FLAG = '--fork-session';

/** Claude requires a real UUID here and rejects anything else. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeConversationId(value: string | undefined): boolean {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * A long option and the value written inside it, if any.
 *
 * Claude reads `--resume=<id>` exactly as it reads `--resume <id>` (Claude
 * Desktop launches it in the first form). Comparing whole arguments missed that
 * spelling entirely, so ccx treated `--resume=<id>` as a fresh start and added
 * `--session-id`, which Claude refuses to combine with a resume.
 */
function splitOption(arg: string): { flag: string; inline?: string } {
  if (!arg.startsWith('--')) return { flag: arg };
  const eq = arg.indexOf('=');
  return eq === -1 ? { flag: arg } : { flag: arg.slice(0, eq), inline: arg.slice(eq + 1) };
}

/** Whether `args` already asks for some existing conversation. */
export function wantsExistingConversation(args: string[]): boolean {
  return args.some((a) => {
    const { flag } = splitOption(a);
    return CONTINUE_FLAGS.has(flag) || RESUME_FLAGS.has(flag);
  });
}

/** Whether `args` resume into a copy rather than the conversation itself. */
export function forksConversation(args: string[]): boolean {
  return args.some((a) => splitOption(a).flag === FORK_FLAG);
}

/**
 * Whether a launch with `args` picks an existing conversation back up by
 * itself: `--continue`, or a resume that names one.
 *
 * A bare `--resume` opens the picker instead, and a prompt added after it would
 * be read as the picker's search term, so that does not count.
 */
export function startsByResuming(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const { flag, inline } = splitOption(args[i] as string);
    if (CONTINUE_FLAGS.has(flag)) return true;
    if (!RESUME_FLAGS.has(flag)) continue;
    if (inline !== undefined ? inline !== '' : isOperand(args[i + 1])) return true;
  }
  return false;
}

/**
 * The value given to `wanted`: written inside it, the operand after it, '' when
 * the flag is there with no value, or undefined when it is not there at all.
 */
function valueOf(args: string[], wanted: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const { flag, inline } = splitOption(args[i] as string);
    if (flag !== wanted) continue;
    if (inline !== undefined) return inline;
    const next = args[i + 1];
    return isOperand(next) ? (next as string) : '';
  }
  return undefined;
}

/**
 * The conversation id `args` names, if it names one.
 *
 * `--resume` with nothing after it opens a picker, so there is no id to find;
 * that reads as null rather than as the next argument, which would otherwise
 * swallow an unrelated flag and hand Claude a nonsense id.
 */
export function conversationIdIn(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const { flag, inline } = splitOption(args[i] as string);
    if (!RESUME_FLAGS.has(flag) && flag !== SESSION_ID_FLAG) continue;
    // A value written inside the flag is the whole of it; the next argument
    // then belongs to something else.
    const value = inline ?? args[i + 1];
    if (looksLikeConversationId(value)) return value as string;
  }
  return null;
}

/** Anything that is a value rather than another flag. */
function isOperand(value: string | undefined): boolean {
  return typeof value === 'string' && !value.startsWith('-');
}

/**
 * Strip every conversation flag, including whatever value it carries, and the
 * fork flag, which only ever applies to the launch that made the copy.
 */
export function withoutConversationFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const { flag, inline } = splitOption(arg);
    if (CONTINUE_FLAGS.has(flag) || flag === FORK_FLAG) continue;
    if (RESUME_FLAGS.has(flag) || flag === SESSION_ID_FLAG) {
      // Take the value with the flag, whatever shape it is. `--resume` accepts
      // a session name or a search term as well as an id, and leaving one of
      // those behind turns it into a stray positional argument to Claude.
      // A BARE `--resume` (a picker) carries nothing, and eating the next
      // argument there would remove a flag the operator meant to pass. Neither
      // does `--resume=<id>`, whose value is already inside it.
      if (inline === undefined && isOperand(args[i + 1])) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

export interface ConversationPlan {
  /** The command line for this run's FIRST launch. */
  args: string[];
  /**
   * The conversation this run owns, when it can be known before starting.
   *
   * Null when the operator asked for a conversation only Claude can identify
   * (`--continue`, or `--resume` with the picker). The id is learned from the
   * running session in that case: Claude's own record of which conversation
   * the process is in (see session/live-conversation).
   */
  id: string | null;
}

/**
 * Decide which conversation this run is in, before anything starts.
 *
 * A fresh start is given an id of our own so later swaps have something exact
 * to resume. Anything the operator asked for is left exactly as typed: they may
 * be resuming a specific conversation, and rewriting that would be ccx deciding
 * which thread they are in.
 *
 * A fork is the one exception, and only by addition. The id after `--resume`
 * then names where the copy came FROM, not the thread this run is in, so it is
 * not this run's conversation. Claude accepts `--session-id` alongside
 * `--fork-session` to name the copy, so the copy is named here unless the
 * operator already named it.
 */
export function planConversation(args: string[], newId: () => string = randomUUID): ConversationPlan {
  if (forksConversation(args) && wantsExistingConversation(args)) {
    const own = valueOf(args, SESSION_ID_FLAG);
    if (own !== undefined) return { args, id: looksLikeConversationId(own) ? own : null };
    const id = newId();
    return { args: [...args, SESSION_ID_FLAG, id], id };
  }
  const named = conversationIdIn(args);
  if (named) return { args, id: named };
  if (wantsExistingConversation(args)) return { args, id: null };
  const id = newId();
  return { args: [...args, SESSION_ID_FLAG, id], id };
}

/**
 * The command line for picking the conversation back up after a swap.
 *
 * With an id, this run resumes exactly its own thread. Without one, it falls
 * back to "the most recent in this directory", which is the best available
 * answer when nothing has told us which conversation this is.
 */
export function relaunchArgs(args: string[], id: string | null): string[] {
  const bare = withoutConversationFlags(args);
  return id ? [...bare, '--resume', id] : [...bare, '--continue'];
}

export type ResumePromptPlacement =
  | { applied: true; args: string[] }
  | { applied: false; args: string[]; reason: string };

/**
 * Claude's options that take a value, as `claude --help` lists them. Those
 * shown as `<value>` or `[value]` take the next operand; those shown as
 * `<values...>` take every operand up to the next flag.
 *
 * Every other option takes nothing, so an operand after it is the prompt:
 * `--dangerously-skip-permissions "fix the flaky test"` has one. An option Claude
 * adds later that does take a value is read the same way, which errs toward "this
 * run has a prompt of its own", and the armed prompt then stands aside instead of
 * becoming a second prompt.
 */
const ONE_VALUE_FLAGS = new Set([
  '--agent',
  '--agents',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--autocompact',
  '--cloud',
  '-d',
  '--debug',
  '--debug-file',
  '--effort',
  '--environment',
  '--fallback-model',
  '--from-pr',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--max-turns',
  '--model',
  '-n',
  '--name',
  '--output-format',
  '--permission-mode',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--plugin-dir',
  '--plugin-url',
  '--prompt-suggestions',
  '--remote-control',
  '--remote-control-session-name-prefix',
  '-r',
  '--resume',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--system-prompt',
  '--system-prompt-file',
  '--system-prompt-snapshot',
  '--teleport',
  '-w',
  '--worktree',
]);
const MANY_VALUE_FLAGS = new Set([
  '--add-dir',
  '--allowedTools',
  '--allowed-tools',
  '--betas',
  '--disallowedTools',
  '--disallowed-tools',
  '--file',
  '--mcp-config',
  '--tools',
]);

/** Whether `args` carry a prompt: an operand that is not some option's value. */
export function hasOwnPrompt(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    // Everything after `--` is an operand, even text that starts with a dash.
    if (arg === '--') return i + 1 < args.length;
    if (isOperand(arg)) return true;
    // `--model=opus` carries its value inside itself.
    if (arg.includes('=')) continue;
    if (ONE_VALUE_FLAGS.has(arg)) {
      if (isOperand(args[i + 1])) i += 1;
    } else if (MANY_VALUE_FLAGS.has(arg)) {
      while (isOperand(args[i + 1])) i += 1;
    }
  }
  return false;
}

/**
 * Hand a relaunch the prompt its session armed for coming back.
 *
 * Claude takes one prompt: `claude [options] [prompt]`, and a resumed
 * conversation given one submits it at once. That is what lets an unattended
 * session carry on by itself after a swap instead of sitting idle.
 *
 * A run that was LAUNCHED with a prompt of its own already has its one prompt,
 * and it rides every relaunch with the other arguments. A second would at best
 * be ignored and at worst stop Claude starting, so the armed prompt stands aside
 * and says why. An operand counts as that prompt unless it is the value of an
 * option known to take one (see hasOwnPrompt), so `--model opus` and the id
 * after `--resume` are never mistaken for a prompt, and the task after
 * `--dangerously-skip-permissions` always is.
 */
export function withResumePrompt(relaunch: string[], prompt: string): ResumePromptPlacement {
  if (hasOwnPrompt(relaunch)) {
    return {
      applied: false,
      args: relaunch,
      reason: 'this run was launched with a prompt of its own, and Claude takes only one',
    };
  }
  return { applied: true, args: [...relaunch, promptOperand(prompt)] };
}

/**
 * A prompt as Claude's operand, read as nothing else.
 *
 * Claude reads an operand that starts with "-" as an option and refuses to
 * start, and one that is a single word naming a subcommand ("mcp", "update")
 * as that subcommand, even after "--" (measured against 2.1.284). A leading
 * space defeats both, and the model never notices it. Anything else is passed
 * exactly as written, so a prompt like "/compact" still runs as a command.
 */
export function promptOperand(prompt: string): string {
  return /^-/.test(prompt) || /^[A-Za-z][\w-]*$/.test(prompt) ? ` ${prompt}` : prompt;
}

/**
 * Start a genuinely NEW conversation, and name it.
 *
 * Used when a resume finds nothing to resume. Naming the new one matters as
 * much as starting it: the id the run was carrying is now known to lead
 * nowhere, so without a replacement every later swap would try that same dead
 * id, fail, and start fresh again, losing the conversation each time.
 */
export function freshStartArgs(
  args: string[],
  newId: () => string = randomUUID,
): { args: string[]; id: string } {
  // Always an id, never null: a fresh start is the one case where we are the
  // ones creating the conversation, so there is nothing to be unsure about.
  const id = newId();
  return { args: [...withoutConversationFlags(args), SESSION_ID_FLAG, id], id };
}
