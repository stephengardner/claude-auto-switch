import { describe, it, expect } from 'vitest';
import { defaultPowerShellProfile, defaultPosixProfile } from './profile-path.js';

describe('defaultPowerShellProfile (computed fallback, injected platform)', () => {
  it('uses the OneDrive Documents folder when OneDrive is set', () => {
    const c = {
      platform: 'win32' as const,
      env: { USERPROFILE: 'C:\\Users\\me', OneDrive: 'C:\\Users\\me\\OneDrive' },
    };
    expect(defaultPowerShellProfile(c)).toBe(
      'C:\\Users\\me\\OneDrive\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
    );
  });

  it('falls back to the home Documents folder without OneDrive', () => {
    const c = { platform: 'win32' as const, env: { USERPROFILE: 'C:\\Users\\me' } };
    expect(defaultPowerShellProfile(c)).toBe(
      'C:\\Users\\me\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
    );
  });
});

describe('an injected environment is the whole world', () => {
  it('stays inside a redirected home instead of asking the real machine', () => {
    // This one bit caused real damage. `ccx off` pointed at a temporary home
    // still asked PowerShell for its own $PROFILE, got the developer's real
    // one back, and removed the shim from it. Anyone handing this function an
    // environment is saying "this is the machine": honour it.
    const c = {
      env: { USERPROFILE: 'C:\\tmp\\sandbox', HOME: '/tmp/sandbox' },
    };
    const resolved = defaultPowerShellProfile(c);
    expect(resolved).toContain('sandbox');
    expect(resolved.toLowerCase()).not.toContain('onedrive');
  });

  it('ignores an OneDrive redirection that is not in the environment it was given', () => {
    // The ambient OneDrive variable belongs to the real machine, not to the
    // sandbox, so it must not pull the path back out of the given home.
    const before = process.env.OneDrive;
    process.env.OneDrive = 'C:\\Users\\real\\OneDrive';
    try {
      const resolved = defaultPowerShellProfile({
        platform: 'win32' as const,
        env: { USERPROFILE: 'C:\\tmp\\sandbox' },
      });
      expect(resolved).toBe(
        'C:\\tmp\\sandbox\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
      );
    } finally {
      if (before === undefined) delete process.env.OneDrive;
      else process.env.OneDrive = before;
    }
  });
});

describe('defaultPosixProfile', () => {
  it('picks .zshrc for zsh, else .bashrc', () => {
    expect(
      defaultPosixProfile({ platform: 'linux', env: { HOME: '/home/me', SHELL: '/bin/zsh' } }),
    ).toBe('/home/me/.zshrc');
    expect(
      defaultPosixProfile({ platform: 'linux', env: { HOME: '/home/me', SHELL: '/bin/bash' } }),
    ).toBe('/home/me/.bashrc');
  });
});
