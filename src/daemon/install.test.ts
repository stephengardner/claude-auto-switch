import { describe, it, expect } from 'vitest';
import {
  installDaemon,
  uninstallDaemon,
  activeLinkPath,
  ENV_VAR,
  type DaemonInstallDeps,
  type DaemonInstallAccount,
} from './install.js';

const HOME = '/home/.claude-auto-switch';

function harness(accounts: DaemonInstallAccount[], active: string | null = null) {
  const calls = {
    junction: [] as Array<[string, string]>,
    env: [] as Array<[string, string]>,
    unset: [] as string[],
    removed: [] as string[],
  };
  let current = active;
  const deps: DaemonInstallDeps = {
    configHome: HOME,
    accounts: () => accounts,
    getActive: () => current,
    setActive: (n) => {
      current = n;
    },
    setJunction: (l, t) => calls.junction.push([l, t]),
    setUserEnvVar: (n, v) => calls.env.push([n, v]),
    unsetUserEnvVar: (n) => calls.unset.push(n),
    removeJunction: (l) => calls.removed.push(l),
    log: () => {},
  };
  return { deps, calls };
}

const acc = (name: string, priority: number): DaemonInstallAccount => ({
  name,
  dir: `/p/${name}`,
  priority,
});

describe('installDaemon', () => {
  it('junctions to the pinned active account and sets the env var', () => {
    const h = harness([acc('a', 0), acc('b', 1)], 'b');
    const r = installDaemon(h.deps);
    expect(r.ok).toBe(true);
    expect(r.active).toBe('b');
    expect(h.calls.junction).toEqual([[activeLinkPath(HOME), '/p/b']]);
    expect(h.calls.env).toEqual([[ENV_VAR, activeLinkPath(HOME)]]);
  });

  it('defaults active to the lowest-priority account when none is pinned', () => {
    const h = harness([acc('a', 5), acc('b', 1)], null);
    expect(installDaemon(h.deps).active).toBe('b');
  });

  it('fails clearly when no accounts are registered', () => {
    expect(installDaemon(harness([]).deps).ok).toBe(false);
  });
});

describe('uninstallDaemon', () => {
  it('unsets the env var and removes the junction', () => {
    const h = harness([acc('a', 0)]);
    uninstallDaemon(h.deps);
    expect(h.calls.unset).toEqual([ENV_VAR]);
    expect(h.calls.removed).toEqual([activeLinkPath(HOME)]);
  });
});
