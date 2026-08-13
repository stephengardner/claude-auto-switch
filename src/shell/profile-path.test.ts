import { describe, it, expect } from 'vitest';
import {
  defaultPowerShellProfile,
  defaultPosixProfile,
  shouldAskPowerShell,
} from './profile-path.js';

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
  // The host platform is injected throughout, because the real-PowerShell path
  // only exists on Windows: without that, these would pass on Linux CI even if
  // the guard were reverted, since `platform !== 'win32'` skips the query long
  // before the rule under test is reached.
  const onWindows = { hostPlatform: 'win32' as const };

  it('decides by what was injected, on any host', () => {
    expect(shouldAskPowerShell({}, 'win32')).toBe(true);
    expect(shouldAskPowerShell({ env: { USERPROFILE: 'C:\\tmp' } }, 'win32')).toBe(false);
    expect(shouldAskPowerShell({ platform: 'win32' }, 'win32')).toBe(false);
    expect(shouldAskPowerShell({}, 'linux')).toBe(false);
  });

  it('does not ask the real machine when it was given an environment', () => {
    // This one bit caused real damage. `ccx off` pointed at a temporary home
    // still asked PowerShell for its own $PROFILE, got the developer's real
    // one back, and removed the shim from it.
    let asked = 0;
    const queryProfile = () => {
      asked += 1;
      return 'C:\\Users\\real\\OneDrive\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1';
    };

    const sandboxed = defaultPowerShellProfile(
      { env: { USERPROFILE: 'C:\\tmp\\sandbox', HOME: '/tmp/sandbox' } },
      { ...onWindows, queryProfile },
    );
    expect(asked).toBe(0);
    // Pinned exactly, not just "contains sandbox". Both home variables are set
    // here on purpose: a resolver that worked out the platform twice could pick
    // the POSIX home and then join it with Windows separators, and a loose
    // assertion would have called that a pass.
    expect(sandboxed).toBe(
      'C:\\tmp\\sandbox\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
    );

    // With nothing injected it is real CLI use, and the real answer is right.
    expect(defaultPowerShellProfile({}, { ...onWindows, queryProfile })).toContain('OneDrive');
    expect(asked).toBe(1);
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
