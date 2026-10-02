import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Opening a new terminal window that runs one command, in one folder.
 *
 * Used to carry a Claude Desktop conversation on in a terminal ccx controls.
 * The command is written into a small launcher script rather than squeezed onto
 * a command line, because it passes through a terminal app and a shell that
 * each parse quotes their own way (Windows Terminal even splits on `;`), and a
 * prompt is free text that can contain any of those.
 */

export interface TerminalJob {
  /** Folder to start in. */
  cwd: string;
  /** Window title. */
  title: string;
  /** The program and its arguments, run exactly as given (no shell parsing). */
  command: string[];
  /**
   * Run first, the same way; `command` runs only if this succeeds. Used to wait
   * until Claude Desktop has stopped working on a conversation before it is
   * picked up here, so two processes never write into one conversation.
   */
  gate?: string[];
  /** Where the launcher script is written. */
  scriptDir: string;
  /** A file-system-safe name for the launcher script, without extension. */
  scriptName: string;
}

/**
 * Variables a Claude host sets for its OWN child processes: Claude Desktop for
 * the Claude it runs, and Claude for the hooks and tools it runs. A brand-new
 * top-level session must not inherit them. `CLAUDECODE` alone makes Claude
 * refuse to start, taking itself for a session nested inside another; the rest
 * tie it to a host that is not there (a messaging socket, a session id, an
 * account Desktop chose) or change how it behaves.
 */
export const HOST_ONLY_ENV: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_PID',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_EFFORT',
  'CLAUDE_ENV_FILE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_NAME',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_ACCOUNT_UUID',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_RATE_LIMIT_TIER',
  'CLAUDE_CODE_SUBSCRIPTION_TYPE',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_SDK_READS_SESSION_STATE',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_CODE_TERMINAL_MCP_TOOLS',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
  'CLAUDE_AGENT_SDK_VERSION',
];

/** `env` without the host-only variables, as a plain string map. */
export function scrubHostEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  // Case-insensitive, because Windows environment names are.
  const drop = new Set(HOST_ONLY_ENV.map((n) => n.toUpperCase()));
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !drop.has(key.toUpperCase())) out[key] = value;
  }
  return out;
}

/** A PowerShell single-quoted string: nothing inside it is interpreted. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A POSIX shell single-quoted string. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `words` as a line someone can paste into their shell: quoted only where it
 * has to be. PowerShell swallows a bare `--` on its way to `ccx.ps1`, so there
 * it is quoted too.
 */
export function pasteable(words: string[], platform: NodeJS.Platform = process.platform): string {
  const plain = /^[\w@%+=:,./\\-]+$/;
  return words
    .map((w) => {
      if (platform === 'win32') return plain.test(w) && w !== '--' ? w : psQuote(w);
      return plain.test(w) ? w : shQuote(w);
    })
    .join(' ');
}

/** A PowerShell call of `command`, each part a literal. */
function psCall(command: string[]): string {
  const [program, ...args] = command;
  return `& ${psQuote(program ?? '')} ${args.map(psQuote).join(' ')}`;
}

/** The PowerShell launcher for `job`. */
export function windowsLauncher(job: TerminalJob): string {
  return [
    `# ccx: ${job.title.replace(/[\r\n]+/g, ' ')}`,
    `foreach ($name in @(${HOST_ONLY_ENV.map(psQuote).join(', ')})) {`,
    '  Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue',
    '}',
    `$Host.UI.RawUI.WindowTitle = ${psQuote(job.title)}`,
    `Set-Location -LiteralPath ${psQuote(job.cwd)}`,
    ...(job.gate ? [psCall(job.gate), 'if ($LASTEXITCODE -ne 0) { return }'] : []),
    psCall(job.command),
    '',
  ].join('\r\n');
}

/** The POSIX shell launcher for `job`. */
export function posixLauncher(job: TerminalJob): string {
  const run = job.command.map(shQuote).join(' ');
  return [
    '#!/bin/sh',
    `# ccx: ${job.title.replace(/[\r\n]+/g, ' ')}`,
    `unset ${HOST_ONLY_ENV.join(' ')}`,
    `printf '\\033]0;%s\\007' ${shQuote(job.title)}`,
    `cd ${shQuote(job.cwd)} || exit 1`,
    job.gate ? `${job.gate.map(shQuote).join(' ')} && ${run}` : run,
    // Keep the window open after Claude exits, the way a terminal you opened
    // yourself stays open, so nothing it printed is lost.
    'exec "${SHELL:-/bin/sh}"',
    '',
  ].join('\n');
}

