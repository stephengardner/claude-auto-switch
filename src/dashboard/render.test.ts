import { describe, it, expect } from 'vitest';
import { renderDashboard, type DashboardSnapshot, type DashboardAccount } from './render.js';

const NOW = 1_000_000_000;

function account(over: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    name: 'work',
    email: 'w@x.com',
    plan: 'max',
    loggedIn: true,
    active: false,
    enabled: true,
    priority: 0,
    ...over,
  };
}

function snapshot(accounts: DashboardAccount[], events: string[] = []): DashboardSnapshot {
  return { accounts, events, now: NOW, refreshMs: 3000 };
}

describe('renderDashboard (plain)', () => {
  const opts = { color: false as const };

  it('shows the title, header, and each account', () => {
    const out = renderDashboard(snapshot([account({ name: 'work' }), account({ name: 'personal' })]), opts);
    expect(out).toContain('claude-auto-switch');
    expect(out).toContain('ACCOUNT');
    expect(out).toContain('work');
    expect(out).toContain('personal');
  });

  it('shows a priority column with the account priority', () => {
    const out = renderDashboard(snapshot([account({ name: 'work', priority: 2 })]), opts);
    expect(out).toContain('PRI');
    const workRow = out.split('\n').find((l) => l.includes('work'))!;
    expect(workRow).toMatch(/\b2\b/);
  });

  it('marks the active account and names it in the subtitle', () => {
    const out = renderDashboard(snapshot([account({ name: 'a', active: true }), account({ name: 'b' })]), opts);
    expect(out).toContain('active: a');
    expect(out).toMatch(/\*\s+a/);
  });

  it('renders each status: ready, logged out, capped, disabled', () => {
    const out = renderDashboard(
      snapshot([
        account({ name: 'ready1' }),
        account({ name: 'out1', loggedIn: false }),
        account({ name: 'cap1', cappedUntil: NOW + 30 * 60000 }),
        account({ name: 'off1', enabled: false }),
      ]),
      opts,
    );
    expect(out).toContain('ready');
    expect(out).toContain('logged out');
    expect(out).toContain('capped 30m');
    expect(out).toContain('disabled');
  });

  it('shows recent events (last 5) when present', () => {
    const out = renderDashboard(snapshot([account()], ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']), opts);
    expect(out).toContain('e6');
    expect(out).not.toContain('e1');
  });

  it('shows key hints only in interactive mode, no footer for a one-shot frame', () => {
    expect(renderDashboard(snapshot([account()]), opts)).not.toContain('rotate');
    expect(renderDashboard(snapshot([account()]), opts)).not.toContain('refreshing');
    const footer = renderDashboard(snapshot([account()]), { color: false, interactive: true });
    expect(footer).toContain('r rotate');
    expect(footer).toContain('enter use'); // the activate-selected hint
    expect(footer).not.toContain('pin'); // the old misleading label is gone
  });

  it('shows every window separately, not just the worst one', () => {
    const out = renderDashboard(
      snapshot([
        account({ name: 'hourly', usage: { fiveHour: 0.42, sevenDay: 0.09 } }),
        // Comfortable by the hour and the week, but one model's window is spent.
        // Both facts have to be visible: collapsing to the worst one hid the
        // healthy numbers, and averaging hid the number that actually stops you.
        account({
          name: 'modelout',
          usage: { fiveHour: 0, sevenDay: 0.62, models: [{ name: 'Fable', utilization: 1 }] },
        }),
        account({ name: 'nousage' }),
      ]),
      opts,
    );
    expect(out).toContain('5H');
    expect(out).toContain('WEEK');
    expect(out).toContain('MODEL');

    const hourly = out.split('\n').find((l) => l.includes('hourly'))!;
    expect(hourly).toContain('42%');
    expect(hourly).toContain('9%');

    const modelout = out.split('\n').find((l) => l.includes('modelout'))!;
    expect(modelout).toContain('0%'); // the hour, still fine
    expect(modelout).toContain('62%'); // the week, still fine
    expect(modelout).toContain('Fable 100%'); // and the one that stops you

    // Nothing read yet reads as a dash, never as zero: "0%" would claim the
    // account is completely free when the truth is that nobody has looked.
    const nousage = out.split('\n').find((l) => l.startsWith('  nousage') || / nousage /.test(l))!;
    expect(nousage).toContain('-');
    expect(nousage).not.toContain('%');
  });

  it('spells out the highlighted account, including when each window returns', () => {
    const now = 1_000_000;
    const out = renderDashboard(
      {
        ...snapshot([
          account({
            name: 'work',
            usage: {
              fiveHour: 0.5,
              sevenDay: 0.62,
              fiveHourReset: now + 90 * 60_000,
              sevenDayReset: now + 3 * 24 * 60 * 60_000,
              models: [{ name: 'Fable', utilization: 1, resetsAt: now + 2 * 24 * 60 * 60_000 }],
            },
          }),
        ]),
        now,
      },
      { ...opts, interactive: true, selected: 0 },
    );
    const detail = out.split('\n').find((l) => l.includes('work:'))!;
    expect(detail).toContain('5h 50%');
    expect(detail).toContain('week 62%');
    expect(detail).toContain('Fable 100%');
    expect(detail).toContain('back in'); // and when it comes back
  });

  it('reads a long wait in days, not in dozens of hours', () => {
    // A weekly window is days away, and "72h0m" is technically right and
    // useless to read at a glance.
    const now = 1_000_000;
    const out = renderDashboard(
      {
        ...snapshot([
          account({
            name: 'work',
            usage: {
              fiveHour: 0.1,
              sevenDay: 0.5,
              sevenDayReset: now + 3 * 24 * 60 * 60_000,
              fiveHourReset: now + 95 * 60_000,
            },
          }),
        ]),
        now,
      },
      { ...opts, interactive: true, selected: 0 },
    );
    const detail = out.split('\n').find((l) => l.includes('work:'))!;
    expect(detail).toContain('back in 3d');
    expect(detail).not.toContain('72h');
    expect(detail).toContain('1h 35m'); // hours keep their minutes
  });

  it('says so plainly when an account has never been read', () => {
    const out = renderDashboard(snapshot([account({ name: 'fresh' })]), {
      ...opts,
      interactive: true,
      selected: 0,
    });
    expect(out).toContain('no usage read yet');
  });

  it('marks the selected row with the cursor and the active row with a marker', () => {
    const out = renderDashboard(
      snapshot([account({ name: 'a', active: true }), account({ name: 'b' })]),
      { color: false, selected: 1 },
    );
    const lines = out.split('\n');
    const bRow = lines.find((l) => l.includes('b'))!;
    expect(bRow.trimStart().startsWith('▸')).toBe(true);
    const aRow = lines.find((l) => l.includes(' a '))!;
    expect(aRow.trimStart().startsWith('▸')).toBe(false); // a is active but not selected
  });
});

describe('renderDashboard (color)', () => {
  it('includes ANSI codes when color is on and none when off', () => {
    const withColor = renderDashboard(snapshot([account({ active: true })]), { color: true });
    const noColor = renderDashboard(snapshot([account({ active: true })]), { color: false });
    expect(withColor).toContain(String.fromCharCode(27));
    expect(noColor).not.toContain(String.fromCharCode(27));
  });
});
