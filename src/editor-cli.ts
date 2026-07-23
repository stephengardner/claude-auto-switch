#!/usr/bin/env node
// The launcher an editor extension points at (claudeProcessWrapper). The editor
// invokes it as `ccx-claude <nodePath> <cli.js> <...args>` and expects us to run
// that command, so we run it on the active/healthiest account with inherited
// stdio (protocol intact) and flip accounts on a cap for the next chat. When
// invoked directly with plain claude args, we resolve the real claude instead.
import { existsSync } from 'node:fs';
import { buildContext } from './context.js';
import { wrapperLaunch, editorLaunch } from './commands/editor-launch.js';

function looksLikeCommand(firstArg: string | undefined): boolean {
  if (!firstArg) return false;
  // The editor passes an absolute path to node (or a real executable) first.
  return existsSync(firstArg) || /[\\/]/.test(firstArg);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const context = buildContext({});
  process.exitCode = looksLikeCommand(argv[0])
    ? await wrapperLaunch(context, argv)
    : await editorLaunch(context, argv);
}

void main();
