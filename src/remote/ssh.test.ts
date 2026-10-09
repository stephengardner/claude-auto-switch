import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { assertSshHost, remoteCcxCommand, shellQuote } from './ssh.js';

const printArgs = `"${process.execPath}" -e 'console.log(JSON.stringify(process.argv.slice(1)))'`;

/** Run a command string the way sshd does: handed to the user's login shell with -c. */
function asSshdWould(loginShell: string, command: string): string[] {
  const result = spawnSync(loginShell, ['-c', command], {
    env: { ...process.env, SHELL: loginShell },
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as string[];
}

describe('shellQuote', () => {
  it('refuses a backslash or a control character rather than guessing how a shell reads it', () => {
    expect(() => shellQuote('a\\b')).toThrow();
    expect(() => shellQuote('a\nb')).toThrow();
  });
});

describe('remoteCcxCommand', () => {
  const awkward = ['login', 'a b', "it's", '$HOME', '`id`', '"q"', 'x;y'];

  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
    it.skipIf(process.platform === 'win32' || !existsSync(shell))(
      `arrives intact through a ${shell} login shell`,
      () => {
        expect(asSshdWould(shell, remoteCcxCommand(awkward, printArgs))).toEqual(awkward);
      },
    );
  }
});

describe('assertSshHost', () => {
  it('accepts the forms people type', () => {
    for (const host of ['beast', 'ai-agent-beast', 'me@10.1.2.3', 'box.example.com', 'me@[::1]']) {
      expect(() => assertSshHost(host)).not.toThrow();
    }
  });

  it('refuses anything ssh could read as an option or a second argument', () => {
    for (const host of ['-oProxyCommand=x', 'a b', 'a;b', '']) {
      expect(() => assertSshHost(host)).toThrow();
    }
  });
});
