import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { claudeSubcommandIn, SUBCOMMANDS } from './subcommand.js';

describe('telling a subcommand apart from a session', () => {
  it('recognises the subcommands that the session path was breaking', () => {
    // `ccx run -- mcp list` really did print: error: unknown option '--session-id'
    expect(claudeSubcommandIn(['update'])).toBe('update');
    expect(claudeSubcommandIn(['mcp', 'list'])).toBe('mcp');
    expect(claudeSubcommandIn(['doctor'])).toBe('doctor');
    expect(claudeSubcommandIn(['install', 'latest'])).toBe('install');
    expect(claudeSubcommandIn(['upgrade'])).toBe('upgrade');
    expect(claudeSubcommandIn(['plugins', 'list'])).toBe('plugins');
  });

  it('leaves an ordinary session alone', () => {
    expect(claudeSubcommandIn([])).toBeNull();
    expect(claudeSubcommandIn(['--continue'])).toBeNull();
    expect(claudeSubcommandIn(['--model', 'opus'])).toBeNull();
  });

  it('does not mistake a prompt that merely CONTAINS a subcommand word', () => {
    // The first bare word settles it, so "fix" ends the search before "update"
    // is ever reached. Getting this wrong would send a real session into the
    // passthrough and silently drop account rotation.
    expect(claudeSubcommandIn(['fix', 'the', 'update', 'script'])).toBeNull();
    expect(claudeSubcommandIn(['why is mcp failing?'])).toBeNull();
  });

  it('looks past leading flags to the first bare word', () => {
    expect(claudeSubcommandIn(['--verbose', 'mcp', 'list'])).toBe('mcp');
  });

  it('gives up on a flag that takes a value, rather than guessing', () => {
    // "opus" is a flag's VALUE, but nothing here can know that without a table
    // of every flag's arity, and such a table drifts out of date silently.
    // So the first bare word settles it either way, and this reads as a
    // session.
    //
    // That is the safe direction on purpose. Wrongly deciding "session" is the
    // behaviour ccx has always had. Wrongly deciding "subcommand" would send a
    // real session down the passthrough and silently drop account rotation,
    // which is the failure worth avoiding. Nobody writes global flags before
    // `update` anyway.
    expect(claudeSubcommandIn(['--model', 'opus', 'update'])).toBeNull();
  });

  it('treats everything after `--` as arguments, never a command', () => {
    expect(claudeSubcommandIn(['--', 'update'])).toBeNull();
  });
});

describe('drift against the real CLI', () => {
  /**
   * The list is hand-maintained because the CLI is a native binary and cannot be
   * read for its commands. That makes drift the obvious failure mode, and `rc`
   * proved it: a command missing from the list is not a wrong answer, it is a
   * broken command, discovered only when someone hit it.
   *
   * This closes the half that CAN be checked. Every command the CLI documents
   * must be in the list, so an addition turns into a red test instead of a
   * report weeks later. Hidden commands stay uncoverable; `rc` is in the list
   * precisely because nothing automatic could have found it.
   *
   * Skipped where no real CLI is installed, so CI never depends on one.
   */
  it('knows every command that `claude --help` documents', () => {
    const bin = process.env.CCX_TEST_CLAUDE_BIN;
    if (!bin || !existsSync(bin)) {
      expect(SUBCOMMANDS.has('update')).toBe(true); // list is at least present
      return;
    }
    const help = execFileSync(bin, ['--help'], { encoding: 'utf8', timeout: 60_000 });
    const section = help.slice(help.indexOf('Commands:'));
    const documented = [...section.matchAll(/^\s{2}([a-z][a-z0-9-]*)(\|[a-z|]+)?/gm)]
      .flatMap((m) => [m[1], ...(m[2] ? m[2].slice(1).split('|') : [])])
      .filter((name): name is string => Boolean(name) && name !== 'help');

    expect(documented.length).toBeGreaterThan(5);
    const missing = documented.filter((name) => !SUBCOMMANDS.has(name));
    expect(missing).toEqual([]);
  });
});
