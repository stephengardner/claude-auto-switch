import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  lendExportCommand,
  lendImportCommand,
  lendRevokeCommand,
  lendStatusCommand,
  lendSyncCommand,
  renewCommand,
} from './lend.js';
import { getAccount } from '../accounts/registry.js';
import { CREDENTIALS_LOCK_DIR } from '../claude/locks.js';
import { releaseLease, takeLease } from '../session/lease.js';
import { forgetRefusals } from '../usage/dead-login-memo.js';
import { lentLoginIn } from '../lending/lent-login.js';
import {
  HOUR,
  MINUTE,
  contextOn,
  machine,
  ownLogin,
  writeConfig,
  type Machine,
} from '../../test/lending-fixtures.js';

const NOW = 1_800_000_000_000;
const now = () => NOW;
const posix = process.platform !== 'win32';

/** The token endpoint: renews whatever it is asked to, and counts what it is sent. */
function tokenEndpoint(): { fetchImpl: typeof fetch; sent: string[] } {
  const sent: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { refresh_token: string };
    sent.push(body.refresh_token);
    return new Response(
      JSON.stringify({
        access_token: `${body.refresh_token.replace(/^rt-/, 'at-')}-renewed`,
        refresh_token: `${body.refresh_token}-next`,
        expires_in: 8 * 3600,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function dirTarget(
  name: string,
  folder: string,
  accounts: unknown,
  extra: Record<string, unknown> = {},
) {
  return { name, transport: { type: 'directory', path: folder }, accounts, ...extra };
}

/** Everything a command printed, both streams, for checking that no token is in any of it. */
const said = (c: { out: string[]; err: string[] }): string => [...c.out, ...c.err].join('\n');

beforeEach(() => forgetRefusals());

describe('ccx lend export', () => {
  it('will not print a live token to a terminal unless told to', async () => {
    const m = machine();
    ownLogin(m, 'work', { expiresAt: NOW + 6 * HOUR });
    const c = contextOn(m);
    expect(await lendExportCommand(c.context, 'work', {}, { now, stdoutIsTTY: true })).toBe(1);
    expect(c.out).toEqual([]);
    expect(c.err.join('\n')).toMatch(/standard output is a terminal/);

    expect(
      await lendExportCommand(c.context, 'work', { force: true }, { now, stdoutIsTTY: true }),
    ).toBe(0);
    expect(JSON.parse(c.out.join('\n'))).toMatchObject({
      format: 'ccx-lend',
      kind: 'lend',
      account: 'work',
    });
  });

  it('prints only the bundle to a pipe, without the refresh token, and its own words to standard error', async () => {
    const m = machine();
    ownLogin(m, 'work', { expiresAt: NOW + 6 * HOUR });
    const c = contextOn(m);
    expect(await lendExportCommand(c.context, 'work', {}, { now, stdoutIsTTY: false })).toBe(0);
    const bundle = JSON.parse(c.out.join('\n')) as { claudeAiOauth: Record<string, unknown> };
    expect(bundle.claudeAiOauth.accessToken).toBe('at-work-1');
    expect(c.out.join('\n')).not.toContain('rt-work-1');
    expect(c.err).toEqual([expect.stringMatching(/^lent "work", until .+ \(6h left\)$/)]);
  });

  it('writes an owner-only file with --out', async () => {
    const m = machine();
    ownLogin(m, 'work', { expiresAt: NOW + 6 * HOUR });
    const c = contextOn(m);
    const file = path.join(m.home, 'out', 'work.json');
    expect(
      await lendExportCommand(c.context, 'work', { out: file }, { now, stdoutIsTTY: true }),
    ).toBe(0);
    expect(c.out).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('"accessToken": "at-work-1"');
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('says when what it lends has little time left, and how to give it more', async () => {
    const m = machine();
    ownLogin(m, 'work', { expiresAt: NOW + 30 * MINUTE });
    const c = contextOn(m);
    await lendExportCommand(c.context, 'work', {}, { now, stdoutIsTTY: false });
    expect(c.err.join('\n')).toMatch(/ccx renew work first/);
  });

  it('refuses an account it cannot lend, naming it and nothing secret', async () => {
    const m = machine();
    const c = contextOn(m);
    expect(await lendExportCommand(c.context, 'nobody', {}, { now, stdoutIsTTY: false })).toBe(1);
    ownLogin(m, 'stale', { expiresAt: NOW - MINUTE });
    expect(await lendExportCommand(c.context, 'stale', {}, { now, stdoutIsTTY: false })).toBe(1);
    expect(c.err.join('\n')).toMatch(/not exported: "stale": its stored token has expired/);
    expect(said(c)).not.toContain('at-stale-1');
  });
});

describe('ccx lend import', () => {
  async function exported(m: Machine, name: string): Promise<string> {
    const c = contextOn(m);
    await lendExportCommand(c.context, name, {}, { now, stdoutIsTTY: false });
    return c.out.join('\n');
  }

  it('installs a lend from standard input, and refuses to wait on a terminal', async () => {
    const owner = machine();
    ownLogin(owner, 'work', { expiresAt: NOW + 6 * HOUR });
    const receiver = machine('cas-recv-');
    const r = contextOn(receiver);
    expect(await lendImportCommand(r.context, undefined, {}, { now, stdinIsTTY: true })).toBe(1);
    expect(r.out.pop()).toMatch(/^nothing to import: pipe a bundle in/);
    const text = await exported(owner, 'work');
    expect(
      await lendImportCommand(
        r.context,
        undefined,
        {},
        { now, stdinIsTTY: false, readStdin: async () => text },
      ),
    ).toBe(0);
    expect(r.out).toEqual([expect.stringMatching(/^lent "work" installed, until .+ \(6h left\)$/)]);
    expect(lentLoginIn(getAccount('work', receiver.ctx)?.dir ?? '')).toEqual({
      expiresAt: NOW + 6 * HOUR,
    });
  });

  it('installs from a file, under another name when told to', async () => {
    const owner = machine();
    ownLogin(owner, 'work', { expiresAt: NOW + 6 * HOUR });
    const file = path.join(owner.home, 'work.json');
    writeFileSync(file, await exported(owner, 'work'));
    const receiver = machine('cas-recv-');
    const r = contextOn(receiver);
    expect(await lendImportCommand(r.context, file, { as: 'build-work' }, { now })).toBe(0);
    expect(r.out[0]).toMatch(/^lent "build-work" installed/);
  });

  it('refuses a bundle carrying a refresh token, and does not repeat what it was sent', async () => {
    const receiver = machine('cas-recv-');
    const r = contextOn(receiver);
    const tampered = JSON.stringify({
      format: 'ccx-lend',
      version: 1,
      kind: 'lend',
      account: 'work',
      issuedAt: NOW,
      claudeAiOauth: { accessToken: 'at-sneaky', refreshToken: 'rt-sneaky', expiresAt: NOW + HOUR },
    });
    expect(
      await lendImportCommand(
        r.context,
        undefined,
        {},
        { now, stdinIsTTY: false, readStdin: async () => tampered },
      ),
    ).toBe(1);
    expect(r.out.join('\n')).toMatch(/not imported: this bundle carries a refresh token/);
    expect(said(r)).not.toMatch(/sneaky/);
    expect(getAccount('work', receiver.ctx)).toBeUndefined();
  });

  it('says when what it installed is already inside the margin', async () => {
    const owner = machine();
    ownLogin(owner, 'work', { expiresAt: NOW + 5 * MINUTE });
    const text = await exported(owner, 'work');
    const r = contextOn(machine('cas-recv-'));
    expect(
      await lendImportCommand(
        r.context,
        undefined,
        {},
        { now, stdinIsTTY: false, readStdin: async () => text },
      ),
    ).toBe(0);
    expect(r.out[1]).toMatch(/inside this machine's 10m margin/);
  });
});

describe('ccx renew', () => {
  it('renews only when less than --ahead is left, unless forced', async () => {
    const m = machine();
    ownLogin(m, 'work', { expiresAt: NOW + 3 * HOUR });
    const endpoint = tokenEndpoint();
    const c = contextOn(m);
    expect(
      await renewCommand(
        c.context,
        'work',
        { ahead: '2h' },
        { now, refresh: { fetchImpl: endpoint.fetchImpl } },
      ),
    ).toBe(0);
    expect(c.out.pop()).toMatch(
      /"work" was not renewed: it has 3h left, more than 2h \(--force renews it anyway\)/,
    );
    expect(endpoint.sent).toEqual([]);
    expect(
      await renewCommand(
        c.context,
        'work',
        { ahead: '4h' },
        { now, refresh: { fetchImpl: endpoint.fetchImpl } },
      ),
    ).toBe(0);
    expect(c.out.pop()).toMatch(/^renewed "work", until .+ \(8h left\)$/);
    expect(endpoint.sent).toEqual(['rt-work-1']);
    expect(
      await renewCommand(
        c.context,
        'work',
        { force: true },
        { now, refresh: { fetchImpl: endpoint.fetchImpl } },
      ),
    ).toBe(0);
    expect(endpoint.sent).toEqual(['rt-work-1', 'rt-work-1-next']);
  });

  it('refuses an --ahead it cannot read, and says why a renewal did not happen', async () => {
    const m = machine();
    ownLogin(m, 'work', { expiresAt: NOW + HOUR });
    const c = contextOn(m);
    expect(await renewCommand(c.context, 'work', { ahead: 'soon' }, { now })).toBe(1);
    expect(c.out.pop()).toMatch(/--ahead takes a length of time/);
    takeLease('work', path.join(m.home, 'sessions', 'x'), m.ctx);
    try {
      expect(
        await renewCommand(
          c.context,
          'work',
          {},
          { now, refresh: { fetchImpl: tokenEndpoint().fetchImpl } },
        ),
      ).toBe(1);
      expect(c.out.pop()).toMatch(/"work" was not renewed: not renewed: a session is using work/);
    } finally {
      releaseLease('work', m.ctx);
    }
  });
});

describe('ccx lend sync', () => {
  function owner(
    targets: unknown[],
    logins: Record<string, number>,
  ): { m: Machine; dirs: Record<string, string> } {
    const m = machine();
    const dirs: Record<string, string> = {};
    for (const [name, expiresAt] of Object.entries(logins))
      dirs[name] = ownLogin(m, name, { expiresAt });
    writeConfig(m, { lending: { renewAheadMinutes: 90, expiryMarginMinutes: 10, targets } });
    return { m, dirs };
  }

  it('is off, and says so, until config.json has targets', async () => {
    const c = contextOn(machine());
    expect(await lendSyncCommand(c.context, {}, { now })).toBe(1);
    expect(c.out).toEqual([
      'lending is off: config.json has no lending targets (see docs/lending.md)',
    ]);
  });

  it('renews each login once however many targets lend it, then sends each target a fresh lend', async () => {
    const drop = machine('cas-drop-').home;
    const { m } = owner(
      [
        dirTarget('one', path.join(drop, 'one'), ['work']),
        dirTarget('two', path.join(drop, 'two'), 'all'),
      ],
      { work: NOW + HOUR },
    );
    const endpoint = tokenEndpoint();
    const c = contextOn(m);
    expect(
      await lendSyncCommand(c.context, {}, { now, refresh: { fetchImpl: endpoint.fetchImpl } }),
    ).toBe(0);
    expect(endpoint.sent).toEqual(['rt-work-1']);
    for (const target of ['one', 'two']) {
      const sent = readFileSync(path.join(drop, target, 'work.json'), 'utf8');
      expect(sent).toContain('"accessToken": "at-work-1-renewed"');
      expect(sent).not.toMatch(/refresh/i);
      expect(sent).not.toContain('rt-work-1-next');
    }
    expect(said(c)).not.toContain('at-work-1-renewed');

    // Again straight away: nothing to renew, and the same lend sent again.
    expect(
      await lendSyncCommand(c.context, {}, { now, refresh: { fetchImpl: endpoint.fetchImpl } }),
    ).toBe(0);
    expect(endpoint.sent).toEqual(['rt-work-1']);
  });

  it('says what it would do on a dry run, renewing and sending nothing, and printing no token', async () => {
    const drop = path.join(machine('cas-drop-').home, 'lends');
    const { m } = owner([dirTarget('drop', drop, ['soon', 'later'])], {
      soon: NOW + HOUR,
      later: NOW + 5 * HOUR,
    });
    const endpoint = tokenEndpoint();
    const c = contextOn(m, { quiet: true });
    expect(
      await lendSyncCommand(
        c.context,
        { dryRun: true },
        { now, refresh: { fetchImpl: endpoint.fetchImpl } },
      ),
    ).toBe(0);
    expect(c.out).toEqual([
      'would renew "soon" (1h left, under 1h 30m)',
      'would send "soon" to drop (directory ' + drop + ') once renewed',
      expect.stringMatching(/^would send "later" to drop \(directory .+\), until .+ \(5h left\)$/),
      'dry run: nothing was renewed or sent',
    ]);
    expect(endpoint.sent).toEqual([]);
    expect(existsSync(drop)).toBe(false);
    expect(said(c)).not.toMatch(/at-soon|at-later|rt-/);
  });

  it('goes on to the other targets when one cannot be reached, and exits non-zero', async () => {
    const drop = machine('cas-drop-').home;
    const failing = `"${process.execPath}" -e "process.stderr.write('upload service down'); process.exit(2)"`;
    const { m } = owner(
      [
        { name: 'broken', transport: { type: 'command', run: failing }, accounts: ['work'] },
        dirTarget('fine', path.join(drop, 'fine'), ['work']),
      ],
      { work: NOW + 5 * HOUR },
    );
    const c = contextOn(m);
    expect(await lendSyncCommand(c.context, {}, { now })).toBe(1);
    expect(c.out.join('\n')).toMatch(
      /broken: "work" was not delivered: .* failed \(exit 2\): upload service down/,
    );
    expect(existsSync(path.join(drop, 'fine', 'work.json'))).toBe(true);
  });

  it('lends whichever accounts it can under all, but a listed one that cannot be lent is a failure', async () => {
    const drop = machine('cas-drop-').home;
    const { m, dirs } = owner(
      [
        dirTarget('everything', path.join(drop, 'all'), 'all'),
        dirTarget('listed', path.join(drop, 'listed'), ['work', 'gone']),
      ],
      { work: NOW + 5 * HOUR, out: NOW + 5 * HOUR },
    );
    writeFileSync(
      path.join(dirs.out!, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } }),
    );
    const c = contextOn(m);
    expect(await lendSyncCommand(c.context, {}, { now })).toBe(1);
    const lines = c.out.join('\n');
    expect(lines).toMatch(/everything: "out" skipped: "out" is not signed in here/);
    expect(lines).toMatch(/listed: "gone" is not an account here, so it was not sent/);
    expect(readdirSync(path.join(drop, 'all'))).toEqual(['work.json']);
  });

  it('sends nothing that would arrive inside the margin, when it could not be renewed', async () => {
    const drop = machine('cas-drop-').home;
    const { m, dirs } = owner([dirTarget('drop', path.join(drop, 'lends'), ['work'])], {
      work: NOW + 5 * MINUTE,
    });
    // Something else is renewing it, and goes on doing so.
    mkdirSync(path.join(dirs.work!, CREDENTIALS_LOCK_DIR));
    const c = contextOn(m);
    expect(
      await lendSyncCommand(
        c.context,
        {},
        { now, refresh: { fetchImpl: tokenEndpoint().fetchImpl } },
      ),
    ).toBe(1);
    expect(c.out.join('\n')).toMatch(
      /drop: "work" was not sent: it has 5m left, inside the target's 10m margin/,
    );
    expect(existsSync(path.join(drop, 'lends'))).toBe(false);
  });

  it('keeps quiet about what went well with --quiet, and still says what did not', async () => {
    const drop = machine('cas-drop-').home;
    const { m } = owner([dirTarget('drop', path.join(drop, 'lends'), ['work', 'gone'])], {
      work: NOW + 5 * HOUR,
    });
    const c = contextOn(m, { quiet: true });
    expect(await lendSyncCommand(c.context, {}, { now })).toBe(1);
    expect(c.out).toEqual(['drop: "gone" is not an account here, so it was not sent']);
  });

  it('syncs one target with --target, and refuses one that does not exist', async () => {
    const drop = machine('cas-drop-').home;
    const { m } = owner(
      [
        dirTarget('a', path.join(drop, 'a'), ['work']),
        dirTarget('b', path.join(drop, 'b'), ['work']),
      ],
      { work: NOW + 5 * HOUR },
    );
    const c = contextOn(m);
    expect(await lendSyncCommand(c.context, { target: 'b' }, { now })).toBe(0);
    expect(existsSync(path.join(drop, 'a'))).toBe(false);
    expect(existsSync(path.join(drop, 'b', 'work.json'))).toBe(true);
    expect(await lendSyncCommand(c.context, { target: 'c' }, { now })).toBe(1);
    expect(c.out.pop()).toBe('no lending target named "c" (there are: a, b)');
  });
});

describe('ccx lend revoke', () => {
  it('takes a lend back through the same transport, and warns when the config would lend it again', async () => {
    const drop = path.join(machine('cas-drop-').home, 'lends');
    const m = machine();
    ownLogin(m, 'work', { expiresAt: NOW + 5 * HOUR });
    writeConfig(m, { lending: { targets: [dirTarget('drop', drop, ['work'])] } });
    const c = contextOn(m);
    await lendSyncCommand(c.context, {}, { now });

    // A receiver that imported the lend, then imports what the revoke sent.
    const receiver = machine('cas-recv-');
    const r = contextOn(receiver);
    await lendImportCommand(r.context, path.join(drop, 'work.json'), {}, { now });
    expect(getAccount('work', receiver.ctx)).toBeDefined();

    expect(await lendRevokeCommand(c.context, 'work', {}, { now })).toBe(0);
    expect(JSON.parse(readFileSync(path.join(drop, 'work.json'), 'utf8'))).toMatchObject({
      kind: 'revoke',
      account: 'work',
    });
    expect(c.out.pop()).toMatch(/note: drop still lends "work" in config\.json/);

    expect(await lendImportCommand(r.context, path.join(drop, 'work.json'), {}, { now })).toBe(0);
    expect(r.out.pop()).toBe('took back the lent login for "work", and the account the lend added');
    expect(getAccount('work', receiver.ctx)).toBeUndefined();
    // Imported again, it has nothing more to do.
    expect(await lendImportCommand(r.context, path.join(drop, 'work.json'), {}, { now })).toBe(0);
    expect(r.out.pop()).toBe('nothing lent as "work" here to take back');
  });

  it('takes back a lend this machine was given with --local', async () => {
    const owner = machine();
    ownLogin(owner, 'work', { expiresAt: NOW + 5 * HOUR });
    const o = contextOn(owner);
    await lendExportCommand(o.context, 'work', {}, { now, stdoutIsTTY: false });
    const receiver = machine('cas-recv-');
    const r = contextOn(receiver);
    await lendImportCommand(
      r.context,
      undefined,
      {},
      { now, stdinIsTTY: false, readStdin: async () => o.out.join('\n') },
    );
    expect(await lendRevokeCommand(r.context, 'work', { local: true }, { now })).toBe(0);
    expect(getAccount('work', receiver.ctx)).toBeUndefined();
  });

  it('needs a target that lends the account', async () => {
    const m = machine();
    writeConfig(m, { lending: { targets: [dirTarget('drop', '/unused', ['other'])] } });
    const c = contextOn(m);
    expect(await lendRevokeCommand(c.context, 'work', {}, { now })).toBe(1);
    expect(c.out.pop()).toMatch(/no lending target lends "work"/);
  });
});

describe('ccx lend', () => {
  it('shows what this machine lends and what is lent to it', async () => {
    const owner = machine();
    ownLogin(owner, 'work', { expiresAt: NOW + 5 * HOUR });
    writeConfig(owner, { lending: { targets: [dirTarget('drop', '/srv/lends', 'all')] } });
    const o = contextOn(owner);
    expect(lendStatusCommand(o.context, { now })).toBe(0);
    expect(o.out).toEqual([
      'lending from this machine:',
      '  drop  directory /srv/lends  work',
      'lent to this machine: none',
    ]);

    await lendExportCommand(o.context, 'work', {}, { now, stdoutIsTTY: false });
    const receiver = machine('cas-recv-');
    const r = contextOn(receiver, { json: true });
    await lendImportCommand(
      r.context,
      undefined,
      {},
      { now, stdinIsTTY: false, readStdin: async () => o.out.slice(3).join('\n') },
    );
    r.out.length = 0;
    expect(lendStatusCommand(r.context, { now })).toBe(0);
    expect(JSON.parse(r.out.join('\n'))).toEqual({
      schemaVersion: 1,
      targets: [],
      lentHere: [{ name: 'work', expiresAt: NOW + 5 * HOUR, usable: true }],
    });
  });
});
