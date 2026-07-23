import path from 'node:path';
import { spawn, type IPty } from 'node-pty';
import { getAccount } from '../accounts/registry.js';
import { invokerArgs } from '../invoker.js';
import { saveToken, extractToken } from '../daemon/token-store.js';
import { configHome } from '../config/paths.js';
import { writeSecretFile, redactSecrets } from '../util/secret-file.js';
import { getClaude, type CliContext } from '../context.js';

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function stripAnsi(s: string): string {
  return s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, 'g'), '');
}

/**
 * Mint and STORE a long-lived OAuth token for an account via `claude
 * setup-token`. Runs inside a pseudo-terminal so the browser flow works
 * normally (setup-token refuses to run when its output is a plain pipe), while
 * ccx captures the printed token and saves it in the account's profile.
 */
export async function tokenCommand(context: CliContext, name: string): Promise<number> {
  const account = getAccount(name, context.ctx);
  if (!account) {
    context.out(`account "${name}" not found`);
    return 1;
  }

  const err = context.err ?? ((m: string) => process.stderr.write(`${m}\n`));
  const claude = getClaude(context);
  err(`minting a token for "${name}" (approve in the browser when it opens)...`);

  return new Promise<number>((resolve) => {
    const child: IPty = spawn(claude.bin, invokerArgs(claude, ['setup-token']), {
      name: process.env.TERM ?? 'xterm-256color',
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      cwd: process.cwd(),
      env: cleanEnv(),
    });

    let output = '';
    child.onData((data) => {
      output += data;
      process.stdout.write(data);
    });

    const stdin = process.stdin as NodeJS.ReadStream & {
      setRawMode?: (v: boolean) => void;
      isTTY?: boolean;
    };
    if (stdin.isTTY) stdin.setRawMode?.(true);
    stdin.resume();
    const onInput = (d: Buffer): void => {
      child.write(d.toString('utf8'));
    };
    stdin.on('data', onInput);

    child.onExit(({ exitCode }) => {
      stdin.off('data', onInput);
      if (stdin.isTTY) stdin.setRawMode?.(false);
      stdin.pause();

      const clean = stripAnsi(output);
      const token = extractToken(clean);
      if (token) {
        saveToken(account.dir, token);
        err(`\nstored token for "${name}"`);
        resolve(0);
        return;
      }

      // Extraction failed, which usually means the token FORMAT changed, so the
      // raw output likely still contains a live token. Redact credential-shaped
      // strings and write owner-only, so the debug aid never leaks the secret.
      const debugFile = path.join(configHome(context.ctx), 'last-setup-token-output.txt');
      try {
        writeSecretFile(debugFile, redactSecrets(clean));
      } catch {
        /* best effort */
      }
      err(`\ncould not find a token in the output; saved redacted output to ${debugFile}`);
      resolve(exitCode || 1);
    });
  });
}
