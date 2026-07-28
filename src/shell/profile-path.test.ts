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
