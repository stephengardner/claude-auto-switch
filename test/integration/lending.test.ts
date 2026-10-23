import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lendSyncCommand, lendImportCommand } from '../../src/commands/lend.js';
import { getAccount } from '../../src/accounts/registry.js';
import { refreshCredentialIfExpired } from '../../src/usage/oauth-refresh.js';
import { lendUnavailable, lentLoginIn } from '../../src/lending/lent-login.js';
import { shellQuote } from '../../src/util/shell-quote.js';
import {
  HOUR,
  contextOn,
  machine,
  ownLogin,
  writeConfig,
  type Machine,
} from '../lending-fixtures.js';

/**
 * `ccx lend sync` end to end: an owner with two logins, one due for renewal,
 * lends them to three receiving machines at once, one per transport. The token
 * endpoint is stubbed (nothing else is on the network); each receiver is a ccx
 * home of its own, and for the command and ssh transports the import runs in a
 * separate process, through the real CLI, exactly as a receiver would run it.
 */

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX_CLI = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CCX = path.join(REPO, 'src', 'cli.ts');
const posix = process.platform !== 'win32';

/** Runs the receiver's ccx (`lend import`) with its own home, handing it this process's standard input. */
function receiverProgram(dir: string): string {
  const script = path.join(dir, 'receiver.mjs');
  writeFileSync(
    script,
    [
      "import { spawnSync } from 'node:child_process';",
      'const [home, tsx, ccx] = process.argv.slice(2);',
      "const run = spawnSync(process.execPath, [tsx, ccx, 'lend', 'import'], {",
      "  stdio: 'inherit',",
      '  env: { ...process.env, CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home },',
      '});',
      'process.exit(run.status ?? 1);',
      '',
    ].join('\n'),
    'utf8',
  );
  return script;
}

/** Every file under `dir`, read as text. */
function everything(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory()
        ? everything(full)
        : entry.isFile()
          ? readFileSync(full, 'utf8')
          : '';
    })
    .join('\n');
}

