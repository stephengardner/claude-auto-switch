import { describe, expect, it, vi } from 'vitest';
import type { execFileSync } from 'node:child_process';
import os from 'node:os';
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
    const writes = mock.mock.calls.filter((call) => (call[1] as string[])[0] !== 'find-generic-password');
    expect(writes.map((call) => call[1])).toEqual([['-i']]);
    expect(writes[0]?.[2]).toMatchObject({
      input: `add-generic-password -U -a "tester" -s "${keychainService('/profile')}" -X "${Buffer.from(secret).toString('hex')}"\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(mock.mock.calls.at(-1)?.[1]).toEqual(['find-generic-password', '-a', 'tester', '-w', '-s', keychainService('/profile')]);
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

/** How a call off the thread ended, so a test asserts it rather than throws it. */
const settled = <T>(running: Promise<T>): Promise<{ value: T } | { error: string }> =>
  running.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: (error as Error).message }),
  );

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
    expect(await settled(readKeychainCredentialAsync('/profile', options))).toEqual({ value: null });
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
    expect(await settled(readKeychainCredentialAsync('/profile', options))).toEqual({
      error: 'Could not read the profile login from macOS Keychain',
    });
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
    expect(mock.mock.calls.map((call) => call[1][0])).toEqual(['find-generic-password', '-i', 'find-generic-password']);
    expect(JSON.stringify(mock.mock.calls.map((call) => call[1]))).not.toContain('secret');
  });

  it('fails a write the item does not show, though `security` said it went', async () => {
    const { options } = waitingRunner((args) => (args[0] === '-i' ? '' : 'old login'));
    expect(await settled(writeKeychainCredentialAsync('/profile', 'new login', options))).toEqual({
      error: 'Could not save the profile login in macOS Keychain',
    });
  });

  it('removes an item, an absent one included, and says only that removing failed', async () => {
    expect(await settled(deleteKeychainCredentialAsync('/profile', waitingRunner(() => ({ code: 44 })).options))).toEqual({
      value: undefined,
    });
    expect(
      await settled(deleteKeychainCredentialAsync('/profile', waitingRunner(() => ({ code: 36, stdout: 'secret' })).options)),
    ).toEqual({ error: 'Could not remove the profile login from macOS Keychain' });
  });
});

/**
 * `security` as macOS runs it, for one item: `-i` reads a line 4096 bytes at
 * a time and runs what it read, so a longer add stores the login cut short
 * and then fails, as measured on macOS 26.
 */
function securityLikeMacOS() {
  const items = new Map<string, string>();
  const fail = (status: number): never => {
    throw Object.assign(new Error('security failed'), { status, code: status });
  };
  const run = (args: string[], input?: string): string => {
    const service = (list: string[]): string => list[list.indexOf('-s') + 1] ?? '';
    if (args[0] === '-i') {
      for (const line of (input ?? '').split('\n').filter(Boolean)) {
        const read = Buffer.from(line).subarray(0, 4096).toString();
        const hex = /-X "([0-9a-f]*)/.exec(read)?.[1] ?? '';
        items.set(/-s "([^"]*)"/.exec(read)?.[1] ?? '', Buffer.from(hex.slice(0, hex.length - (hex.length % 2)), 'hex').toString());
        if (read.length < line.length) fail(1);
      }
      return '';
    }
    if (args[0] === 'add-generic-password') {
      items.set(service(args), Buffer.from(args[args.indexOf('-X') + 1] ?? '', 'hex').toString());
      return '';
    }
    if (args[0] === 'find-generic-password') return items.get(service(args)) ?? fail(44);
    if (args[0] === 'delete-generic-password') return items.delete(service(args)) ? '' : fail(44);
    return fail(2);
  };
  const exec = vi.fn((_file: string, args: string[], options?: { input?: string }) => run(args, options?.input));
  const execAsync = vi.fn(async (_file: string, args: string[], options: { input?: string; timeout: number }) =>
    run(args, options.input),
  );
  return {
    items,
    exec,
    options: { platform: 'darwin' as const, username: 'tester', exec: exec as unknown as typeof execFileSync, execAsync },
  };
}

/** A login as long as one that carries sign-ins to other services: longer than one line of `security -i` takes. */
const longLogin = JSON.stringify({
  claudeAiOauth: { accessToken: 'a'.repeat(120), refreshToken: 'r'.repeat(120), expiresAt: 1 },
  mcpOAuth: Object.fromEntries(['one', 'two', 'three', 'four'].map((name) => [name, { accessToken: name.repeat(200) }])),
});

describe('a login too long for one line of `security -i`', () => {
  it('is long enough to need it', () => {
    expect(longLogin.length).toBeGreaterThan(2100);
  });

  it('is saved whole, blocking', () => {
    const security = securityLikeMacOS();
    security.items.set(keychainService('/profile'), 'the login before');
    expect(() => writeKeychainCredential('/profile', longLogin, security.options)).not.toThrow();
    expect(security.items.get(keychainService('/profile'))).toBe(longLogin);
    expect(readKeychainCredential('/profile', security.options)).toBe(longLogin);
  });

  it('is saved whole, off the thread', async () => {
    const security = securityLikeMacOS();
    security.items.set(keychainService('/profile'), 'the login before');
    expect(await settled(writeKeychainCredentialAsync('/profile', longLogin, security.options))).toEqual({ value: undefined });
    expect(security.items.get(keychainService('/profile'))).toBe(longLogin);
  });

  it('goes over standard input still when it fits', () => {
    const security = securityLikeMacOS();
    writeKeychainCredential('/profile', JSON.stringify({ accessToken: 'short' }), security.options);
    const writes = security.exec.mock.calls.filter((call) => call[1][0] !== 'find-generic-password');
    expect(writes.map((call) => call[1])).toEqual([['-i']]);
  });
});

describe('a write the item does not show', () => {
  /** `security` that takes every add as said and stores something else. */
  function garbling() {
    const security = securityLikeMacOS();
    const service = keychainService('/profile');
    const garble = (args: string[]): void => {
      if (args[0] === '-i' || args[0] === 'add-generic-password') security.items.set(service, '{"claudeAiOauth":{"acc');
    };
    const exec = security.exec.getMockImplementation()!;
    security.exec.mockImplementation((file, args, options) => {
      const out = exec(file, args, options);
      if (args.includes(Buffer.from('the new login').toString('hex')) || options?.input?.includes(Buffer.from('the new login').toString('hex'))) garble(args);
      return out;
    });
    const execAsync = security.options.execAsync.getMockImplementation()!;
    security.options.execAsync.mockImplementation(async (file, args, options) => {
      const out = await execAsync(file, args, options);
      if (options.input?.includes(Buffer.from('the new login').toString('hex'))) garble(args);
      return out;
    });
    return security;
  }

  it('puts back the login that was there, blocking', () => {
    const security = garbling();
    security.items.set(keychainService('/profile'), 'the working login');
    expect(() => writeKeychainCredential('/profile', 'the new login', security.options)).toThrow(
      'Could not save the profile login in macOS Keychain',
    );
    expect(security.items.get(keychainService('/profile'))).toBe('the working login');
  });

  it('puts back the login that was there, off the thread', async () => {
    const security = garbling();
    security.items.set(keychainService('/profile'), 'the working login');
    expect(await settled(writeKeychainCredentialAsync('/profile', 'the new login', security.options))).toEqual({
      error: 'Could not save the profile login in macOS Keychain',
    });
    expect(security.items.get(keychainService('/profile'))).toBe('the working login');
  });

  it('leaves no item where there was none', () => {
    const security = garbling();
    expect(() => writeKeychainCredential('/profile', 'the new login', security.options)).toThrow(
      'Could not save the profile login in macOS Keychain',
    );
    expect(security.items.has(keychainService('/profile'))).toBe(false);
  });
});

// The real program, on a Mac, with a throwaway item: the limit is macOS's, so
// only `security` itself can show it is not hit.
describe.runIf(process.platform === 'darwin')('the real `security`, with a throwaway login', () => {
  it('saves a long login whole and reads it back, blocking and off the thread', async () => {
    const dir = path.join(os.tmpdir(), `ccx-keychain-test-${process.pid}-${Date.now()}`);
    try {
      writeKeychainCredential(dir, '{"first":"a short login"}');
      expect(() => writeKeychainCredential(dir, longLogin)).not.toThrow();
      expect(readKeychainCredential(dir)).toBe(longLogin);
      const longer = longLogin.replace('"one"', '"five"');
      expect(await settled(writeKeychainCredentialAsync(dir, longer))).toEqual({ value: undefined });
      expect(await readKeychainCredentialAsync(dir)).toBe(longer);
    } finally {
      deleteKeychainCredential(dir);
    }
    expect(readKeychainCredential(dir)).toBeNull();
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
