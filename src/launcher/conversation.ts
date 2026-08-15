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
 * (creating a new one needs `--fork-session`, which is not passed). Nothing
 * then depends on which conversation happens to have been touched last.
 */

/** Flags that mean "carry on the most recent conversation", with no id. */
const CONTINUE_FLAGS = new Set(['--continue', '-c']);
/** Flags that take a conversation id, or open a picker when given none. */
const RESUME_FLAGS = new Set(['--resume', '-r']);
const SESSION_ID_FLAG = '--session-id';

/** Claude requires a real UUID here and rejects anything else. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeConversationId(value: string | undefined): boolean {
  return typeof value === 'string' && UUID.test(value);
}

/** Whether `args` already asks for some existing conversation. */
export function wantsExistingConversation(args: string[]): boolean {
  return args.some((a) => CONTINUE_FLAGS.has(a) || RESUME_FLAGS.has(a));
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
    const flag = args[i] as string;
    if (!RESUME_FLAGS.has(flag) && flag !== SESSION_ID_FLAG) continue;
    const value = args[i + 1];
    if (looksLikeConversationId(value)) return value as string;
  }
  return null;
}

/** Anything that is a value rather than another flag. */
function isOperand(value: string | undefined): boolean {
  return typeof value === 'string' && !value.startsWith('-');
}

/** Strip every conversation flag, including whatever value it carries. */
export function withoutConversationFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as string;
    if (CONTINUE_FLAGS.has(flag)) continue;
    if (RESUME_FLAGS.has(flag) || flag === SESSION_ID_FLAG) {
      // Take the value with the flag, whatever shape it is. `--resume` accepts
      // a session name or a search term as well as an id, and leaving one of
      // those behind turns it into a stray positional argument to Claude.
      // A BARE `--resume` (a picker) carries nothing, and eating the next
      // argument there would remove a flag the operator meant to pass.
      if (isOperand(args[i + 1])) i += 1;
      continue;
    }
    out.push(flag);
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
   * running session in that case; see `readKnownConversation`.
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
 */
export function planConversation(args: string[], newId: () => string = randomUUID): ConversationPlan {
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
