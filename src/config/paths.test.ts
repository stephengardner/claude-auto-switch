import { describe, it, expect } from 'vitest';
import { configHome, profilesDir, defaultCredFile, expandTilde, homeDir } from './paths.js';

const linux = { platform: 'linux' as const, env: { HOME: '/home/me' } };
const win = { platform: 'win32' as const, env: { USERPROFILE: 'C:\\Users\\me' } };
const mac = { platform: 'darwin' as const, env: { HOME: '/Users/me' } };

describe('homeDir', () => {
  it('uses HOME on posix and USERPROFILE on windows', () => {
    expect(homeDir(linux)).toBe('/home/me');
    expect(homeDir(win)).toBe('C:\\Users\\me');
  });
  it('throws when neither is set', () => {
    expect(() => homeDir({ platform: 'linux', env: {} })).toThrow();
  });
});

describe('configHome', () => {
  it('defaults to ~/.claude-auto-switch on linux', () => {
    expect(configHome(linux)).toBe('/home/me/.claude-auto-switch');
  });
  it('uses USERPROFILE with backslashes on windows', () => {
    expect(configHome(win)).toBe('C:\\Users\\me\\.claude-auto-switch');
  });
  it('honors CLAUDE_AUTO_SWITCH_HOME override', () => {
    expect(
      configHome({ platform: 'linux', env: { HOME: '/home/me', CLAUDE_AUTO_SWITCH_HOME: '/custom' } }),
    ).toBe('/custom');
  });
});

describe('profilesDir', () => {
  it('defaults to <configHome>/profiles', () => {
    expect(profilesDir({}, linux)).toBe('/home/me/.claude-auto-switch/profiles');
  });
  it('expands a tilde in a configured profilesDir', () => {
    expect(profilesDir({ profilesDir: '~/somewhere/profiles' }, linux)).toBe(
      '/home/me/somewhere/profiles',
    );
  });
});

describe('defaultCredFile', () => {
  it('is plaintext under USERPROFILE on windows', () => {
    expect(defaultCredFile(win)).toBe('C:\\Users\\me\\.claude\\.credentials.json');
  });
  it('is ~/.claude/.credentials.json on linux', () => {
    expect(defaultCredFile(linux)).toBe('/home/me/.claude/.credentials.json');
  });
  it('is a keychain sentinel on macOS', () => {
    expect(defaultCredFile(mac)).toBe('keychain');
  });
});

describe('expandTilde', () => {
  it('leaves absolute paths untouched', () => {
    expect(expandTilde('/etc/x', linux)).toBe('/etc/x');
  });
  it('expands a bare tilde to the home dir', () => {
    expect(expandTilde('~', linux)).toBe('/home/me');
  });
});
