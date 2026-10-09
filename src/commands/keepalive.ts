import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { findKeepalive, keepaliveLine, withKeepalive } from '../keepalive/crontab.js';
import { shellQuote } from '../util/shell-quote.js';
import type { CliContext } from '../context.js';

/** Reading and writing the user's crontab; replaced in tests. */
export interface CrontabIO {
  /** The current crontab ('' when there is none), or null when cron cannot be used here. */
  read(): Promise<string | null>;
  write(text: string): Promise<{ ok: boolean; detail?: string }>;
}

export interface KeepaliveDeps {
  crontab?: CrontabIO;
  nodePath?: string;
  cliPath?: string;
  exists?: (file: string) => boolean;
}

export const systemCrontab: CrontabIO = {
  async read() {
    const result = await execa('crontab', ['-l'], { reject: false, stripFinalNewline: false });
    if (result.exitCode === 0) return result.stdout;
    // A user with no crontab yet is told so on stderr, with a non-zero exit.
    if (/no crontab/i.test(result.stderr)) return '';
    return null;
  },
  async write(text) {
    // Nothing left but ccx's own line: remove the crontab, back to how it was before.
    const result =
      text === ''
        ? await execa('crontab', ['-r'], { reject: false })
        : await execa('crontab', ['-'], { input: text, reject: false });
    return result.exitCode === 0
      ? { ok: true }
      : { ok: false, detail: result.stderr.trim() || result.shortMessage };
  },
};

/** `ccx keepalive on|off|status`. */
export async function keepaliveCommand(
  context: CliContext,
  action = 'status',
  deps: KeepaliveDeps = {},
): Promise<number> {
  const node = deps.nodePath ?? process.execPath;
  const cli = deps.cliPath ?? fileURLToPath(new URL('../cli.js', import.meta.url));
  const env = context.ctx.env ?? process.env;
  const home = env.CLAUDE_AUTO_SWITCH_HOME;
  const usage = [
    ...(home ? [`CLAUDE_AUTO_SWITCH_HOME=${shellQuote(home)}`] : []),
    shellQuote(node),
    shellQuote(cli),
    'usage',
  ].join(' ');

  if (!['on', 'off', 'status'].includes(action)) {
    context.out('usage: ccx keepalive <on|off|status>');
    return 1;
  }
  if ((context.ctx.platform ?? process.platform) === 'win32') {
    context.out('ccx keepalive uses cron, which Windows does not have. The same with Task Scheduler:');
    context.out(`  schtasks /Create /SC HOURLY /MO 4 /TN "ccx keepalive" /TR "'${node}' '${cli}' usage"`);
    return action === 'status' ? 0 : 1;
  }

  const crontab = deps.crontab ?? systemCrontab;
  const current = await crontab.read();
  if (current === null) {
    context.out('cron is not available here (no crontab command), so keepalive cannot be set up.');
    return 1;
  }

  if (action === 'status') {
    const line = findKeepalive(current);
    if (!line) {
      context.out('keepalive is off.');
      context.out('  A machine nobody uses for a day can lose its logins; turn it on with: ccx keepalive on');
      return 0;
    }
    context.out('keepalive is on: every four hours, ccx usage renews any login that has expired.');
    context.out(`  ${line}`);
    const exists = deps.exists ?? existsSync;
    if (!line.includes(shellQuote(node)) || !line.includes(shellQuote(cli)) || !exists(node) || !exists(cli)) {
      context.out('  It points at a different node or ccx than this one; run ccx keepalive on to update it.');
    }
    return 0;
  }

  const next = withKeepalive(current, action === 'on' ? keepaliveLine(usage) : null);
  if (next === current) {
    context.out(action === 'on' ? 'keepalive is already on.' : 'keepalive is already off.');
    return 0;
  }
  const written = await crontab.write(next);
  if (!written.ok) {
    context.out(`could not update the crontab: ${written.detail ?? 'unknown error'}`);
    return 1;
  }
  context.out(
    action === 'on'
      ? 'keepalive is on: every four hours, ccx usage renews any login that has expired.'
      : 'keepalive is off.',
  );
  return 0;
}
