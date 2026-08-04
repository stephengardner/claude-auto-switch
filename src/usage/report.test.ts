import { describe, it, expect } from 'vitest';
import {
  renderUsageReport,
  bar,
  percent,
  humanWait,
  bindingWindow,
  accountWideBinding,
  roomiest,
  type UsageAccount,
} from './report.js';

const NOW = 1_000_000;
const inMinutes = (n: number) => NOW + n * 60_000;
const plain = { color: false, width: 100 };

function account(over: Partial<UsageAccount> = {}): UsageAccount {
  return {
    name: 'work',
    email: 'work@example.com',
    plan: 'max',
    active: false,
    windows: [
      { label: '5-hour', used: 0.27, resetsAt: inMinutes(117) },
      { label: 'weekly', used: 0.2, resetsAt: inMinutes(60 * 24 * 5) },
      { label: 'Fable', used: 0.05, resetsAt: inMinutes(60 * 24 * 5), modelOnly: true },
    ],
    ...over,
  };
}

describe('bar', () => {
  it('fills in proportion to what is used', () => {
    expect(bar(0, 10)).toBe('░'.repeat(10));
    expect(bar(1, 10)).toBe('█'.repeat(10));
    expect(bar(0.5, 10)).toBe('█'.repeat(5) + '░'.repeat(5));
  });

  it('shows a sliver rather than rounding it away to empty', () => {
    // 1% of a week is real usage. An empty bar would say there is none.
    expect(bar(0.01, 10)).toBe('█' + '░'.repeat(9));
  });

  it('keeps a full bar for spent only, so 99% does not look finished', () => {
    expect(bar(0.999, 10)).toBe('█'.repeat(9) + '░');
  });

  it('draws nothing readable as a dash, never as empty', () => {
    expect(bar(null, 5)).toBe('-----');
  });
});

describe('humanWait', () => {
  it('uses minutes, then hours, then days', () => {
    expect(humanWait(inMinutes(45), NOW)).toBe('45m');
    expect(humanWait(inMinutes(117), NOW)).toBe('1h 57m');
    expect(humanWait(inMinutes(60 * 24 * 5), NOW)).toBe('5d');
    expect(humanWait(inMinutes(60 * 26), NOW)).toBe('1d 2h');
  });

  it('says nothing about a window that is already back', () => {
    expect(humanWait(NOW - 1, NOW)).toBe('');
    expect(humanWait(null, NOW)).toBe('');
  });
});

describe('percent', () => {
  it('marks the unknown as unknown rather than as zero', () => {
    expect(percent(null).trim()).toBe('?');
    expect(percent(0).trim()).toBe('0%');
  });
});

describe('which window binds', () => {
  const windows = [
    { label: '5-hour', used: 0.1, resetsAt: null },
    { label: 'weekly', used: 0.68, resetsAt: null },
    { label: 'Fable', used: 1, resetsAt: null, modelOnly: true },
  ];

  it('is the one closest to its limit, models included', () => {
    expect(bindingWindow(windows, NOW)?.label).toBe('Fable');
  });

  it('ignores model windows when asking whether the ACCOUNT can work', () => {
    // A spent model stops that model, not the account.
    expect(accountWideBinding(windows, NOW)?.label).toBe('weekly');
  });

  it('SKIPS a window whose reset has already passed', () => {
    // It records a limit that has lifted, so it cannot be the thing that stops
    // you, and naming it would send you off a usable account.
    const expired = [
      { label: '5-hour', used: 0.1, resetsAt: null },
      { label: 'Fable', used: 1, resetsAt: NOW - 1_000, modelOnly: true },
    ];
    expect(bindingWindow(expired, NOW)?.label).toBe('5-hour');
  });

  it('stops calling an account spent once its only window has reset', () => {
    const lifted = [{ label: 'weekly', used: 1, resetsAt: NOW - 1 }];
    // The recorded 100% described a window that is over, so it is no longer the
    // thing that stops you. With nothing else measured, the honest answer is
    // that nothing is known, NOT that the account is full.
    expect(bindingWindow(lifted, NOW)).toBeNull();
  });

  it('does not SUGGEST an account whose windows have all expired', () => {
    // Deliberate asymmetry, so it does not read as an oversight. Ignoring an
    // expired window means we no longer know this account's usage, and
    // `roomiest` answers "where should I go right now", where recommending an
    // account on no evidence is a gamble. It is excluded for the same reason an
    // unread account is. Model preference makes the opposite call, treating
    // unmeasured as worth TRYING, because there the cost of being wrong is one
    // attempt rather than a recommendation.
    const lifted = account({
      name: 'lifted',
      windows: [{ label: 'weekly', used: 1, resetsAt: NOW - 1 }],
    });
    expect(roomiest([lifted], NOW)).toEqual([]);
  });

  it('is nothing when no window has been read', () => {
    expect(bindingWindow([{ label: '5-hour', used: null, resetsAt: null }], NOW)).toBeNull();
  });
});

