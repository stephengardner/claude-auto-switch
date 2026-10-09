import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loginOnHost, type HostLoginDeps } from './remote-login.js';
import { RELAY_URL_PREFIX } from './login.js';
import { loadConfig } from '../config/config.js';
import type { RemoteResult, RemoteRunner, RemoteSession } from '../remote/ssh.js';
import type { CliContext } from '../context.js';

const LINK = 'https://claude.com/cai/oauth/authorize?code=true&state=s1';

function context(localAccounts: Array<{ name: string; email?: string; enabled?: boolean }>) {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-remote-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  writeFileSync(
    path.join(home, 'accounts.json'),
    JSON.stringify({
      accounts: localAccounts.map((a, i) => ({
        name: a.name,
        dir: path.join(home, 'profiles', a.name),
        priority: i,
        enabled: a.enabled ?? true,
        ...(a.email ? { email: a.email } : {}),
      })),
    }),
    'utf8',
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

interface FakeRemote {
  state?: RemoteResult;
  remoteAccounts?: Array<{ name: string; email?: string; loggedIn: boolean; enabled?: boolean }>;
  version?: string;
  /** The link each relayed sign-in sends; defaults to a real Anthropic one. */
  link?: string;
  ran: string[][];
  started: string[][];
  sent: string[];
}

/** Stands in for ssh plus the remote ccx: answers `state` and `add`, relays each `login --relay`. */
function fakeRunner(remote: FakeRemote): RemoteRunner {
  return {
    run(args) {
      remote.ran.push(args);
      if (args[0] === 'state') {
        return Promise.resolve(
          remote.state ?? {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              ccxVersion: remote.version ?? '2.2.0',
              accounts: (remote.remoteAccounts ?? []).map((a) => ({ enabled: true, ...a })),
            }),
          },
        );
      }
      return Promise.resolve({ exitCode: 0, stdout: `registered "${args[1]}"`, stderr: '' });
    },
    start(args): RemoteSession {
      remote.started.push(args);
      let ended: () => void = () => {};
      const endedPromise = new Promise<void>((resolve) => (ended = resolve));
      let gotCode = false;
      async function* lines() {
        yield `logging in "${args[1]}"...`;
        yield `${RELAY_URL_PREFIX}${remote.link ?? LINK}`;
        await endedPromise;
        yield gotCode ? '  ok: logged in (relayed)' : '  FAILED: no code arrived';
      }
      return {
        lines: lines(),
        send: (line) => {
          remote.sent.push(line);
          gotCode = true;
        },
        end: () => ended(),
        done: () => endedPromise.then(() => (gotCode ? 0 : 1)),
      };
    },
  };
}

function remoteWith(partial: Partial<FakeRemote> = {}): FakeRemote {
  return { ran: [], started: [], sent: [], ...partial };
}

const browserApproves: HostLoginDeps = {
  browserReachable: () => Promise.resolve(true),
  approver: { approve: () => Promise.resolve({ outcome: 'authorized', code: 'c0de#s1' }) },
  askCode: () => Promise.reject(new Error('should not ask')),
};

