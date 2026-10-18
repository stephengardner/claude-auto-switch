import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';
import { shimBlock } from '../shell/install-shim.js';
import type { ShellPlan } from '../shell/shells.js';
import { offCommand, onCommand } from './onoff.js';

/**
 * A Mac-shaped home in a temporary folder. The platform and environment are
 * injected, so the plans come from this folder alone and no real profile is
 * read or written, on any host.
 */
function sandbox(files: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'cas-onoff-'));
  // Joined as the Mac-shaped plans join them, so the paths ccx reports match
  // these on a Windows host too, which takes either separator.
  const at = (name: string) => path.posix.join(root, name);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(at(name)), { recursive: true });
    writeFileSync(at(name), text, 'utf8');
  }
  const ctx = { platform: 'darwin' as const, env: { HOME: root, SHELL: '/bin/zsh', ...env } };
  const said: string[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    out: (m) => said.push(m),
    err: () => {},
    json: false,
    quiet: false,
  };
  return { root, at, context, said };
}

const terminalOnly = { editor: false, statusline: false };

/** How many shim blocks a file holds; 0 when it does not exist. */
function blocks(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('>>> claude-auto-switch shim >>>').length - 1;
}

describe('ccx on, in every shell', () => {
  it('sets up each shell in use, in every file that shell reads', async () => {
    const s = sandbox({ '.bash_profile': 'export A=1\n' });
    expect(await onCommand(s.context, terminalOnly)).toBe(0);
    expect(blocks(s.at('.zshrc'))).toBe(1);
    // A Mac terminal starts bash as a login shell, which reads .bash_profile
    // and not .bashrc; a bash started from another shell reads only .bashrc.
    expect(blocks(s.at('.bashrc'))).toBe(1);
    expect(blocks(s.at('.bash_profile'))).toBe(1);
    expect(readFileSync(s.at('.bash_profile'), 'utf8')).toContain('export A=1');
    expect(s.said).toContain(`terminal: \`claude\` goes through ccx in zsh now (${s.at('.zshrc')})`);
    expect(s.said).toContain(
      `terminal: \`claude\` goes through ccx in bash now (${s.at('.bashrc')}, ${s.at('.bash_profile')})`,
    );
  });

  it('leaves a shell nobody uses alone, and says how to add it', () => {
    const s = sandbox();
    onCommand(s.context, terminalOnly);
    expect(existsSync(s.at('.bashrc'))).toBe(false);
    expect(existsSync(s.at('.profile'))).toBe(false);
    expect(s.said.join('\n')).toContain('ccx on --shell bash');
  });

  it('adds the shells an existing install is missing, and never a second copy', () => {
    // Older versions of ccx wrote the shim into one file: the login shell's.
    const s = sandbox({ '.zshrc': `alias ll='ls -la'\n\n${shimBlock('posix')}\n`, '.bash_history': '' });
    onCommand(s.context, terminalOnly);
    expect(s.said).toContain(`terminal: zsh already set up (${s.at('.zshrc')})`);
    expect(blocks(s.at('.zshrc'))).toBe(1);
    expect(blocks(s.at('.bashrc'))).toBe(1);
    expect(blocks(s.at('.profile'))).toBe(1);

    onCommand(s.context, terminalOnly);
    for (const f of ['.zshrc', '.bashrc', '.profile']) expect(blocks(s.at(f))).toBe(1);
    expect(s.said.filter((l) => l.startsWith('terminal:') && l.includes('already set up'))).toHaveLength(3);
  });

  it('keeps a login bash from loading it twice when its login file loads .bashrc', () => {
    const loader = '[ -f ~/.bashrc ] && . ~/.bashrc\n';
    const s = sandbox({ '.bash_profile': `${loader}\n${shimBlock('posix')}\n`, '.bashrc': '' });
    onCommand(s.context, terminalOnly);
    expect(blocks(s.at('.bashrc'))).toBe(1);
    expect(blocks(s.at('.bash_profile'))).toBe(0);
    expect(readFileSync(s.at('.bash_profile'), 'utf8')).toContain(loader.trim());
  });

  it('sets up a named shell even when nothing shows it is used', async () => {
    const s = sandbox();
    expect(await onCommand(s.context, { ...terminalOnly, shell: 'bash' })).toBe(0);
    expect(blocks(s.at('.bashrc'))).toBe(1);
    expect(blocks(s.at('.profile'))).toBe(1);
    // Only the shell named.
    expect(existsSync(s.at('.zshrc'))).toBe(false);
  });

  it('writes one named file with --profile, as before', () => {
    const s = sandbox();
    onCommand(s.context, { ...terminalOnly, profile: s.at('custom.sh'), shell: 'posix' });
    expect(readFileSync(s.at('custom.sh'), 'utf8')).toContain('claude() {');
    expect(existsSync(s.at('.zshrc'))).toBe(false);
  });

  it('refuses a shell it does not know, and changes nothing', async () => {
    const s = sandbox();
    expect(await onCommand(s.context, { ...terminalOnly, shell: 'fish' })).toBe(1);
    expect(s.said.join('\n')).toContain('unknown shell "fish"');
    expect(existsSync(s.at('.zshrc'))).toBe(false);
  });
});

