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

describe('a window that has reset', () => {
  const opts = { color: false as const };

  it('does not keep the MODEL column pinned at the number it hit', () => {
    // The dashboard is the surface people actually look at. Showing Fable at
    // 100% for a window that reset hours ago is the same wrong answer the
    // report used to give, and it reads as "do not use this account".
    const out = renderDashboard(
      snapshot([
        account({
          name: 'lifted',
          usage: {
            fiveHour: 0,
            sevenDay: 0,
            models: [{ name: 'Fable', utilization: 1, resetsAt: NOW - 1 }],
          },
        }),
      ]),
      opts,
    );
    expect(out).toContain('FABLE'); // the column is named after the model
    expect(out).not.toContain('100%'); // and reads empty now the window reset
  });

  it('still shows a model window that is genuinely spent', () => {
    const out = renderDashboard(
      snapshot([
        account({
          name: 'spent',
          usage: {
            fiveHour: 0,
            sevenDay: 0,
            models: [{ name: 'Fable', utilization: 1, resetsAt: NOW + 60_000 }],
          },
        }),
      ]),
      opts,
    );
    expect(out).toContain('FABLE');
    expect(out).toContain('100%'); // still spent: the window has not reset
  });

  it('picks the worst model by CURRENT usage, not by the highest recorded', () => {
    // Fable recorded higher, but its window is over, so Opus is the one that
    // can still stop you.
    const out = renderDashboard(
      snapshot([
        account({
          name: 'mixed',
          usage: {
            fiveHour: 0,
            sevenDay: 0,
            models: [
              { name: 'Fable', utilization: 1, resetsAt: NOW - 1 },
              { name: 'Opus', utilization: 0.5, resetsAt: NOW + 60_000 },
            ],
          },
        }),
      ]),
      opts,
    );
    expect(out).toContain('OPUS'); // Fable's window is over, so Opus is the one that binds
    expect(out).toContain(' 50%');
  });

  it('names the OPEN model when an expired one is listed first and both read empty', () => {
    // Same tie as the report: both normalise to 0, so the first listed would win
    // by accident and the column would name a model that is not running.
    const out = renderDashboard(
      snapshot([
        account({
          name: 'tie',
          usage: {
            fiveHour: 0,
            sevenDay: 0,
            models: [
              { name: 'Fable', utilization: 1, resetsAt: NOW - 1 }, // expired
              { name: 'Opus', utilization: 0, resetsAt: NOW + 60_000 }, // open
            ],
          },
        }),
      ]),
      opts,
    );
    expect(out).toContain('OPUS');
    expect(out).not.toContain('FABLE');
  });

  it('reads the account-wide columns as empty once they reset', () => {
    const out = renderDashboard(
      snapshot([
        account({
          name: 'lifted',
          usage: { fiveHour: 1, sevenDay: 1, fiveHourReset: NOW - 1, sevenDayReset: NOW - 1 },
        }),
      ]),
      opts,
    );
    expect(out).not.toContain('100%');
  });
});

