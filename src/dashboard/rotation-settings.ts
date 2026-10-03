import { hasRoomFor, normalizeModel, type AccountModelUsage } from '../usage/model-preference.js';
import { humanWait } from '../usage/report.js';
import { pickScore, standingOf, type RunwayWindows, type Standing } from '../usage/runway.js';
import { remainingRoom, usableCapacity, type CapacityWindows } from '../usage/usable-capacity.js';
import { orderComparator, type AccountOrder, type SelectableAccount } from '../selector/selector.js';

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

/**
 * The next model preference after `current`, or null when `current` is not one
 * of the choices (a chain set with `ccx models`): the dashboard does not
 * replace a chain it cannot give back. The user's own spelling of each model
 * is kept (`claude-opus-5[1m]` stays that, rather than becoming `opus`).
 */
export function nextModelPreference(current: readonly string[]): [string, ...string[]] | null {
  const key = current.map(normalizeModel).join(',');
  const at = MODEL_CHOICES.findIndex((c) => c.join(',') === key);
  if (at < 0) return null;
  const spelled = new Map(current.map((m) => [normalizeModel(m), m]));
  const [first, ...rest] = (MODEL_CHOICES[(at + 1) % MODEL_CHOICES.length] ?? ['opus']).map(
    (m) => spelled.get(m) ?? m,
  );
  return [first ?? 'opus', ...rest];
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

/**
 * Accounts in the order rotation would pick them, by the same comparator and
 * score rotation uses, from the whole usage entry (its learned window cost
 * included, or the dashboard would rank differently from what happens).
 */
export function rankAccounts<T extends SelectableAccount>(
  accounts: readonly T[],
  usageOf: (name: string) => (RunwayWindows & CapacityWindows) | undefined,
  order: AccountOrder,
  model: string | null,
  now: number,
): T[] {
  return [...accounts].sort(
    orderComparator(order, (name) =>
      order === 'smart' ? pickScore(standingOf(usageOf(name), now, model)) : remainingRoom(usageOf(name), now),
    ),
  );
}

/**
 * What an account can run, per model, as rotation's planner reads it: its
 * usage now (a window past its reset is free), with the ledger's model caps
 * laid over it. Both keyed the same way before they are merged: a cap can be
 * recorded as `claude-fable-5[1m]` while the usage calls the same window
 * `Fable`, and unmerged those are two keys, so the account would read as
 * having room on a model it is capped on.
 */
export function modelUsageFor(
  name: string,
  entry: CapacityWindows | undefined,
  knownSpent: ReadonlyArray<{ account: string; model: string }>,
  now: number,
): AccountModelUsage {
  const capacity = usableCapacity(entry, now);
  const byModel = (entries: Array<[string, number | null]>): Record<string, number | null> =>
    Object.fromEntries(entries.map(([model, used]) => [normalizeModel(model), used]));
  const fromLedger = byModel(knownSpent.filter((c) => c.account === name).map((c) => [c.model, 1]));
  return {
    name,
    models: { ...byModel(Object.entries(capacity.models)), ...fromLedger },
    ...(capacity.accountWideOut ? { accountWideOut: true } : {}),
  };
}

/** Whether an account can run some model of the chain: not out, and room on one. */
export function canRunChain(account: AccountModelUsage, preference: readonly string[]): boolean {
  return !account.accountWideOut && preference.some((m) => hasRoomFor(account, m));
}

/**
 * Number accounts in pick order (they come in that order), among the ones
 * rotation could actually move to: with a model in play, one with room on some
 * model in the chain, since the planner skips the rest. With models switched
 * off, every one, as the planner then takes the first.
 */
export function numberPicks(
  candidates: readonly AccountModelUsage[],
  preference: readonly string[],
  modelInPlay: boolean,
  standing: (name: string) => Standing,
): Map<string, { rank: number; runway: number; binding: Standing['binding'] }> {
  const picks = new Map<string, { rank: number; runway: number; binding: Standing['binding'] }>();
  let rank = 0;
  for (const c of candidates) {
    if (modelInPlay && !canRunChain(c, preference)) continue;
    const s = standing(c.name);
    rank += 1;
    picks.set(c.name, { rank, runway: s.runway, binding: s.binding });
  }
  return picks;
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
