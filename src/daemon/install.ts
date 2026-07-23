import path from 'node:path';

export const ENV_VAR = 'CLAUDE_CONFIG_DIR';

export interface DaemonInstallAccount {
  name: string;
  dir: string;
  priority: number;
}

export interface DaemonInstallDeps {
  configHome: string;
  accounts: () => DaemonInstallAccount[];
  getActive: () => string | null;
  setActive: (name: string) => void;
  setJunction: (linkPath: string, targetDir: string) => void;
  setUserEnvVar: (name: string, value: string) => void;
  unsetUserEnvVar: (name: string) => void;
  removeJunction: (linkPath: string) => void;
  log: (message: string) => void;
}

export interface InstallResult {
  ok: boolean;
  active?: string;
  linkPath?: string;
}

/** The `active` junction path inside the config home. */
export function activeLinkPath(configHome: string): string {
  return path.join(configHome, 'active');
}

/**
 * Point the OS-level CLAUDE_CONFIG_DIR at a junction that targets the active
 * account, so every Claude client (terminal, extension, cron) follows it. Pure
 * orchestration: every side effect is injected, so it is fully testable.
 */
export function installDaemon(deps: DaemonInstallDeps): InstallResult {
  const accounts = deps.accounts();
  const fallback = [...accounts].sort((a, b) => a.priority - b.priority)[0];
  if (!fallback) {
    deps.log('no accounts registered; run `ccx add <name>` for each account first');
    return { ok: false };
  }

  const link = activeLinkPath(deps.configHome);
  const activeName = deps.getActive() ?? fallback.name;
  const active = accounts.find((a) => a.name === activeName) ?? fallback;

  deps.setJunction(link, active.dir);
  deps.setActive(active.name);
  deps.setUserEnvVar(ENV_VAR, link);

  deps.log(`daemon installed: ${ENV_VAR} -> ${link} -> "${active.name}"`);
  deps.log('RESTART your terminal and IDE once so they pick up the change');
  deps.log('then start the watcher with: ccx daemon start');
  return { ok: true, active: active.name, linkPath: link };
}

/** Reverse install: unset the env var and remove the junction (never touches ~/.claude). */
export function uninstallDaemon(deps: DaemonInstallDeps): InstallResult {
  const link = activeLinkPath(deps.configHome);
  deps.unsetUserEnvVar(ENV_VAR);
  deps.removeJunction(link);
  deps.log(`daemon uninstalled: ${ENV_VAR} unset and junction removed`);
  deps.log('restart your terminal and IDE to return to the default ~/.claude');
  return { ok: true };
}
