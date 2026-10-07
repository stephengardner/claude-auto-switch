/**
 * Check an INSTALLED ccx the way a user's machine runs it: its command answers,
 * and it can open a terminal, which is how every `claude` it runs is started.
 *
 * CI runs this against the package packed from the checkout and installed
 * globally into a fresh folder, exactly as `npm install -g` lays it down for a
 * user. The test suite runs from the repository, where the install can differ
 * from a user's, and the one time it did (node-pty shipping its macOS terminal
 * helper without permission to run) every test passed while no user on a Mac
 * could start `claude` at all.
 *
 *   node scripts/smoke-installed.mjs <installed claude-auto-switch folder>
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/smoke-installed.mjs <installed claude-auto-switch folder>');
  process.exit(2);
}

const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// The command itself.
const cli = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), '--version'], { encoding: 'utf8' });
if (cli.status !== 0 || cli.stdout.trim() !== version) {
  console.error(`ccx --version said ${JSON.stringify(cli.stdout.trim())} (exit ${cli.status}), expected ${version}`);
  console.error(cli.stderr);
  process.exit(1);
}
console.log(`ccx ${version} runs`);

// A terminal, through the same loader every part of ccx uses.
const { nodePty } = await import(pathToFileURL(path.join(root, 'dist', 'util', 'native-pty.js')).href);
let child;
try {
  child = nodePty().spawn(process.execPath, ['-e', 'process.exit(7)'], {
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  });
} catch (err) {
  console.error(`could not open a terminal: ${err.message}`);
  process.exit(1);
}
const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the program in the terminal did not finish within 30s')), 30_000);
  child.onExit(({ exitCode }) => {
    clearTimeout(timer);
    resolve(exitCode);
  });
});
if (code !== 7) {
  console.error(`a terminal opened, but its program exited ${code}, not 7`);
  process.exit(1);
}
console.log('a terminal opens and runs its program to the end');
process.exit(0);
