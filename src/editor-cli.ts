#!/usr/bin/env node
// The launcher an editor extension points at (claudeProcessWrapper). It runs the
// real claude on the active/healthiest account with inherited stdio, so the
// extension protocol is untouched, and flips accounts on a cap for the next chat.
import { buildContext } from './context.js';
import { editorLaunch } from './commands/editor-launch.js';

async function main(): Promise<void> {
  process.exitCode = await editorLaunch(buildContext({}), process.argv.slice(2));
}

void main();
