import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

export function pidFilePath(configHome: string): string {
  return path.join(configHome, 'daemon.pid');
}

/** Launch `ccx daemon run` detached and record its pid. */
export function startBackground(configHome: string, cliPath: string): number {
  const child = spawn(process.execPath, [cliPath, 'daemon', 'run'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const pid = child.pid ?? -1;
  writeFileSync(pidFilePath(configHome), String(pid), 'utf8');
  return pid;
}

/** Stop the background daemon via its pidfile. Returns false if none was running. */
export function stopBackground(configHome: string): boolean {
  const file = pidFilePath(configHome);
  if (!existsSync(file)) return false;
  const pid = Number(readFileSync(file, 'utf8').trim());
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
  rmSync(file, { force: true });
  return true;
}

/** The running daemon's pid, or null if the pidfile is absent or the process is dead. */
export function runningPid(configHome: string): number | null {
  const file = pidFilePath(configHome);
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8').trim());
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}
