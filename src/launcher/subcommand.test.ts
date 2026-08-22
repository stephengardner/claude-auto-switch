import { describe, it, expect } from 'vitest';
import { claudeSubcommandIn } from './subcommand.js';

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
