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
    expect(out).toContain('recent');
    expect(out).toContain('e6');
    expect(out).not.toContain('e1');
  });

  it('shows key hints only in interactive mode, no footer for a one-shot frame', () => {
    expect(renderDashboard(snapshot([account()]), opts)).not.toContain('[r]otate');
    expect(renderDashboard(snapshot([account()]), opts)).not.toContain('refreshing');
    expect(renderDashboard(snapshot([account()]), { color: false, interactive: true })).toContain(
      '[r]otate',
    );
  });

  it('marks the selected row with a cursor', () => {
    const out = renderDashboard(
      snapshot([account({ name: 'a' }), account({ name: 'b' })]),
      { color: false, selected: 1 },
    );
    const lines = out.split('\n');
    const bRow = lines.find((l) => l.includes('b'))!;
    expect(bRow.trimStart().startsWith('>')).toBe(true);
    const aRow = lines.find((l) => / a /.test(l) || l.includes(' a  '))!;
    expect(aRow.trimStart().startsWith('>')).toBe(false);
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