export interface TerminalDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Start a program detached from this process. */
  start?: (program: string, args: string[], env: Record<string, string>) => void;
  /** Whether a program can be found on PATH. */
  exists?: (program: string) => boolean;
  writeScript?: (file: string, content: string, executable: boolean) => void;
}

export type TerminalResult =
  { ok: true; via: string; script: string } | { ok: false; reason: string };

function startDetached(program: string, args: string[], env: Record<string, string>): void {
  const child = nodeSpawn(program, args, {
    detached: true,
    stdio: 'ignore',
    env,
    windowsHide: false,
  });
  child.on('error', () => {
    /* reported by the caller's existence check; a late failure has nobody to tell */
  });
  child.unref();
}

function onPath(program: string, platform: NodeJS.Platform): boolean {
  const finder = platform === 'win32' ? 'where' : 'which';
  try {
    return spawnSync(finder, [program], { stdio: 'ignore', windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

function writeLauncher(file: string, content: string, executable: boolean): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  if (executable) chmodSync(file, 0o755);
}

/** The terminal programs tried on Linux, in order, with how each is told what to run. */
const LINUX_TERMINALS = [
  ['x-terminal-emulator', ['-e']],
  ['gnome-terminal', ['--']],
  ['konsole', ['-e']],
  ['xterm', ['-e']],
] as const;

/**
 * Whether a window can be opened here at all, without opening one. Windows and
 * macOS always have one; a Linux machine may have no terminal program.
 */
export function canOpenTerminal(deps: Pick<TerminalDeps, 'platform' | 'exists'> = {}): boolean {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32' || platform === 'darwin') return true;
  const exists = deps.exists ?? ((p: string) => onPath(p, platform));
  return LINUX_TERMINALS.some(([program]) => exists(program));
}

/** Open a new terminal window running `job`. */
export function openTerminal(job: TerminalJob, deps: TerminalDeps = {}): TerminalResult {
  const platform = deps.platform ?? process.platform;
  const env = scrubHostEnv(deps.env ?? process.env);
  const start = deps.start ?? startDetached;
  const exists = deps.exists ?? ((p: string) => onPath(p, platform));
  const write = deps.writeScript ?? writeLauncher;

  if (platform === 'win32') {
    const script = path.join(job.scriptDir, `${job.scriptName}.ps1`);
    write(script, windowsLauncher(job), false);
    const shell = exists('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';
    const shellArgs = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', script];
    if (exists('wt.exe')) {
      // Windows Terminal reads `;` as "and another tab", and parses quotes its
      // own way, so neither goes into the title.
      const title = job.title.replace(/;/g, ',').replace(/"/g, "'");
      start('wt.exe', ['-w', 'new', '--title', title, shell, ...shellArgs], env);
      return { ok: true, via: 'Windows Terminal', script };
    }
    // A console program started detached gets a console window of its own.
    start(shell, shellArgs, env);
    return { ok: true, via: shell === 'pwsh.exe' ? 'PowerShell 7' : 'Windows PowerShell', script };
  }

  const script = path.join(job.scriptDir, `${job.scriptName}.sh`);
  write(script, posixLauncher(job), true);
  if (platform === 'darwin') {
    // AppleScript string: backslashes and double quotes need escaping.
    const inner = `/bin/sh ${shQuote(script)}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    start(
      'osascript',
      [
        '-e',
        'tell application "Terminal" to activate',
        '-e',
        `tell application "Terminal" to do script "${inner}"`,
      ],
      env,
    );
    return { ok: true, via: 'Terminal', script };
  }
  for (const [program, prefix] of LINUX_TERMINALS) {
    if (!exists(program)) continue;
    start(program, [...prefix, '/bin/sh', script], env);
    return { ok: true, via: program, script };
  }
  return {
    ok: false,
    reason: `no terminal program found to open; run it yourself: /bin/sh ${script}`,
  };
}
