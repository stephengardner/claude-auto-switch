import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { keepaliveCommand, type CrontabIO } from './keepalive.js';
import { KEEPALIVE_MARK } from '../keepalive/crontab.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

function context(platform: NodeJS.Platform = 'linux', env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const home = mkdtempSync(path.join(tmpdir(), 'cas-keepalive-'));
  const ctx = { platform, env };
  const c = {
    ctx,
    config: loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } }),
    out: (m: string) => lines.push(m),
    json: false,
    quiet: false,
  } as CliContext;
  return { c, lines };
}

function memoryCrontab(initial: string | null): CrontabIO & { text: string | null; writes: number } {
  const store = {
    text: initial,
    writes: 0,
    read: () => Promise.resolve(store.text),
    write: (t: string) => {
      store.text = t;
      store.writes += 1;
      return Promise.resolve({ ok: true });
    },
  };
  return store;
}

const paths = { nodePath: '/usr/bin/node', cliPath: '/opt/ccx/dist/cli.js', exists: () => true };

describe('ccx keepalive', () => {
  it('turns on with a line that runs this node and this ccx', async () => {
    const { c, lines } = context();
    const crontab = memoryCrontab('0 3 * * * backup\n');
    expect(await keepaliveCommand(c, 'on', { ...paths, crontab })).toBe(0);
    expect(crontab.text).toBe(
      `0 3 * * * backup\n17 */4 * * * '/usr/bin/node' '/opt/ccx/dist/cli.js' usage >/dev/null 2>&1 ${KEEPALIVE_MARK}\n`,
    );
    expect(lines.join('\n')).toContain('keepalive is on');
  });

  it('carries a custom ccx home into the job, so it renews the same accounts', async () => {
    const { c } = context('linux', { CLAUDE_AUTO_SWITCH_HOME: '/srv/ccx home' });
    const crontab = memoryCrontab('');
    await keepaliveCommand(c, 'on', { ...paths, crontab });
    expect(crontab.text).toContain("CLAUDE_AUTO_SWITCH_HOME='/srv/ccx home' '/usr/bin/node'");
  });

  it('does not rewrite the crontab when nothing would change', async () => {
    const { c } = context();
    const crontab = memoryCrontab('');
    await keepaliveCommand(c, 'on', { ...paths, crontab });
    await keepaliveCommand(c, 'on', { ...paths, crontab });
    expect(crontab.writes).toBe(1);
  });

  it('turns off by removing only its own line', async () => {
    const { c } = context();
    const crontab = memoryCrontab('0 3 * * * backup\n');
    await keepaliveCommand(c, 'on', { ...paths, crontab });
    expect(await keepaliveCommand(c, 'off', { ...paths, crontab })).toBe(0);
    expect(crontab.text).toBe('0 3 * * * backup\n');
  });

  it('reports off, and why it matters', async () => {
    const { c, lines } = context();
    expect(await keepaliveCommand(c, 'status', { ...paths, crontab: memoryCrontab('') })).toBe(0);
    expect(lines.join('\n')).toContain('keepalive is off');
    expect(lines.join('\n')).toContain('ccx keepalive on');
  });

  it('notices when the job points at a node or ccx that has moved', async () => {
    const { c, lines } = context();
    const crontab = memoryCrontab('');
    await keepaliveCommand(c, 'on', { ...paths, crontab });
    await keepaliveCommand(c, 'status', { ...paths, nodePath: '/new/node', crontab });
    expect(lines.join('\n')).toContain('run ccx keepalive on to update it');
  });

  it('says so when cron is not available', async () => {
    const { c, lines } = context();
    expect(await keepaliveCommand(c, 'on', { ...paths, crontab: memoryCrontab(null) })).toBe(1);
    expect(lines.join('\n')).toContain('cron is not available');
  });

  it('gives the Task Scheduler equivalent on Windows instead of touching anything', async () => {
    const { c, lines } = context('win32');
    const crontab = memoryCrontab('');
    expect(await keepaliveCommand(c, 'on', { ...paths, crontab })).toBe(1);
    expect(crontab.writes).toBe(0);
    expect(lines.join('\n')).toContain('schtasks');
  });

  it('refuses an action it does not know', async () => {
    const { c } = context();
    expect(await keepaliveCommand(c, 'maybe', { ...paths, crontab: memoryCrontab('') })).toBe(1);
  });
});