describe('ccx login --host', () => {
  it('registers what is missing there, then relays each account that is not signed in', async () => {
    const { c } = context([
      { name: 'work', email: 'work@example.com' },
      { name: 'home', email: 'home@example.com' },
    ]);
    const remote = remoteWith({
      remoteAccounts: [
        { name: 'work', email: 'work@example.com', loggedIn: true },
        { name: 'spare', loggedIn: false },
      ],
    });

    const code = await loginOnHost(c, 'beast', undefined, { all: true }, {
      ...browserApproves,
      runner: fakeRunner(remote),
    });

    expect(code).toBe(0);
    // Only the name and address go across, never a login.
    expect(remote.ran).toContainEqual(['add', 'home', '--email', 'home@example.com', '--no-login']);
    expect(remote.started).toEqual([
      ['login', 'home', '--relay'],
      ['login', 'spare', '--relay'],
    ]);
    expect(remote.sent).toEqual(['c0de#s1', 'c0de#s1']);
  });

  it('never opens a link that is not Anthropic, and sends nothing back', async () => {
    const { c, lines } = context([{ name: 'a' }]);
    const remote = remoteWith({
      remoteAccounts: [{ name: 'a', loggedIn: false }],
      link: 'https://evil.example/oauth/authorize',
    });
    let approverUsed = false;
    const code = await loginOnHost(c, 'beast', 'a', {}, {
      browserReachable: () => Promise.resolve(true),
      approver: {
        approve: () => {
          approverUsed = true;
          return Promise.resolve({ outcome: 'authorized', code: 'x#y' });
        },
      },
      askCode: () => Promise.reject(new Error('should not ask')),
      runner: fakeRunner(remote),
    });

    expect(code).toBe(1);
    expect(approverUsed).toBe(false);
    expect(remote.sent).toEqual([]);
    expect(lines.join('\n')).toContain('not Anthropic');
  });

  it('asks the person for the code when no browser here can be driven', async () => {
    const { c } = context([{ name: 'a', email: 'a@example.com' }]);
    const remote = remoteWith({ remoteAccounts: [{ name: 'a', email: 'a@example.com', loggedIn: false }] });
    const asked: Array<[string, string]> = [];
    const code = await loginOnHost(c, 'beast', 'a', {}, {
      browserReachable: () => Promise.resolve(false),
      approver: { approve: () => Promise.reject(new Error('should not drive a browser')) },
      askCode: (url, who) => {
        asked.push([url, who]);
        return Promise.resolve('typed#code');
      },
      runner: fakeRunner(remote),
    });

    expect(code).toBe(0);
    expect(asked).toEqual([[LINK, 'a@example.com']]);
    expect(remote.sent).toEqual(['typed#code']);
  });

  it('falls back to asking when the browser could not finish on its own', async () => {
    const { c } = context([{ name: 'a' }]);
    const remote = remoteWith({ remoteAccounts: [{ name: 'a', loggedIn: false }] });
    const code = await loginOnHost(c, 'beast', 'a', {}, {
      browserReachable: () => Promise.resolve(true),
      approver: { approve: () => Promise.resolve({ outcome: 'left-open' }) },
      askCode: () => Promise.resolve('typed#code'),
      runner: fakeRunner(remote),
    });
    expect(code).toBe(0);
    expect(remote.sent).toEqual(['typed#code']);
  });

  it('closes the remote input when no code was given, so it stops at once', async () => {
    const { c } = context([{ name: 'a' }]);
    const remote = remoteWith({ remoteAccounts: [{ name: 'a', loggedIn: false }] });
    const code = await loginOnHost(c, 'beast', 'a', {}, {
      browserReachable: () => Promise.resolve(false),
      askCode: () => Promise.resolve(null),
      runner: fakeRunner(remote),
    });
    expect(code).toBe(1);
    expect(remote.sent).toEqual([]);
  });

  it('says how to fix it when ccx is not on the other machine', async () => {
    const { c, lines } = context([{ name: 'a' }]);
    const remote = remoteWith({
      state: { exitCode: 127, stdout: '', stderr: 'bash: line 1: ccx: command not found' },
    });
    const code = await loginOnHost(c, 'beast', 'a', {}, { ...browserApproves, runner: fakeRunner(remote) });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('npm install -g claude-auto-switch');
    expect(lines.join('\n')).toContain('--remote-ccx');
    expect(remote.started).toEqual([]);
  });

  it('asks for an update when ccx there is too old to relay', async () => {
    const { c, lines } = context([{ name: 'a' }]);
    const remote = remoteWith({ version: '2.1.3', remoteAccounts: [{ name: 'a', loggedIn: false }] });
    const code = await loginOnHost(c, 'beast', 'a', {}, { ...browserApproves, runner: fakeRunner(remote) });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('2.1.3');
    expect(remote.started).toEqual([]);
  });

  it('reports a machine ssh cannot reach', async () => {
    const { c, lines } = context([{ name: 'a' }]);
    const remote = remoteWith({
      state: { exitCode: 255, stdout: '', stderr: 'ssh: Could not resolve hostname beast' },
    });
    expect(await loginOnHost(c, 'beast', 'a', {}, { ...browserApproves, runner: fakeRunner(remote) })).toBe(1);
    expect(lines.join('\n')).toContain('Could not resolve hostname');
  });

  it('refuses a name neither machine knows', async () => {
    const { c, lines } = context([{ name: 'a' }]);
    const remote = remoteWith({ remoteAccounts: [{ name: 'b', loggedIn: false }] });
    expect(await loginOnHost(c, 'beast', 'nope', {}, { ...browserApproves, runner: fakeRunner(remote) })).toBe(1);
    expect(lines.join('\n')).toContain('no account named "nope"');
  });

  it('has nothing to do when every account there is signed in', async () => {
    const { c, lines } = context([{ name: 'a' }]);
    const remote = remoteWith({ remoteAccounts: [{ name: 'a', loggedIn: true }] });
    expect(await loginOnHost(c, 'beast', undefined, { all: true }, { ...browserApproves, runner: fakeRunner(remote) })).toBe(0);
    expect(remote.started).toEqual([]);
    expect(lines.join('\n')).toContain('already signed in');
  });

  it('refuses a host ssh could read as an option', async () => {
    const { c } = context([{ name: 'a' }]);
    expect(await loginOnHost(c, '-oProxyCommand=x', 'a', {}, browserApproves)).toBe(1);
  });
});
