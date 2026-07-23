import { execFileSync } from 'node:child_process';

/**
 * Persist a user-level environment variable so NEW processes (terminal,
 * extension) inherit it. Windows-only for now; on POSIX the caller prints
 * guidance to add an export line to the shell rc.
 */
export function setUserEnvVar(
  name: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    // setx silently truncates values over ~1024 chars, which would corrupt
    // CLAUDE_CONFIG_DIR. Refuse rather than write a broken value.
    if (value.length > 1024) {
      throw new Error(`environment value for ${name} is too long for setx (${value.length} chars)`);
    }
    execFileSync('setx', [name, value], { stdio: 'ignore' });
    return;
  }
  throw new Error(
    `automatic env-var setting is Windows-only for now; add "export ${name}=${value}" to your shell rc`,
  );
}

/** Remove a user-level environment variable (Windows: delete the registry value). */
export function unsetUserEnvVar(name: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    try {
      execFileSync('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f'], { stdio: 'ignore' });
    } catch {
      /* not set */
    }
  }
}
