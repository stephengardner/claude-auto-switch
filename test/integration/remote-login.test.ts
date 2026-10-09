import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginOnHost } from '../../src/login/remote-login.js';
import { relayLogin, RELAY_URL_PREFIX } from '../../src/login/login.js';
import { spawnAuthLogin } from '../../src/login/login-process.js';
import { credentialFingerprint } from '../../src/accounts/credential-vault.js';
import { sshRunner } from '../../src/remote/ssh.js';
import { shellQuote } from '../../src/util/shell-quote.js';
import { loadConfig } from '../../src/config/config.js';
import type { CliContext } from '../../src/context.js';

/**
 * `ccx login --host` across real processes: a real ssh runner talking to a
 * stand-in for ssh, which runs a stand-in for the remote ccx through `sh`
 * exactly as sshd hands a command to a login shell. And the remote half for
 * real: the relay driving a stand-in for `claude auth login` through a pipe.
 * POSIX only, because the stand-in for ssh is a shell script.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_REMOTE = path.join(HERE, '..', 'fake-remote', 'fake-remote-ccx.mjs');
const FAKE_CLAUDE_PASTE = path.join(HERE, '..', 'fake-remote', 'fake-claude-paste.mjs');
const remoteCcx = `${shellQuote(process.execPath)} ${shellQuote(FAKE_REMOTE)}`;

/** ssh minus the network: drops -T and the host, runs the command with sh as sshd would. */
const FAKE_SSH = [
  '#!/bin/sh',
  'shift',
  'host="$1"',
  'shift',
  'if [ "$host" = unreachable ]; then',
  '  echo "ssh: Could not resolve hostname $host" >&2',
  '  exit 255',
  'fi',
  'SHELL=/bin/sh exec sh -c "$1"',
  '',
].join('\n');

const posixOnly = process.platform === 'win32';

describe.skipIf(posixOnly)('ccx login --host, across real processes', () => {
  let dir: string;
  let sshBin: string;
  let log: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cas-host-'));
    sshBin = path.join(dir, 'ssh');
    writeFileSync(sshBin, FAKE_SSH, 'utf8');
    chmodSync(sshBin, 0o755);
    log = path.join(dir, 'remote.log');
    for (const name of ['FAKE_REMOTE_STATE', 'FAKE_REMOTE_LOG', 'FAKE_REMOTE_LINK']) saved[name] = process.env[name];
    process.env.FAKE_REMOTE_LOG = log;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** This machine: its own ccx home holding `accounts`. */
  function context(accounts: Array<{ name: string; email?: string }>) {
    const home = path.join(dir, 'local');
    mkdirSync(home, { recursive: true });
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home } };
    writeFileSync(
      path.join(home, 'accounts.json'),
      JSON.stringify({
        accounts: accounts.map((a, i) => ({ ...a, dir: path.join(home, 'profiles', a.name), priority: i, enabled: true })),
      }),
    );
    const lines: string[] = [];
    const c = {
      ctx,
      config: loadConfig(ctx),
      out: (m: string) => lines.push(m),
      json: false,
      quiet: false,
    } as CliContext;
    return { c, lines };
  }

  const remoteLog = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  it('registers, relays and hands back a code for every account not signed in there', async () => {
    process.env.FAKE_REMOTE_STATE = JSON.stringify({
      ccxVersion: '2.3.0',
      accounts: [
        { name: 'work', email: 'work@example.com', loggedIn: false, enabled: true },
        { name: 'done', loggedIn: true, enabled: true },
      ],
    });
    const { c } = context([{ name: 'home', email: 'home@example.com' }]);

    const code = await loginOnHost(c, 'beast', undefined, { all: true }, {
      runner: sshRunner('beast', { ccx: remoteCcx, sshBin }),
      browserReachable: () => Promise.resolve(false),
      askCode: () => Promise.resolve('the-code#the-state'),
    });

    expect(code).toBe(0);
    const entries = remoteLog();
    expect(entries).toContainEqual({ args: ['add', 'home', '--email', 'home@example.com', '--no-login'] });
    expect(entries.filter((e) => 'code' in e)).toEqual([
      { account: 'home', code: 'the-code#the-state' },
      { account: 'work', code: 'the-code#the-state' },
    ]);
  });

  it('closes the remote input when there is no code, and the remote stops at once', async () => {
    process.env.FAKE_REMOTE_STATE = JSON.stringify({
      ccxVersion: '2.3.0',
      accounts: [{ name: 'work', loggedIn: false, enabled: true }],
    });
    const { c } = context([]);
    const started = Date.now();
    const code = await loginOnHost(c, 'beast', 'work', {}, {
      runner: sshRunner('beast', { ccx: remoteCcx, sshBin }),
      browserReachable: () => Promise.resolve(false),
      askCode: () => Promise.resolve(null),
    });
    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(remoteLog().filter((e) => 'code' in e)).toEqual([{ account: 'work', code: null }]);
  });

  it('never sends a code for a link that is not Anthropic', async () => {
    process.env.FAKE_REMOTE_STATE = JSON.stringify({
      ccxVersion: '2.3.0',
      accounts: [{ name: 'work', loggedIn: false, enabled: true }],
    });
    process.env.FAKE_REMOTE_LINK = 'https://evil.example/authorize';
    const { c, lines } = context([]);
    const code = await loginOnHost(c, 'beast', 'work', {}, {
      runner: sshRunner('beast', { ccx: remoteCcx, sshBin }),
      browserReachable: () => Promise.resolve(false),
      askCode: () => Promise.resolve('should#never-go'),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('not Anthropic');
    expect(remoteLog().filter((e) => 'code' in e)).toEqual([{ account: 'work', code: null }]);
  });

  it('says ccx is missing there when the login shell cannot find it', async () => {
    const { c, lines } = context([{ name: 'a' }]);
    const code = await loginOnHost(c, 'beast', 'a', {}, {
      runner: sshRunner('beast', { ccx: 'ccx-not-installed-anywhere', sshBin }),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('ccx was not found on beast');
  });

  it('reports a machine ssh cannot reach', async () => {
    const { c, lines } = context([{ name: 'a' }]);
    const code = await loginOnHost(c, 'unreachable', 'a', {}, {
      runner: sshRunner('unreachable', { ccx: remoteCcx, sshBin }),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Could not resolve hostname');
  });
});

describe.skipIf(posixOnly)('the remote half: relaying one sign-in into claude', () => {
  const claude = { bin: process.execPath, prefixArgs: [FAKE_CLAUDE_PASTE] };

  it('passes the code to the paste prompt and ends with a stored login', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-relay-'));
    const sent: string[] = [];
    const result = await relayLogin(
      { name: 'acct', dir },
      {
        claude,
        startAuthLogin: spawnAuthLogin,
        send: (line) => sent.push(line),
        receiveCode: () => Promise.resolve('abc#xyz'),
      },
    );
    expect(result).toMatchObject({ ok: true });
    expect(sent).toEqual([`${RELAY_URL_PREFIX}https://claude.com/cai/oauth/authorize?fake=1`]);
    expect(credentialFingerprint(dir)).not.toBeNull();
  }, 20_000);

  it('stores nothing when the code is refused, and passes on why', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-relay-'));
    const result = await relayLogin(
      { name: 'acct', dir },
      {
        claude,
        startAuthLogin: spawnAuthLogin,
        send: () => {},
        receiveCode: () => Promise.resolve('bad-code#state'),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('claude said: OAuth error: invalid_grant');
    expect(credentialFingerprint(dir)).toBeNull();
  }, 20_000);
});