/** A Windows-shaped plan whose files are in a temporary folder, so it runs on any host. */
function powershellPlan(dir: string, over: Partial<ShellPlan> = {}): ShellPlan {
  return {
    id: 'powershell',
    label: 'Windows PowerShell',
    kind: 'powershell',
    state: 'use',
    files: [path.posix.join(dir, 'profile.ps1')],
    retired: [path.posix.join(dir, 'Microsoft.PowerShell_profile.ps1')],
    sweep: [path.posix.join(dir, 'profile.ps1'), path.posix.join(dir, 'Microsoft.PowerShell_profile.ps1')],
    ...over,
  };
}

describe('ccx on, PowerShell', () => {
  it('moves an existing install out of the console-only profile and into the one every host reads', () => {
    const s = sandbox({ 'ps/Microsoft.PowerShell_profile.ps1': `Set-Alias ll ls\n\n${shimBlock('powershell')}\n` });
    const plans = [powershellPlan(s.at('ps'))];
    onCommand(s.context, terminalOnly, { plans });
    expect(blocks(s.at('ps/profile.ps1'))).toBe(1);
    // The console profile is read after the all-hosts one, so a copy left
    // there would run instead, and an older one would bring back its bugs.
    expect(blocks(s.at('ps/Microsoft.PowerShell_profile.ps1'))).toBe(0);
    expect(readFileSync(s.at('ps/Microsoft.PowerShell_profile.ps1'), 'utf8')).toContain('Set-Alias ll ls');
    expect(s.said.join('\n')).toContain(`removed the older copy in ${s.at('ps/Microsoft.PowerShell_profile.ps1')}`);
  });

  it('writes nothing where the execution policy would refuse to run it, and gives the command that allows it', async () => {
    const s = sandbox();
    const fix = 'powershell -NoProfile -Command Set-ExecutionPolicy -Scope CurrentUser RemoteSigned';
    const plans = [
      powershellPlan(s.at('ps'), { blocked: { detail: 'its execution policy is Restricted', fix } }),
    ];
    expect(await onCommand(s.context, terminalOnly, { plans })).toBe(0);
    // A profile it may not run puts an error in every window it opens.
    expect(existsSync(s.at('ps/profile.ps1'))).toBe(false);
    const said = s.said.join('\n');
    expect(said).toContain('Windows PowerShell not set up: its execution policy is Restricted');
    expect(said).toContain(fix);
  });

  it('reports a profile it cannot write, and fails', async () => {
    const s = sandbox();
    // A folder where the file should be: nothing can be written there.
    mkdirSync(s.at('ps/profile.ps1'), { recursive: true });
    expect(await onCommand(s.context, terminalOnly, { plans: [powershellPlan(s.at('ps'))] })).toBe(1);
    expect(s.said.join('\n')).toContain('Windows PowerShell not set up: could not write');
  });
});

describe('ccx off', () => {
  it('removes the shim from every file it was written to', () => {
    const s = sandbox({ '.bash_profile': 'export A=1\n' });
    onCommand(s.context, terminalOnly);
    // And where an older ccx could have put it.
    writeFileSync(s.at('.bash_login'), `${shimBlock('posix')}\n`, 'utf8');

    expect(offCommand(s.context, terminalOnly)).toBe(0);
    for (const f of ['.zshrc', '.bashrc', '.bash_profile', '.bash_login']) expect(blocks(s.at(f))).toBe(0);
    expect(readFileSync(s.at('.bash_profile'), 'utf8')).toContain('export A=1');
    expect(s.said).toContain(`terminal: shim removed from ${s.at('.bash_profile')}`);
    expect(s.said).toContain(`terminal: shim removed from ${s.at('.bash_login')}`);
  });

  it('removes it from PowerShell profiles, the old console-only one included', () => {
    const s = sandbox({
      'ps/profile.ps1': `${shimBlock('powershell')}\n`,
      'ps/Microsoft.PowerShell_profile.ps1': `${shimBlock('powershell')}\n`,
    });
    offCommand(s.context, terminalOnly, { plans: [powershellPlan(s.at('ps'))] });
    expect(blocks(s.at('ps/profile.ps1'))).toBe(0);
    expect(blocks(s.at('ps/Microsoft.PowerShell_profile.ps1'))).toBe(0);
  });

  it('says so when there is nothing to remove', () => {
    const s = sandbox();
    offCommand(s.context, terminalOnly);
    expect(s.said).toContain('terminal: no shim found');
  });

  it('removes it from one shell, or one file, when told to', () => {
    const s = sandbox({ '.bash_history': '' });
    onCommand(s.context, terminalOnly);
    offCommand(s.context, { ...terminalOnly, shell: 'bash' });
    expect(blocks(s.at('.bashrc'))).toBe(0);
    expect(blocks(s.at('.zshrc'))).toBe(1);

    offCommand(s.context, { ...terminalOnly, profile: s.at('.zshrc') });
    expect(blocks(s.at('.zshrc'))).toBe(0);
  });
});
