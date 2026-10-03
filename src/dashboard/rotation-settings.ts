import { normalizeModel } from '../usage/model-preference.js';
import { humanWait } from '../usage/report.js';
import type { Standing } from '../usage/runway.js';
import type { AccountOrder } from '../selector/selector.js';

/**
 * The rotation settings the dashboard shows and changes: which model sessions
 * prefer, how the next account is picked, and the priority order. Pure, so the
 * cycling and reordering rules are testable without a terminal.
 */

/** The model preferences the dashboard cycles through, most wanted first. */
export const MODEL_CHOICES: ReadonlyArray<readonly [string, ...string[]]> = [
  ['opus', 'fable'],
  ['fable', 'opus'],
  ['opus'],
  ['fable'],
];

/** The pick rules the dashboard cycles through. */
export const ORDER_CHOICES: readonly AccountOrder[] = ['smart', 'most-room', 'priority'];

const title = (model: string): string => model.charAt(0).toUpperCase() + model.slice(1);

/** "Opus, then Fable", or "Opus only". */
export function modelPreferenceWords(preference: readonly string[]): string {
  const names = preference.map((m) => title(normalizeModel(m)));
  if (names.length === 1) return `${names[0]} only`;
  return names.join(', then ');
}

/** The next model preference after `current`; the first choice for one not in the list. */
export function nextModelPreference(current: readonly string[]): [string, ...string[]] {
  const key = current.map(normalizeModel).join(',');
  const at = MODEL_CHOICES.findIndex((c) => c.join(',') === key);
  const [first, ...rest] = MODEL_CHOICES[(at + 1) % MODEL_CHOICES.length] ?? ['opus'];
  return [first, ...rest];
}

/** The pick rule, in words. */
export function orderWords(order: AccountOrder): string {
  switch (order) {
    case 'smart':
      return 'smart (longest run, then expiring weekly budget)';
    case 'most-room':
      return 'most room';
    default:
      return 'your order';
  }
}

export function nextOrder(current: AccountOrder): AccountOrder {
  const at = ORDER_CHOICES.indexOf(current);
  return ORDER_CHOICES[(at + 1) % ORDER_CHOICES.length] ?? 'smart';
}

/** Why the smart order picks an account, in words. */
export function pickReason(standing: Standing, now: number): string {
  const room =
    standing.runway >= 0.995
      ? 'room for a full 5-hour window'
      : `room for ${Math.round(standing.runway * 100)}% of a 5-hour window`;
  const wait = humanWait(standing.weeklyResetAt, now);
  return wait ? `${room}, its week resets in ${wait}` : room;
}

/**
 * Move one account up (-1) or down (+1) the priority order, and the new
 * priority of every account whose number changes. Renumbered from 0, so ties
 * left by older versions (two accounts on one number) cannot make a move do
 * nothing. Empty when the move is off either end.
 */
export function reorder(
  accounts: ReadonlyArray<{ name: string; priority: number }>,
  name: string,
  direction: -1 | 1,
): Array<{ name: string; priority: number }> {
  const order = [...accounts].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  const at = order.findIndex((a) => a.name === name);
  const to = at + direction;
  if (at < 0 || to < 0 || to >= order.length) return [];
  const moved = [...order];
  const [account] = moved.splice(at, 1);
  if (!account) return [];
  moved.splice(to, 0, account);
  return moved
    .map((a, i) => ({ name: a.name, priority: i }))
    .filter((a) => accounts.find((b) => b.name === a.name)?.priority !== a.priority);
}
