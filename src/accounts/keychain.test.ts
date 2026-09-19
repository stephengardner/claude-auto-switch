import { describe, expect, it, vi } from 'vitest';
import type { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  keychainService,
  readKeychainCredential,
  writeKeychainCredential,
  deleteKeychainCredential,
} from './keychain.js';

function runner(implementation: (...args: unknown[]) => string = () => '') {
  const mock = vi.fn(implementation);
  return {
    mock,
    options: {
      platform: 'darwin' as const,
      username: 'tester',
      exec: mock as unknown as typeof execFileSync,
    },
  };
}

describe('macOS profile Keychain', () => {
  it("uses Claude's profile-specific service name, including Unicode normalization", () => {
    // SHA-256 prefix of the exact config-dir string, as used by Claude Code.
    expect(keychainService('/tmp/ccx-profile-a')).toBe('Claude Code-credentials-7f69938a');
    expect(keychainService(path.resolve('caf\u00e9'))).toBe(
      keychainService(path.resolve('cafe\u0301')),
    );
    expect(keychainService('/profiles/one')).not.toBe(keychainService('/profiles/two'));
  });

  it('does not access Keychain on Linux or Windows', () => {
    const { mock, options } = runner();
    for (const platform of ['linux', 'win32'] as const) {
      expect(readKeychainCredential('/profile', { ...options, platform })).toBeNull();
      deleteKeychainCredential('/profile', { ...options, platform });
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it('reads only the requested service and treats item-not-found as absent', () => {
    const { mock, options } = runner(() => {
      throw { status: 44 };
    });
    expect(readKeychainCredential('/profile', options)).toBeNull();
    expect(mock).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/security',
      ['find-generic-password', '-a', 'tester', '-w', '-s', keychainService('/profile')],
      expect.objectContaining({ timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('sanitizes read errors and does not treat a locked Keychain as an absent item', () => {
    const { options } = runner(() => {
      throw { status: 36, stdout: 'secret', stderr: 'secret' };
    });
    expect(() => readKeychainCredential('/profile', options)).toThrow(
      'Could not read the profile login from macOS Keychain',
    );
  });

  it('sends writes over stdin, keeps secrets out of argv, and verifies the saved value', () => {
    const secret = JSON.stringify({ accessToken: 'secret\n"\\' });
    const { mock, options } = runner((_bin, args) =>
      (args as string[])[0] === '-i' ? '' : secret,
    );
    writeKeychainCredential('/profile', secret, options);
    expect(mock.mock.calls[0]?.[1]).toEqual(['-i']);
    expect(mock.mock.calls[0]?.[2]).toMatchObject({
      input: `add-generic-password -U -a "tester" -s "${keychainService('/profile')}" -X "${Buffer.from(secret).toString('hex')}"\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('detects a failed interactive write even if security exits zero', () => {
    const { options } = runner(() => 'old credential');
    expect(() => writeKeychainCredential('/profile', 'new credential', options)).toThrow(
      'Could not save the profile login in macOS Keychain',
    );
  });

  it('ignores an absent item on delete but reports other failures without secret output', () => {
    const { mock, options } = runner(() => {
      throw { status: 44 };
    });
    expect(() => deleteKeychainCredential('/profile', options)).not.toThrow();
    mock.mockImplementation(() => {
      throw { status: 36, stdout: 'secret' };
    });
    expect(() => deleteKeychainCredential('/profile', options)).toThrow(
      'Could not remove the profile login from macOS Keychain',
    );
  });
});