describe('lending logins to other machines, end to end', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renews ahead, delivers through every transport, and leaves no refresh token on any receiver', async () => {
    // The token endpoint, as far as a renewal is concerned.
    const renewals: string[] = [];
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/v1/oauth/token'))
        return Promise.reject(new Error(`no network in tests: ${url}`));
      const { refresh_token: refresh } = JSON.parse(String(init?.body)) as {
        refresh_token: string;
      };
      renewals.push(refresh);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: `${refresh.replace(/^rt-/, 'at-')}-renewed`,
            refresh_token: `${refresh}-next`,
            expires_in: 28_800,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    });

    const owner = machine('cas-owner-');
    const ownerDirs = {
      a: ownLogin(owner, 'work-a', { expiresAt: Date.now() + HOUR }),
      b: ownLogin(owner, 'work-b', { expiresAt: Date.now() + 5 * HOUR }),
    };
    const byCommand = machine('cas-recv-cmd-');
    const byDirectory = machine('cas-recv-dir-');
    const bySsh = machine('cas-recv-ssh-');
    const drop = path.join(machine('cas-drop-').home, 'lends');
    const tools = machine('cas-tools-').home;

    const targets: unknown[] = [
      {
        name: 'build-box',
        transport: {
          type: 'command',
          run: [process.execPath, receiverProgram(tools), byCommand.home, TSX_CLI, CCX]
            .map((w) => `"${w}"`)
            .join(' '),
        },
        accounts: ['work-a', 'work-b'],
      },
      { name: 'shared-dir', transport: { type: 'directory', path: drop }, accounts: 'all' },
    ];
    if (posix) {
      // ssh minus the network: runs the command it is handed with sh, as sshd hands it to a login shell.
      const ssh = path.join(tools, 'ssh');
      writeFileSync(
        ssh,
        '#!/bin/sh\nfor last; do :; done\nSHELL=/bin/sh exec sh -c "$last"\n',
        'utf8',
      );
      chmodSync(ssh, 0o755);
      const remote = [process.execPath, TSX_CLI, CCX, 'lend', 'import'].map(shellQuote).join(' ');
      targets.push({
        name: 'over-ssh',
        transport: {
          type: 'ssh',
          host: 'me@build-2',
          remoteCommand: `CLAUDE_AUTO_SWITCH_HOME=${shellQuote(bySsh.home)} ${remote}`,
        },
        accounts: ['work-a'],
      });
    }
    writeConfig(owner, { lending: { renewAheadMinutes: 90, expiryMarginMinutes: 10, targets } });

    const o = contextOn(owner);
    const sshBin = posix ? path.join(tools, 'ssh') : undefined;
    const code = await lendSyncCommand(o.context, {}, { transport: sshBin ? { sshBin } : {} });
    expect(o.out.join('\n')).not.toMatch(/not (sent|delivered)/);
    expect(code).toBe(0);

    // One renewal, of the login that was due, through the real renewal code; the owner keeps the refresh token.
    expect(renewals).toEqual(['rt-work-a-1']);
    const ownerA = JSON.parse(
      readFileSync(path.join(ownerDirs.a, '.credentials.json'), 'utf8'),
    ) as {
      claudeAiOauth: Record<string, unknown>;
    };
    expect(ownerA.claudeAiOauth.refreshToken).toBe('rt-work-a-1-next');

    // The directory receiver imports what was dropped for it, through the same command.
    const d = contextOn(byDirectory);
    for (const file of readdirSync(drop)) {
      expect(await lendImportCommand(d.context, path.join(drop, file))).toBe(0);
    }

    const receivers: Array<[Machine, string[]]> = [
      [byCommand, ['work-a', 'work-b']],
      [byDirectory, ['work-a', 'work-b']],
      ...(posix ? ([[bySsh, ['work-a']]] as Array<[Machine, string[]]>) : []),
    ];
    for (const [receiver, names] of receivers) {
      for (const name of names) {
        const dir = getAccount(name, receiver.ctx)?.dir ?? '';
        const lent = lentLoginIn(dir);
        expect(lent, `${name} on ${receiver.home}`).not.toBeNull();
        const stored = JSON.parse(readFileSync(path.join(dir, '.credentials.json'), 'utf8')) as {
          claudeAiOauth: Record<string, unknown>;
        };
        expect(stored.claudeAiOauth.accessToken).toBe(
          name === 'work-a' ? 'at-work-a-1-renewed' : 'at-work-b-1',
        );
        if (posix) expect(statSync(path.join(dir, '.credentials.json')).mode & 0o777).toBe(0o600);

        // The receiver can never renew it: nothing is sent, even once it has expired.
        let sent = 0;
        const counting = (async () => {
          sent += 1;
          return new Response('{}');
        }) as unknown as typeof fetch;
        const later = (lent?.expiresAt ?? 0) + HOUR;
        const outcome = await refreshCredentialIfExpired(dir, {
          fetchImpl: counting,
          now: () => later,
          ctx: receiver.ctx,
        });
        expect(outcome.status).toBe('lent');
        expect(sent).toBe(0);
        expect(lendUnavailable(dir, receiver.ctx)).toBe(false);
        expect(lendUnavailable(dir, receiver.ctx, later)).toBe(true);
      }
      // No refresh token of the owner's, renewed or not, anywhere on the receiver.
      expect(everything(receiver.home)).not.toMatch(/rt-work-[ab]-1/);
    }
    expect(everything(drop)).not.toMatch(/rt-work|refresh/i);

    // Run again, as cron would: nothing is due, and every receiver already has what it is sent.
    const again = contextOn(owner);
    expect(await lendSyncCommand(again.context, {}, { transport: sshBin ? { sshBin } : {} })).toBe(
      0,
    );
    expect(renewals).toEqual(['rt-work-a-1']);
    expect(again.out.join('\n')).toMatch(
      /sent "work-a" to build-box \(command .+\): lent "work-a" is already up to date/,
    );
  }, 120_000);
});