describe('roomiest', () => {
  it('ranks by the tightest account-wide window', () => {
    const busy = account({ name: 'busy', windows: [{ label: 'weekly', used: 0.8, resetsAt: null }] });
    const free = account({ name: 'free', windows: [{ label: 'weekly', used: 0.1, resetsAt: null }] });
    expect(roomiest([busy, free], NOW).map((a) => a.name)).toEqual(['free', 'busy']);
  });

  it('STILL SUGGESTS an account that is only out of one model', () => {
    // The common case. Excluding it sends you away from an account you could
    // work on by switching model.
    const modelOut = account({
      name: 'model-out',
      windows: [
        { label: 'weekly', used: 0.68, resetsAt: null },
        { label: 'Fable', used: 1, resetsAt: null, modelOnly: true },
      ],
    });
    expect(roomiest([modelOut], NOW).map((a) => a.name)).toEqual(['model-out']);
  });

  it('does not suggest an account whose account-wide window is spent', () => {
    const spent = account({ name: 'spent', windows: [{ label: 'weekly', used: 1, resetsAt: null }] });
    expect(roomiest([spent], NOW)).toEqual([]);
  });

  it('does not suggest an account nothing has been read for', () => {
    expect(roomiest([account({ name: 'unknown', windows: null })], NOW)).toEqual([]);
  });
});

describe('renderUsageReport', () => {
  it('shows every window with its own bar, percentage and reset', () => {
    const out = renderUsageReport([account()], NOW, plain);
    expect(out).toContain('5-hour');
    expect(out).toContain('weekly');
    expect(out).toContain('Fable');
    expect(out).toContain('27%');
    expect(out).toContain('back in 1h 57m');
    expect(out).toContain('work@example.com');
    expect(out).toContain('max');
  });

  it('marks the active account', () => {
    expect(renderUsageReport([account({ active: true })], NOW, plain)).toContain('ACTIVE');
  });

  it('says a spent MODEL leaves the account usable', () => {
    const out = renderUsageReport(
      [
        account({
          windows: [
            { label: 'weekly', used: 0.68, resetsAt: null },
            { label: 'Fable', used: 1, resetsAt: inMinutes(120), modelOnly: true },
          ],
        }),
      ],
      NOW,
      plain,
    );
    expect(out).toContain('SPENT');
    expect(out).toContain('other models still work');
    expect(out).not.toContain('cannot work until it resets');
  });

  it('says a spent ACCOUNT-WIDE window stops the account', () => {
    const out = renderUsageReport(
      [account({ windows: [{ label: 'weekly', used: 1, resetsAt: inMinutes(60) }] })],
      NOW,
      plain,
    );
    expect(out).toContain('cannot work until it resets');
  });

  it('names where there is most room', () => {
    const busy = account({ name: 'busy', windows: [{ label: 'weekly', used: 0.9, resetsAt: null }] });
    const free = account({ name: 'free', windows: [{ label: 'weekly', used: 0.1, resetsAt: null }] });
    const out = renderUsageReport([busy, free], NOW, plain);
    expect(out).toContain('Most room right now: free');
  });

  it('says so when nothing has room, instead of suggesting something unusable', () => {
    const out = renderUsageReport(
      [account({ windows: [{ label: 'weekly', used: 1, resetsAt: null }] })],
      NOW,
      plain,
    );
    expect(out).toContain('Every account has hit an account-wide limit');
  });

  it('does not confuse "never read" with "everything is at its limit"', () => {
    const out = renderUsageReport([account({ windows: null })], NOW, plain);
    expect(out).toContain('No usage has been read yet');
    expect(out).not.toContain('hit an account-wide limit');
  });

  it('reports an unread account honestly rather than as empty usage', () => {
    const out = renderUsageReport([account({ windows: null })], NOW, plain);
    expect(out).toContain('no usage read yet');
    expect(out).not.toContain('0%');
  });

  it('keeps the bars inside a narrow terminal', () => {
    const out = renderUsageReport([account()], NOW, { color: false, width: 60 });
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
  });
});
