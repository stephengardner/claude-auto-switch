import { describe, it, expect } from 'vitest';
import { arrange, inDisplayOrder, keepSelection } from './arrange.js';
import type { DashboardAccount } from './render.js';

const NOW = 1_000_000_000;
const HOUR = 3600_000;

function account(over: Partial<DashboardAccount> = {}): DashboardAccount {
  return { name: 'work', loggedIn: true, active: false, enabled: true, priority: 0, ...over };
}

const pick = (rank: number): NonNullable<DashboardAccount['pick']> => ({ rank, runway: 1, binding: 'none' });
const weekSpentFor = (hours: number): DashboardAccount['usage'] => ({
  fiveHour: 0,
  sevenDay: 1,
  sevenDayReset: NOW + hours * HOUR,
});

describe('the order the dashboard draws accounts in', () => {
  it('puts usable accounts first, in pick order, whatever order they were added in', () => {
    // The pick order used to be a column to hunt through. Now it is the order
    // of the rows, so the next account is the first line.
    const names = inDisplayOrder(
      [
        account({ name: 'added-first', pick: pick(3) }),
        account({ name: 'added-second', pick: pick(1) }),
        account({ name: 'added-third', pick: pick(2) }),
      ],
      null,
      NOW,
    ).map((a) => a.name);
    expect(names).toEqual(['added-second', 'added-third', 'added-first']);
  });

  it('keeps an account that is out of room below every usable one, soonest back first', () => {
    const placed = arrange(
      [
        account({ name: 'back-last', usage: weekSpentFor(100) }),
        account({ name: 'usable', pick: pick(1) }),
        account({ name: 'back-first', usage: weekSpentFor(5) }),
      ],
      null,
      NOW,
    );
    expect(placed.map((p) => [p.account.name, p.block])).toEqual([
      ['usable', 'usable'],
      ['back-first', 'out'],
      ['back-last', 'out'],
    ]);
  });

  it('puts an account with no known return after the ones that have one', () => {
    const names = inDisplayOrder(
      [
        account({ name: 'unknown', usage: { fiveHour: 0, sevenDay: 1 } }),
        account({ name: 'known', usage: weekSpentFor(50) }),
      ],
      null,
      NOW,
    ).map((a) => a.name);
    expect(names).toEqual(['known', 'unknown']);
  });

  it('keeps an account rotation still ranks among the usable ones, even with the preferred model spent on it', () => {
    // Fable is spent here, so the shared status calls it blocked for Fable. But
    // rotation ranks it, because it can still run the next model in the chain,
    // and the line under the table may name it. Listing it as out of room
    // would have the screen contradict itself.
    const placed = arrange(
      [
        account({
          name: 'fable-out',
          pick: pick(1),
          usage: {
            fiveHour: 0,
            sevenDay: 0.1,
            models: [{ name: 'Fable', utilization: 1, resetsAt: NOW + 40 * HOUR }],
          },
        }),
      ],
      'fable',
      NOW,
    );
    expect(placed[0]?.status.state).toBe('blocked');
    expect(placed[0]?.block).toBe('usable');
  });

  it('lists a ranked account as out of room when one of its own windows is spent', () => {
    // With models switched off, rotation numbers every signed-in account it
    // was not refused by, a spent one included. Its row shows an empty bar,
    // and an empty bar among the usable accounts is what this layout ends.
    for (const usage of [
      { fiveHour: 1, sevenDay: 0.2, fiveHourReset: NOW + 3 * HOUR },
      { fiveHour: 0, sevenDay: 1, sevenDayReset: NOW + 30 * HOUR },
    ]) {
      const placed = arrange(
        [account({ name: 'spent', pick: pick(1), usage }), account({ name: 'fine', pick: pick(2) })],
        null,
        NOW,
      );
      expect(placed.map((p) => [p.account.name, p.block])).toEqual([
        ['fine', 'usable'],
        ['spent', 'out'],
      ]);
    }
  });

  it("keeps a ranked account usable when all that is against it is ccx's record of a refusal", () => {
    // ccx records a limit on one model against the account, and the shared
    // status reads any record as the account being capped. Rotation does not:
    // it ranks the account, for the models it can still run. No window on the
    // row is spent, so the row belongs with the ones rotation would use.
    const placed = arrange(
      [
        account({
          name: 'one-model-refused',
          pick: pick(1),
          cappedUntil: NOW + 40 * HOUR,
          usage: { fiveHour: 0.1, sevenDay: 0.3 },
        }),
      ],
      'opus',
      NOW,
    );
    expect(placed[0]?.status.label).toBe('capped');
    expect(placed[0]?.block).toBe('usable');
  });

  it('lists an account nothing is stopping as usable even when it has no place in the pick order', () => {
    const placed = arrange([account({ name: 'unranked' }), account({ name: 'ranked', pick: pick(1) })], null, NOW);
    expect(placed.map((p) => [p.account.name, p.block])).toEqual([
      ['ranked', 'usable'],
      ['unranked', 'usable'],
    ]);
  });

  it('puts signed-out and disabled accounts last, the signed-out ones first', () => {
    // Neither is out of room, so neither belongs under that heading. Signed
    // out comes first because it is the one a key press fixes.
    const placed = arrange(
      [
        account({ name: 'off', enabled: false }),
        account({ name: 'signed-out', loggedIn: false }),
        account({ name: 'spent', usage: weekSpentFor(5) }),
        account({ name: 'fine', pick: pick(1) }),
      ],
      null,
      NOW,
    );
    expect(placed.map((p) => [p.account.name, p.block])).toEqual([
      ['fine', 'usable'],
      ['spent', 'out'],
      ['signed-out', 'off'],
      ['off', 'off'],
    ]);
  });

  it('gives the same order when its own answer is arranged again', () => {
    // The live loop arranges the rows so its cursor counts what is on screen,
    // and the renderer arranges what it is handed. A second pass that moved
    // anything would put the cursor on a different account from the one drawn.
    const accounts = [
      account({ name: 'c', usage: weekSpentFor(9) }),
      account({ name: 'a' }),
      account({ name: 'e', enabled: false }),
      account({ name: 'b', pick: pick(2) }),
      account({ name: 'f', usage: weekSpentFor(9) }),
      account({ name: 'd', pick: pick(1) }),
      account({ name: 'g', loggedIn: false }),
      account({ name: 'h' }),
    ];
    const once = inDisplayOrder(accounts, null, NOW);
    const twice = inDisplayOrder(once, null, NOW);
    expect(twice.map((a) => a.name)).toEqual(once.map((a) => a.name));
    expect(once.map((a) => a.name)).toEqual(['d', 'b', 'a', 'h', 'c', 'f', 'g', 'e']);
  });
});

describe('the cursor when the rows reorder under it', () => {
  const rows = (...names: string[]) => names.map((name) => ({ name }));

  it('stays on its account', () => {
    // The rows follow the pick order, which moves as usage is read. Enter must
    // act on the account that was highlighted, not on whichever one slid into
    // its row since the last frame.
    expect(keepSelection(rows('b', 'a', 'c'), 'a', 0)).toBe(1);
  });

  it('keeps its row when that account is gone', () => {
    expect(keepSelection(rows('b', 'c'), 'a', 1)).toBe(1);
  });

  it('keeps its row when nothing was highlighted', () => {
    expect(keepSelection(rows('b', 'c'), undefined, 1)).toBe(1);
  });
});
