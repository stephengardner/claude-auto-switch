import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { claudeSubcommandIn, SUBCOMMANDS } from './subcommand.js';

describe('telling a subcommand apart from a session', () => {
  it('recognises the commands the session path was breaking', () => {
    // `ccx run -- mcp list` printed: error: unknown option '--session-id'
    expect(claudeSubcommandIn(['update'])).toBe('update');
    expect(claudeSubcommandIn(['mcp', 'list'])).toBe('mcp');
    expect(claudeSubcommandIn(['doctor'])).toBe('doctor');
    expect(claudeSubcommandIn(['install', 'latest'])).toBe('install');
  });

  it('recognises the UNDOCUMENTED ones, which is how this was found', () => {
    // `claude rc` became "Could not reach the server to look up session <uuid>".
    // None of these appear in `claude --help`.
    expect(claudeSubcommandIn(['rc'])).toBe('rc');
    expect(claudeSubcommandIn(['remote-control'])).toBe('remote-control');
    expect(claudeSubcommandIn(['stop', 'abc123'])).toBe('stop');
    expect(claudeSubcommandIn(['logs', 'abc123'])).toBe('logs');
    expect(claudeSubcommandIn(['attach', 'abc123'])).toBe('attach');
  });

  it('leaves an ordinary session alone', () => {
    expect(claudeSubcommandIn([])).toBeNull();
    expect(claudeSubcommandIn(['--continue'])).toBeNull();
    expect(claudeSubcommandIn(['--model', 'opus'])).toBeNull();
  });

  it('does not mistake a prompt that merely CONTAINS a command word', () => {
    expect(claudeSubcommandIn(['fix', 'the', 'update', 'script'])).toBeNull();
    expect(claudeSubcommandIn(['why is mcp failing?'])).toBeNull();
  });

  it('never reads past a flag, so a flag VALUE can never be taken for a command', () => {
    // Reading on would need a table of which flags take values, and such a
    // table drifts silently: `--model update` would classify "update" and send
    // a real session down the passthrough, losing account rotation with nothing
    // said. Anything not starting with a command is a session.
    expect(claudeSubcommandIn(['--model', 'update'])).toBeNull();
    expect(claudeSubcommandIn(['--model', 'opus', 'update'])).toBeNull();
    expect(claudeSubcommandIn(['--add-dir', 'project'])).toBeNull();
    expect(claudeSubcommandIn(['--verbose', 'mcp', 'list'])).toBeNull();
  });
});

describe('drift against the real CLI', () => {
  const bin = process.env.CCX_TEST_CLAUDE_BIN;
  const available = Boolean(bin) && existsSync(bin!);

  /**
   * The list is hand-maintained because the CLI is a native binary that cannot
   * be read for its commands, and most of the entries are undocumented. Drift
   * is therefore the expected failure, and it is invisible: a missing command
   * is a broken command, found only when somebody runs it.
   *
   * These close what can be closed. Skipped where no real CLI is installed, so
   * CI never depends on one.
   */
  it.skipIf(!available)('knows every command that `claude --help` documents', () => {
    const help = execFileSync(bin!, ['--help'], { encoding: 'utf8', timeout: 60_000 });
    const section = help.slice(help.indexOf('Commands:'));
    const documented = [...section.matchAll(/^\s{2}([a-z][a-z0-9-]*)(\|[a-z|-]+)?/gm)]
      .flatMap((m) => [m[1], ...(m[2] ? m[2].slice(1).split('|') : [])])
      .filter((name): name is string => Boolean(name) && name !== 'help');

    expect(documented.length).toBeGreaterThan(5);
    expect(documented.filter((name) => !SUBCOMMANDS.has(name))).toEqual([]);
  });

  it.skipIf(!available)('lists nothing that the CLI does not actually accept', () => {
    // A real command answers `claude <name> --help` with its OWN usage and exits
    // 0. This catches a typo or a command that has been removed, either of which
    // would quietly send a session down the passthrough.
    const notRecognised = [...SUBCOMMANDS].filter((name) => {
      try {
        execFileSync(bin!, [name, '--help'], { encoding: 'utf8', timeout: 60_000, stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    });
    expect(notRecognised).toEqual([]);
  }, 120_000);
});
