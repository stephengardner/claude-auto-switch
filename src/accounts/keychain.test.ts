import { describe, expect, it, vi } from 'vitest';
import type { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  deleteKeychainCredentialAsync,
  execFileAsync,
  keychainService,
  readKeychainCredential,
  readKeychainCredentialAsync,
  writeKeychainCredential,
  writeKeychainCredentialAsync,
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

/** A stand-in for `security` run off the thread: what it answers, or the exit status it fails with. */
function waitingRunner(implementation: (args: string[], input?: string) => string | { code: number; stdout?: string }) {
  const mock = vi.fn(async (_file: string, args: string[], options: { input?: string; timeout: number }) => {
    const answer = implementation(args, options.input);
    if (typeof answer === 'string') return answer;
    throw Object.assign(new Error('security failed'), answer);
  });
  return { mock, options: { platform: 'darwin' as const, username: 'tester', execAsync: mock } };
}

describe('macOS profile Keychain, off the thread', () => {
  it('reads the same item as the blocking read, with the same time limit, and treats item-not-found as absent', async () => {
    const { mock, options } = waitingRunner(() => ({ code: 44 }));
    expect(await readKeychainCredentialAsync('/profile', options)).toBeNull();
    expect(mock).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/security',
      ['find-generic-password', '-a', 'tester', '-w', '-s', keychainService('/profile')],
      { timeout: 2000 },
    );
  });

  it('answers with the item, trimmed', async () => {
    const { options } = waitingRunner(() => '{"claudeAiOauth":{}}\n');
    expect(await readKeychainCredentialAsync('/profile', options)).toBe('{"claudeAiOauth":{}}');
  });

  it('never runs `security` on Linux or Windows', async () => {
    const { mock, options } = waitingRunner(() => 'x');
    for (const platform of ['linux', 'win32'] as const) {
      expect(await readKeychainCredentialAsync('/profile', { ...options, platform })).toBeNull();
      await deleteKeychainCredentialAsync('/profile', { ...options, platform });
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it('says only that a read failed, never what `security` printed', async () => {
    const { options } = waitingRunner(() => ({ code: 36, stdout: 'secret' }));
    await expect(readKeychainCredentialAsync('/profile', options)).rejects.toThrow(
      /^Could not read the profile login from macOS Keychain$/,
    );
  });

  it('writes over standard input, never in its arguments, and reads the item back to be sure', async () => {
    const secret = JSON.stringify({ accessToken: 'secret' });
    let stored = '';
    const { mock, options } = waitingRunner((args, input) => {
      if (args[0] === '-i') {
        stored = secret;
        expect(input).toBe(
          `add-generic-password -U -a "tester" -s "${keychainService('/profile')}" -X "${Buffer.from(secret).toString('hex')}"\n`,
        );
        return '';
      }
      return stored;
    });
    await writeKeychainCredentialAsync('/profile', secret, options);
    expect(mock.mock.calls.map((call) => call[1][0])).toEqual(['-i', 'find-generic-password']);
    expect(JSON.stringify(mock.mock.calls[0]?.[1])).not.toContain('secret');
  });

  it('fails a write the item does not show, though `security` said it went', async () => {
    const { options } = waitingRunner((args) => (args[0] === '-i' ? '' : 'old login'));
    await expect(writeKeychainCredentialAsync('/profile', 'new login', options)).rejects.toThrow(
      'Could not save the profile login in macOS Keychain',
    );
  });

  it('removes an item, an absent one included, and says only that removing failed', async () => {
    await expect(deleteKeychainCredentialAsync('/profile', waitingRunner(() => ({ code: 44 })).options)).resolves.toBe(
      undefined,
    );
    await expect(
      deleteKeychainCredentialAsync('/profile', waitingRunner(() => ({ code: 36, stdout: 'secret' })).options),
    ).rejects.toThrow(/^Could not remove the profile login from macOS Keychain$/);
  });
});

describe('the program `security` is run as, off the thread', () => {
  const node = process.execPath;

  it('hands the program its input and answers with what it printed', async () => {
    const echo = "process.stdin.setEncoding('utf8'); let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => process.stdout.write(s.toUpperCase()));";
    expect(await execFileAsync(node, ['-e', echo], { input: 'a login', timeout: 10_000 })).toBe('A LOGIN');
  });

  it('fails with the exit status as its code, as an absent item is told apart by', async () => {
    await expect(execFileAsync(node, ['-e', 'process.exit(44)'], { timeout: 10_000 })).rejects.toMatchObject({ code: 44 });
  });

  it('gives up on a program that runs past its time limit', async () => {
    const started = Date.now();
    await expect(execFileAsync(node, ['-e', 'setTimeout(() => {}, 30000)'], { timeout: 500 })).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('frees the thread while the program runs', async () => {
    let ticks = 0;
    const tick = setInterval(() => (ticks += 1), 20);
    try {
      await execFileAsync(node, ['-e', 'setTimeout(() => {}, 400)'], { timeout: 10_000 });
    } finally {
      clearInterval(tick);
    }
    expect(ticks).toBeGreaterThan(3);
  });
});
