import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SSH_FAILED, SSH_UNAVAILABLE } from '../remote/ssh.js';
import { lastLine, runRemote, runRemoteCcx } from './remote.js';

/**
 * ssh minus the network: prints the options it was given, drops them and the
 * host, and runs the command with sh as sshd would. A shell script, so these
 * run where a shell does.
 */
const FAKE_SSH = [
  '#!/bin/sh',
  'opts=""',
  'while [ "$1" = "-T" ] || [ "$1" = "-o" ]; do',
  '  if [ "$1" = "-o" ]; then opts="$opts $2"; shift; fi',
  '  shift',
  'done',
  'host="$1"',
  'shift',
  'if [ "$host" = unreachable ]; then echo "ssh: Could not resolve hostname $host" >&2; exit 255; fi',
  'if [ "$host" = options ]; then echo "$opts"; exit 0; fi',
  'SHELL=/bin/sh exec sh -c "$1"',
  '',
].join('\n');

describe.skipIf(process.platform === 'win32')('running a command on another machine, unattended', () => {
  let dir: string;
  let sshBin: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ccx-autoswitch-remote-'));
    sshBin = path.join(dir, 'ssh');
    writeFileSync(sshBin, FAKE_SSH, 'utf8');
    chmodSync(sshBin, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('never lets ssh stop to ask, and gives up on a host that does not answer', async () => {
    const result = await runRemote('options', 'true', { sshBin });
    expect(result.stdout.trim()).toBe('BatchMode=yes ConnectTimeout=8 ServerAliveInterval=15');
  });

  it('hands back what the command printed and how it exited', async () => {
    expect(await runRemote('server', 'echo out; echo err >&2; exit 3', { sshBin })).toEqual({
      exitCode: 3,
      stdout: 'out\n',
      stderr: 'err\n',
    });
  });

  it('runs ccx there with its arguments intact', async () => {
    const ccx = `"${process.execPath}" -e 'console.log(JSON.stringify(process.argv.slice(1)))'`;
    const result = await runRemoteCcx('server', ['autoswitch', 'apply', '--by', 'a b'], { sshBin, ccx });
    expect(JSON.parse(result.stdout.trim())).toEqual(['autoswitch', 'apply', '--by', 'a b']);
  });

  it('reports a host it could not reach as ssh does', async () => {
    const result = await runRemote('unreachable', 'true', { sshBin });
    expect(result.exitCode).toBe(SSH_FAILED);
    expect(result.stderr).toContain('Could not resolve hostname');
  });

  it('keeps a bounded amount of what the other machine prints', async () => {
    const flood = `"${process.execPath}" -e 'process.stdout.write("x".repeat(400000))'`;
    const result = await runRemote('server', flood, { sshBin });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    // One chunk may straddle the line; a megabyte never gets through.
    expect(result.stdout.length).toBeLessThan(200_000);
  });

  it('ends a command that hangs, rather than wait on it', async () => {
    const started = Date.now();
    // exec, so the process that is ended is the one sleeping and nothing is left behind.
    const result = await runRemote('server', 'exec sleep 30', { sshBin, timeoutMs: 300 });
    expect(result.exitCode).toBe(SSH_FAILED);
    expect(result.stderr).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('running a command on another machine', () => {
  it('says ssh could not start when there is none', async () => {
    const result = await runRemote('server', 'true', { sshBin: path.join(tmpdir(), 'no-such-ssh-anywhere') });
    expect(result.exitCode).toBe(SSH_UNAVAILABLE);
  });

  it('refuses a host ssh could read as an option, before anything runs', () => {
    expect(() => runRemote('-oProxyCommand=x', 'true')).toThrow('not a host ssh can be given safely');
  });
});

describe('the last line a command said', () => {
  it('skips blank lines and trims', () => {
    expect(lastLine('first\n  second  \n\n')).toBe('second');
    expect(lastLine('one\r\ntwo\r\n')).toBe('two');
    expect(lastLine('')).toBe('');
  });

  it('cannot move the cursor or recolour the terminal it is shown on', () => {
    expect(lastLine('ok\n\u001b[2J\u001b[31mnow on personal\u0007\n')).toBe('[2J[31mnow on personal');
    expect(lastLine('\u009b31mred')).toBe('31mred');
  });

  it('is cut to a line, however much the other machine sent', () => {
    const line = lastLine('x'.repeat(5_000));
    expect(line).toHaveLength(203);
    expect(line.endsWith('...')).toBe(true);
  });
});
