import { describe, it, expect } from 'vitest';
import { KEEPALIVE_MARK, findKeepalive, keepaliveLine, withKeepalive } from './crontab.js';

const theirs = 'MAILTO=me@example.com\n0 3 * * * /usr/bin/backup --nightly\n';

describe('keepalive crontab entry', () => {
  it('adds its line and keeps everything already there', () => {
    const line = keepaliveLine("'/usr/bin/node' '/opt/ccx/cli.js' usage");
    const next = withKeepalive(theirs, line);
    expect(next).toBe(`${theirs}${line}\n`);
    expect(findKeepalive(next)).toBe(line);
  });

  it('replaces its own line instead of adding a second', () => {
    const first = withKeepalive(theirs, keepaliveLine("'/old/node' '/old/cli.js' usage"));
    const second = withKeepalive(first, keepaliveLine("'/new/node' '/new/cli.js' usage"));
    expect(second.split('\n').filter((l) => l.includes(KEEPALIVE_MARK))).toHaveLength(1);
    expect(second).toContain('/new/cli.js');
    expect(second).not.toContain('/old/cli.js');
    expect(second.startsWith(theirs)).toBe(true);
  });

  it('removes only its own line', () => {
    const on = withKeepalive(theirs, keepaliveLine('x usage'));
    expect(withKeepalive(on, null)).toBe(theirs);
  });

  it('starts an empty crontab, and leaves it empty when removed', () => {
    const on = withKeepalive('', keepaliveLine('x usage'));
    expect(on.trim().split('\n')).toHaveLength(1);
    expect(withKeepalive(on, null)).toBe('');
  });

  it('runs every four hours, off the hour, and discards its output', () => {
    expect(keepaliveLine('cmd')).toBe(`17 */4 * * * cmd >/dev/null 2>&1 ${KEEPALIVE_MARK}`);
  });
});
