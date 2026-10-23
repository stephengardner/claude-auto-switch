import { describe, it, expect } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deliver, describeTransport, scrub, type Delivery } from './transport.js';

const posix = process.platform !== 'win32';
const TOKEN = 'at-made-up-token-value';
const delivery: Delivery = {
  account: 'work',
  kind: 'lend',
  payload: `{"claudeAiOauth":{"accessToken":"${TOKEN}"}}\n`,
  secrets: [TOKEN],
};

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'cas-transport-'));
}

/**
 * A program that keeps what it was given: its arguments, its standard input
 * and its environment's CCX_LEND_* variables, each in a file beside it. Then
 * it says or exits as FAKE_SAY / FAKE_EXIT tell it.
 */
function recorder(dir: string): string {
  const script = path.join(dir, 'recorder.mjs');
  writeFileSync(
    script,
    [
      "import { writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      'const dir = path.dirname(fileURLToPath(import.meta.url));',
      'const chunks = [];',
      'for await (const chunk of process.stdin) chunks.push(chunk);',
      "writeFileSync(path.join(dir, 'stdin.txt'), Buffer.concat(chunks));",
      "writeFileSync(path.join(dir, 'argv.json'), JSON.stringify(process.argv.slice(2)));",
      "writeFileSync(path.join(dir, 'env.json'), JSON.stringify({ account: process.env.CCX_LEND_ACCOUNT, kind: process.env.CCX_LEND_KIND }));",
      'if (process.env.FAKE_SAY) console.error(process.env.FAKE_SAY);',
      "else console.log('taken');",
      'process.exit(Number(process.env.FAKE_EXIT ?? 0));',
      '',
    ].join('\n'),
    'utf8',
  );
  return script;
}