describe('renderDashboard (plain)', () => {
  const opts = { color: false as const };

  it('shows the title, header, and each account', () => {
    const out = renderDashboard(snapshot([account({ name: 'work' }), account({ name: 'personal' })]), opts);
    expect(out).toContain('claude-auto-switch');
    expect(out).toContain('ACCOUNT');
    expect(out).toContain('work');
    expect(out).toContain('personal');
  });

  it('names the account priority where there is room to explain it', () => {
    // The table gave its width to the bars, so priority moved to the line that
    // describes the highlighted account. Row ORDER still carries it as well.
    const out = renderDashboard(snapshot([account({ name: 'work', priority: 2 })]), {
      ...opts,
      interactive: true,
    });
    expect(out).toContain('priority 2');
  });

  it('draws each window as a bar, so the state reads without arithmetic', () => {
    // The same bar language as `ccx usage`, deliberately: two pages describing
    // the same numbers in two visual dialects taught the operator to distrust
    // both.
    const out = renderDashboard(
      snapshot([account({ name: 'w', usage: { fiveHour: 0, sevenDay: 1 } })]),
      opts,
    );
    const row = out.split('\n').find((l) => / w /.test(l))!;
    expect(row).toContain('░░░░░░░░░░'); // empty reads empty
    expect(row).toContain('██████████'); // spent reads full
  });

  it('shows the SAME model in every row of the model column', () => {
    // A column named after one model must contain that model's number in every
    // row. Filling each cell with that account's own worst model made the
    // header a lie for any row whose worst was something else, and the table
    // compared two different things while looking like it compared one.
    const out = renderDashboard(
      snapshot([
        account({
          name: 'main',
          usage: {
            fiveHour: 0,
            sevenDay: 0,
            models: [
              { name: 'Fable', utilization: 1, resetsAt: NOW + 9_000_000 },
              { name: 'Opus', utilization: 0.1, resetsAt: NOW + 9_000_000 },
            ],
          },
        }),
        account({
          name: 'phx',
          usage: {
            fiveHour: 0,
            sevenDay: 0,
            models: [
              { name: 'Fable', utilization: 0.2, resetsAt: NOW + 9_000_000 },
              { name: 'Opus', utilization: 0.9, resetsAt: NOW + 9_000_000 },
            ],
          },
        }),
      ]),
      opts,
    );
    expect(out).toContain('FABLE');
    const phx = out.split('\n').find((l) => l.includes('phx'))!;
    expect(phx).toContain('20%'); // its FABLE, which the column is about
    expect(phx).not.toContain('90%'); // not its Opus, which the header does not name
  });

  it('says where rotation goes next, which the table cannot show', () => {
    // The one thing on this screen no other tool has: not the state, but what
    // the state is about to cause.
    const out = renderDashboard(
      { ...snapshot([account()]), nextUp: 'over on phx, on fable (80% left)' },
      opts,
    );
    expect(out).toContain('next → over on phx, on fable (80% left)');
  });

  it('names the model in use beside the active account', () => {
    const out = renderDashboard(
      { ...snapshot([account({ name: 'a', active: true })]), model: 'fable' },
      opts,
    );
    expect(out).toContain('active: a · on fable');
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
    expect(out).toContain('5-HOUR');
    expect(out).toContain('WEEK');
    expect(out).toContain('FABLE'); // the model column is named after the model

    const hourly = out.split('\n').find((l) => l.includes('hourly'))!;
    expect(hourly).toContain('42%');
    expect(hourly).toContain('9%');

    const modelout = out.split('\n').find((l) => l.includes('modelout'))!;
    expect(modelout).toContain('0%'); // the hour, still fine
    expect(modelout).toContain('62%'); // the week, still fine
    expect(modelout).toContain('100%'); // and the one that stops you
    expect(modelout).toContain('██████████'); // drawn full, so it reads at a glance

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
    const detail = out.split('\n').find((l) => /^\s*work.*:/.test(l))!;
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
    const detail = out.split('\n').find((l) => /^\s*work.*:/.test(l))!;
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

describe('the sign-in question', () => {
  const opts = { color: false as const };
  const asked = 'Sign in "work" again? The dashboard steps aside while you do.';

  it('offers Y as the default, because Enter already confirms', () => {
    // confirmKey has always taken Enter as yes. The label said [y/N], which
    // advertises the opposite, so the quickest key looked like the wrong one
    // and every sign-in was answered by hunting for y.
    const out = renderDashboard(snapshot([account()]), { ...opts, confirm: asked });
    expect(out).toContain('[Y/n]');
    expect(out).not.toContain('[y/N]');
  });

  it('names Enter in the footer, so the default is discoverable without guessing', () => {
    const out = renderDashboard(snapshot([account()]), { ...opts, confirm: asked });
    expect(out).toContain('enter or y confirm');
    // The guard stays: l sits next to j and k, so a stray press must not sign
    // anything in just because the next keystroke happened to arrive.
    expect(out).toContain('any other key cancels');
  });
});
