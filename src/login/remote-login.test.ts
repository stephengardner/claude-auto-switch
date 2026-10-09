import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HOST_CODE_BUDGET_MS, loginOnHost, type HostLoginDeps } from './remote-login.js';
import { RELAY_CODE_WAIT_MS, RELAY_URL_PREFIX } from './login.js';
import { loadConfig } from '../config/config.js';
import type { RemoteResult, RemoteRunner, RemoteSession } from '../remote/ssh.js';
import type { CliContext } from '../context.js';

/** The shape claude 2.1.295 prints, with its one-time values replaced. */
const LINK =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=user%3Ainference&code_challenge=c&code_challenge_method=S256&state=s1';

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
              ccxVersion: remote.version ?? '2.3.0',
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

  it('shows an Anthropic link that is not a Claude Code sign-in to the person instead of approving it', async () => {
    // A Console sign-in for another client, which approving would turn into API keys for the remote.
    const consoleSignIn =
      'https://platform.claude.com/oauth/authorize?client_id=someone-else&response_type=code' +
      '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key';
    const { c, lines } = context([{ name: 'a' }]);
    const remote = remoteWith({ remoteAccounts: [{ name: 'a', loggedIn: false }], link: consoleSignIn });
    let approverUsed = false;
    const asked: string[] = [];
    await loginOnHost(c, 'beast', 'a', {}, {
      browserReachable: () => Promise.resolve(true),
      approver: {
        approve: () => {
          approverUsed = true;
          return Promise.resolve({ outcome: 'authorized', code: 'x#y' });
        },
      },
      askCode: (url) => {
        asked.push(url);
        return Promise.resolve(null);
      },
      runner: fakeRunner(remote),
    });
    expect(approverUsed).toBe(false);
    expect(asked).toEqual([consoleSignIn]);
    expect(lines.join('\n')).toContain('not approved automatically');
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
    const remote = remoteWith({ version: '2.2.0', remoteAccounts: [{ name: 'a', loggedIn: false }] });
    const code = await loginOnHost(c, 'beast', 'a', {}, { ...browserApproves, runner: fakeRunner(remote) });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('2.2.0');
    expect(remote.started).toEqual([]);
  });

  it('reads the state past anything the remote login profile prints first', async () => {
    const { c } = context([{ name: 'a' }]);
    const state = JSON.stringify(
      { ccxVersion: '2.3.0', accounts: [{ name: 'a', loggedIn: false, enabled: true }] },
      null,
      2,
    );
    const remote = remoteWith({ state: { exitCode: 0, stdout: `Welcome to beast\n{not json\n${state}\n`, stderr: '' } });
    const code = await loginOnHost(c, 'beast', 'a', {}, { ...browserApproves, runner: fakeRunner(remote) });
    expect(code).toBe(0);
    expect(remote.started).toEqual([['login', 'a', '--relay']]);
  });

  it('says ssh is missing here, rather than ccx missing there', async () => {
    const { c, lines } = context([{ name: 'a' }]);
    const remote = remoteWith({ state: { exitCode: -1, stdout: '', stderr: 'Error: spawn ssh ENOENT' } });
    expect(await loginOnHost(c, 'beast', 'a', {}, { ...browserApproves, runner: fakeRunner(remote) })).toBe(1);
    expect(lines.join('\n')).toContain('could not run ssh on this machine');
    expect(lines.join('\n')).not.toContain('ccx was not found');
  });

  it('produces its code inside the time the other machine keeps listening', () => {
    // Pasting late would send the code to a relay that has already given up.
    expect(HOST_CODE_BUDGET_MS).toBeLessThan(RELAY_CODE_WAIT_MS - 30_000);
  });

  it('gives the person whatever time is left after the browser tried', async () => {
    const { c } = context([{ name: 'a' }]);
    const remote = remoteWith({ remoteAccounts: [{ name: 'a', loggedIn: false }] });
    const given: number[] = [];
    await loginOnHost(c, 'beast', 'a', {}, {
      browserReachable: () => Promise.resolve(true),
      approver: { approve: () => Promise.resolve({ outcome: 'left-open' }) },
      askCode: (_url, _who, timeoutMs) => {
        given.push(timeoutMs);
        return Promise.resolve('typed#code');
      },
      runner: fakeRunner(remote),
    });
    expect(given).toHaveLength(1);
    expect(given[0]).toBeGreaterThan(0);
    expect(given[0]).toBeLessThanOrEqual(HOST_CODE_BUDGET_MS);
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