describe('the directory transport', () => {
  it('writes one owner-only file per account, whole, and leaves no temp file', async () => {
    const dir = path.join(scratch(), 'lends');
    const result = await deliver({ type: 'directory', path: dir }, delivery);
    expect(result).toEqual({ ok: true, detail: `written to ${path.join(dir, 'work.json')}` });
    expect(readFileSync(path.join(dir, 'work.json'), 'utf8')).toBe(delivery.payload);
    expect(readdirSync(dir)).toEqual(['work.json']);
    if (posix) {
      expect(statSync(path.join(dir, 'work.json')).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it('expands ~ to the home it is given', async () => {
    const home = scratch();
    const result = await deliver({ type: 'directory', path: '~/lends' }, delivery, {
      ctx: { env: { HOME: home, USERPROFILE: home } },
    });
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(home, 'lends', 'work.json'))).toBe(true);
  });

  it('says why it could not write, without the token', async () => {
    const blocker = path.join(scratch(), 'a-file');
    writeFileSync(blocker, 'not a folder', 'utf8');
    const result = await deliver({ type: 'directory', path: blocker }, delivery);
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain(TOKEN);
  });
});

describe('the command transport', () => {
  it('hands the bundle over on standard input, never on its command line, and says which account it is', async () => {
    const dir = scratch();
    const run = `"${process.execPath}" "${recorder(dir)}" --upload`;
    const result = await deliver({ type: 'command', run }, delivery);
    expect(result).toEqual({ ok: true, detail: 'taken' });
    expect(readFileSync(path.join(dir, 'stdin.txt'), 'utf8')).toBe(delivery.payload);
    expect(readFileSync(path.join(dir, 'argv.json'), 'utf8')).not.toContain(TOKEN);
    expect(JSON.parse(readFileSync(path.join(dir, 'env.json'), 'utf8'))).toEqual({
      account: 'work',
      kind: 'lend',
    });
  });

  it('reports a failure by its exit code and last words, with the token taken out', async () => {
    const dir = scratch();
    const run = `"${process.execPath}" "${recorder(dir)}"`;
    const result = await deliver({ type: 'command', run }, delivery, {
      env: { FAKE_EXIT: '3', FAKE_SAY: `upload refused for ${TOKEN}` },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/failed \(exit 3\): upload refused for \*\*\*/);
    expect(result.detail).not.toContain(TOKEN);
  });

  it('ends a command that does not finish in time', async () => {
    const run = `"${process.execPath}" -e "setTimeout(() => {}, 5000)"`;
    const result = await deliver({ type: 'command', run }, delivery, { timeoutMs: 300 });
    expect(result).toEqual({
      ok: false,
      detail: expect.stringMatching(/did not finish within/) as unknown as string,
    });
  });
});

describe.skipIf(!posix)('the ssh transport', () => {
  /** ssh minus the network: a shell script that runs the recorder with whatever ssh was given. */
  function fakeSsh(dir: string): string {
    const bin = path.join(dir, 'ssh');
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${recorder(dir)}" "$@"\n`, 'utf8');
    chmodSync(bin, 0o755);
    return bin;
  }

  it('pipes the bundle to the remote command over standard input, never as an argument', async () => {
    const dir = scratch();
    const result = await deliver(
      { type: 'ssh', host: 'me@build-1', remoteCommand: 'ccx lend import' },
      delivery,
      { sshBin: fakeSsh(dir) },
    );
    expect(result).toEqual({ ok: true, detail: 'taken' });
    expect(readFileSync(path.join(dir, 'stdin.txt'), 'utf8')).toBe(delivery.payload);
    const argv = JSON.parse(readFileSync(path.join(dir, 'argv.json'), 'utf8')) as string[];
    // Never stops to ask for a password, which a run from cron could not answer.
    expect(argv.slice(0, 4)).toEqual(['-T', '-o', 'BatchMode=yes', 'me@build-1']);
    expect(argv[4]).toContain('ccx lend import');
    expect(argv.join(' ')).not.toContain(TOKEN);
  });

  it('tells an unreachable host and a missing command apart, without the token', async () => {
    const dir = scratch();
    const sshBin = fakeSsh(dir);
    const transport = { type: 'ssh', host: 'build-1', remoteCommand: 'ccx lend import' } as const;
    // ssh hands the far side's exit back as its own; the fake reads these from its environment.
    process.env.FAKE_EXIT = '255';
    process.env.FAKE_SAY = `ssh: connect to host build-1: refused ${TOKEN}`;
    try {
      const down = await deliver(transport, delivery, { sshBin });
      expect(down.detail).toMatch(
        /^could not reach build-1 over ssh: ssh: connect to host build-1: refused \*\*\*$/,
      );
      process.env.FAKE_EXIT = '127';
      process.env.FAKE_SAY = 'sh: ccx: command not found';
      const missing = await deliver(transport, delivery, { sshBin });
      expect(missing.detail).toMatch(
        /could not find the command to run \(set the target's remoteCommand\)/,
      );
    } finally {
      delete process.env.FAKE_EXIT;
      delete process.env.FAKE_SAY;
    }
  });

  it('refuses a host ssh could read as an option', async () => {
    const result = await deliver(
      { type: 'ssh', host: '-oProxyCommand=evil', remoteCommand: 'ccx lend import' },
      delivery,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not a host ssh can be given safely/);
  });
});

describe('describing a transport', () => {
  it('names a command by its first word only, since the rest may hold something private', () => {
    expect(describeTransport({ type: 'command', run: 'my-uploader --key secret-value' })).toBe(
      'command my-uploader',
    );
    expect(
      describeTransport({ type: 'ssh', host: 'me@build-1', remoteCommand: 'ccx lend import' }),
    ).toBe('ssh me@build-1');
    expect(describeTransport({ type: 'directory', path: '/srv/lends' })).toBe(
      'directory /srv/lends',
    );
  });

  it('takes out the secrets it is given and anything shaped like a token', () => {
    expect(scrub(`got ${TOKEN} and sk-ant-oat01-abcdefghijklmnop`, [TOKEN])).toBe(
      'got *** and sk-ant-***REDACTED***',
    );
  });
});
