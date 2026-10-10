import { purgeRefusal, type RemovalStanding } from '../accounts/removal.js';
import { openPrompt, rejectPrompt, type PromptState } from './prompt.js';
import { numberSessions } from './session-choice.js';

/**
 * Removing an account from the dashboard (x).
 *
 * The removing is `ccx remove`'s; this is only the asking. It is a typed box
 * rather than the yes/no question the other keys use, for three reasons: that
 * question takes Enter as yes, and Enter is the key pressed most on this
 * screen; it is drawn on one line, and what removal touches does not fit on
 * one; and deleting a login should take the name of the account it belongs
 * to, so a cursor on the wrong row cannot do it.
 *
 * Nothing is removed by default: enter alone or esc closes the box. `y` keeps
 * the folder and the login in it, so the account can be added back. Deleting
 * them takes `purge <name>`, and is not offered while the folder is in use.
 *
 * Pure, so the wording and the reading of an answer are tested without a
 * terminal.
 */

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** What its running sessions do once it is gone, or null when there are none. */
function sessionsFact(standing: RemovalStanding): string | null {
  const running = numberSessions(standing.leases);
  if (running.length === 0) return null;
  const one = running.length === 1;
  const where = running.map((s) => s.where).join(', ');
  const who = `${running.length} ${one ? 'session is' : 'sessions are'} on it (${where})`;
  // A session keeps its own copy of the login, so it runs on until something
  // moves it, and then picks from the accounts that are left.
  if (standing.last) {
    return one
      ? `${who}: it keeps going until its next limit or restart, then ends.`
      : `${who}: they keep going until their next limit or restart, then end.`;
  }
  return one
    ? `${who}: it keeps going until it next moves, then uses another account.`
    : `${who}: they keep going until they next move, then use another account.`;
}

/** The question x asks: what removing the account touches, then the answers it takes. */
export function removeQuestion(standing: RemovalStanding): string {
  const { name } = standing;
  const keep = 'Type y to remove it from ccx and keep its folder and login';
  const refusal = purgeRefusal(standing);
  const answers = refusal
    ? `${keep}. ${capital(refusal)}.`
    : standing.folderIsOurs
      ? `${keep}, or purge ${name} to delete its folder too: its login is deleted, and it must be signed in again to come back.`
      : `${keep}, or purge ${name} to delete its login too: it must be signed in again to come back. Its folder is outside the profiles folder and is left.`;
  return [
    `remove "${name}"?`,
    standing.last
      ? 'It is your only account: ccx cannot start claude until you add one.'
      : standing.active
        ? 'New sessions start on it: they will start on the next pick instead.'
        : null,
    sessionsFact(standing),
    standing.editor ? 'Your editor is on it, and stays on it until the next switch.' : null,
    answers,
  ]
    .filter((part) => part !== null)
    .join(' ');
}

export type RemovalAnswer =
  | { kind: 'leave' }
  | { kind: 'remove'; purge: boolean }
  /** Not an answer, or one that cannot be done now: said, and nothing removed. */
  | { kind: 'refuse'; error: string };

/** What a typed answer to the question means. Anything it does not recognise removes nothing. */
export function readRemovalAnswer(answer: string, standing: RemovalStanding): RemovalAnswer {
  const words = answer.trim().split(/\s+/);
  const first = (words[0] ?? '').toLowerCase();
  if (words.length === 1 && (first === '' || first === 'n' || first === 'no'))
    return { kind: 'leave' };
  if (words.length === 1 && (first === 'y' || first === 'yes'))
    return { kind: 'remove', purge: false };
  if (first === 'purge') {
    const refusal = purgeRefusal(standing);
    if (refusal) return { kind: 'refuse', error: `${refusal}; y removes it and keeps its folder` };
    // The name exactly, so the account deleted is the one the question names.
    if (words.length === 2 && words[1] === standing.name) return { kind: 'remove', purge: true };
    return { kind: 'refuse', error: `to delete its folder too, type: purge ${standing.name}` };
  }
  return { kind: 'refuse', error: `type y to remove "${standing.name}", or esc to leave it` };
}

/** The box x opens. */
export function openRemoval(standing: RemovalStanding): PromptState {
  return openPrompt('remove', removeQuestion(standing));
}

/** Said when the account was removed somewhere else while this screen showed it. */
export function goneNotice(name: string): string {
  return `"${name}" is no longer an account`;
}

export interface RemovalDeps {
  /** What removing it would touch now; null once it is gone. */
  standing: () => RemovalStanding | null;
  /** Remove it, through `ccx remove`: whether it did, and what it said. */
  remove: (purge: boolean) => { ok: boolean; text: string };
}

/**
 * Enter in the box: the box to go on showing (null closes it) and what to say.
 *
 * The standing is read again here, because the box can sit open while a
 * session starts on the account or the editor moves onto it. When that changes
 * the question, the answer was to a question no longer true, so it is asked
 * again rather than acted on.
 */
export function submitRemoval(
  box: PromptState,
  name: string,
  deps: RemovalDeps,
): { box: PromptState | null; notice?: string } {
  const standing = deps.standing();
  if (!standing) return { box: null, notice: goneNotice(name) };
  const answer = readRemovalAnswer(box.text, standing);
  if (answer.kind === 'leave') return { box: null };
  const question = removeQuestion(standing);
  if (question !== box.label) {
    return {
      box: {
        ...rejectPrompt(box, 'this changed while you were answering; read it again'),
        label: question,
        text: '',
      },
    };
  }
  if (answer.kind === 'refuse') return { box: rejectPrompt(box, answer.error) };
  const done = deps.remove(answer.purge);
  return done.ok ? { box: null, notice: done.text } : { box: rejectPrompt(box, done.text) };
}
