import { describe, it, expect } from 'vitest';
import {
  HOST_ONLY_ENV,
  canOpenTerminal,
  openTerminal,
  pasteable,
  posixLauncher,
  psQuote,
  scrubHostEnv,
  shQuote,
  windowsLauncher,
  type TerminalJob,
} from './terminal.js';

const job = (extra: Partial<TerminalJob> = {}): TerminalJob => ({
  cwd: "C:\\Users\\me\\it's here",
  title: 'ccx: Schema review',
  command: [
    'C:\\node.exe',
    'C:\\ccx\\cli.js',
    'run',
    '--resume-prompt',
    "Don't stop; carry on.",
    '--',
    '--resume',
    'id',
  ],
  scriptDir: 'C:\\ccx\\handoffs',
  scriptName: 'id',
  ...extra,
});

describe("a new Claude must not inherit its host's variables", () => {
  it('drops what Desktop and Claude set for their own children, and keeps the rest', () => {
    const env = scrubHostEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret',
      claude_config_dir: 'C:\\session', // Windows names are case-insensitive
      PATH: 'C:\\bin',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', // the user's own setting
    });
    expect(env).toEqual({ PATH: 'C:\\bin', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' });
  });

  it('lists CLAUDECODE, which alone makes Claude refuse to start as a nested session', () => {
    expect(HOST_ONLY_ENV).toContain('CLAUDECODE');
  });
});

describe('the launcher scripts', () => {
  it('quote anything, so a prompt can hold quotes, semicolons and new lines', () => {
    expect(psQuote("it's")).toBe("'it''s'");
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('show a command someone can paste: quoted only where needed, and a bare -- kept in PowerShell', () => {
    const words = [
      'run',
      '--resume-prompt',
      "Don't stop.",
      '--',
      '--resume',
      'id',
      '--model',
      'claude-opus-5-5',
    ];
    expect(pasteable(words, 'win32')).toBe(
      "run --resume-prompt 'Don''t stop.' '--' --resume id --model claude-opus-5-5",
    );
    expect(pasteable(words, 'linux')).toBe(
      `run --resume-prompt 'Don'\\''t stop.' -- --resume id --model claude-opus-5-5`,
    );
  });

  it('PowerShell: clears the host variables, goes to the folder, and runs the command as given', () => {
    const script = windowsLauncher(job());
    expect(script).toContain("'CLAUDECODE'");
    expect(script).toContain("Set-Location -LiteralPath 'C:\\Users\\me\\it''s here'");
    expect(script).toContain(
      "& 'C:\\node.exe' 'C:\\ccx\\cli.js' 'run' '--resume-prompt' 'Don''t stop; carry on.' '--' '--resume' 'id'",
    );
  });

  it('PowerShell: waits on the gate and goes no further when it fails', () => {
    const script = windowsLauncher(
      job({ gate: ['C:\\node.exe', 'C:\\ccx\\cli.js', 'desktop', 'wait', '42'] }),
    );
    const lines = script.split('\r\n');
    const gate = lines.findIndex((l) => l.includes("'desktop' 'wait' '42'"));
    expect(lines[gate + 1]).toBe('if ($LASTEXITCODE -ne 0) { return }');
    expect(lines[gate + 2]).toContain("'run'");
  });

  it('POSIX: the same, chained with &&, and the window stays open afterwards', () => {
    const script = posixLauncher(job({ gate: ['node', 'cli.js', 'desktop', 'wait', '42'] }));
    expect(script).toContain('unset CLAUDECODE');
    expect(script).toContain(`cd 'C:\\Users\\me\\it'\\''s here' || exit 1`);
    expect(script).toContain(`'node' 'cli.js' 'desktop' 'wait' '42' && 'C:\\node.exe'`);
    expect(script.trimEnd().endsWith('exec "${SHELL:-/bin/sh}"')).toBe(true);
  });
});

describe('opening the window', () => {
  function recorder(available: string[]) {
    const started: Array<{ program: string; args: string[]; env: Record<string, string> }> = [];
    const written: string[] = [];
    return {
      started,
      written,
      deps: {
        env: { PATH: 'p', CLAUDECODE: '1' },
        start: (program: string, args: string[], env: Record<string, string>) =>
          started.push({ program, args, env }),
        exists: (p: string) => available.includes(p),
        writeScript: (file: string) => written.push(file),
      },
    };
  }

  it('Windows: in Windows Terminal when there is one, with a clean environment', () => {
    const r = recorder(['wt.exe', 'pwsh.exe']);
    const result = openTerminal(job({ title: 'ccx: a; "b"' }), { ...r.deps, platform: 'win32' });
    expect(result).toMatchObject({ ok: true, via: 'Windows Terminal' });
    expect(r.started[0]?.program).toBe('wt.exe');
    // `;` would start a second tab in Windows Terminal, which parses quotes its own way.
    expect(r.started[0]?.args).toContain("ccx: a, 'b'");
    expect(r.started[0]?.args).toContain('pwsh.exe');
    expect(r.started[0]?.env).toEqual({ PATH: 'p' });
    expect(r.written[0]).toMatch(/id\.ps1$/);
  });

  it('Windows: otherwise in a PowerShell window of its own', () => {
    const r = recorder([]);
    expect(openTerminal(job(), { ...r.deps, platform: 'win32' })).toMatchObject({
      ok: true,
      via: 'Windows PowerShell',
    });
    expect(r.started[0]?.program).toBe('powershell.exe');
  });

  it('macOS: in Terminal', () => {
    const r = recorder([]);
    expect(openTerminal(job(), { ...r.deps, platform: 'darwin' })).toMatchObject({
      ok: true,
      via: 'Terminal',
    });
    expect(r.started[0]?.program).toBe('osascript');
  });

  it('knows whether a window can be opened at all, before anything is held for one', () => {
    expect(canOpenTerminal({ platform: 'win32', exists: () => false })).toBe(true);
    expect(canOpenTerminal({ platform: 'darwin', exists: () => false })).toBe(true);
    expect(canOpenTerminal({ platform: 'linux', exists: (p) => p === 'xterm' })).toBe(true);
    expect(canOpenTerminal({ platform: 'linux', exists: () => false })).toBe(false);
  });

  it('Linux: the first terminal program there is, or says how to run it by hand', () => {
    const r = recorder(['konsole', 'xterm']);
    expect(openTerminal(job(), { ...r.deps, platform: 'linux' })).toMatchObject({
      ok: true,
      via: 'konsole',
    });
    const none = recorder([]);
    const result = openTerminal(job(), { ...none.deps, platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/run it yourself: \/bin\/sh .*id\.sh/);
  });
});
