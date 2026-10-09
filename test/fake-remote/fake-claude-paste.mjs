// Stands in for `claude auth login` on a machine with no browser: prints the
// link, reads "code#state" at its paste prompt the way claude does (one line,
// split on #), and stores a login in CLAUDE_CONFIG_DIR when the code has both.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

process.stdout.write('Opening browser to sign in…\n');
process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?fake=1\n");
process.stdout.write('Paste code here if prompted > ');

createInterface({ input: process.stdin }).once('line', (line) => {
  const [code, state] = line.trim().split('#');
  if (!code || !state) {
    process.stderr.write('Invalid code. Please make sure the full code was copied.\n');
    process.exit(1);
  }
  if (code.startsWith('bad')) {
    process.stderr.write('OAuth error: invalid_grant\n');
    process.exit(1);
  }
  const dir = process.env.CLAUDE_CONFIG_DIR;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: `at-${code}`, refreshToken: `rt-${code}`, expiresAt: Date.now() + 8 * 3600_000 } }),
  );
  process.stdout.write('Login successful.\n');
  process.exit(0);
});
