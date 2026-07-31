import { spawn, execFileSync } from 'node:child_process';
import type { StartAuthLogin } from './login.js';

const URL_RE = /(https?:\/\/\S+)/;
const URL_WAIT_MS = 3000;

/**
 * Real adapter: spawn `claude auth login` and sniff an auth URL from its output.
 * If the CLI auto-opens the browser (no URL printed), `urlHint` resolves
 * undefined after a short wait and the browser step works with the already-open
 * page.
 */
export const spawnAuthLogin: StartAuthLogin = (invoker, args, env) => {
  const child = spawn(invoker.bin, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let settled = false;
  let resolveUrl: (u: string | undefined) => void = () => {};
  const urlPromise = new Promise<string | undefined>((resolve) => {
    resolveUrl = resolve;
  });
  const settleUrl = (u: string | undefined) => {
    if (!settled) {
      settled = true;
      resolveUrl(u);
    }
  };

  const onData = (chunk: Buffer) => {
    const match = chunk.toString().match(URL_RE);
    if (match) settleUrl(match[1]);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const donePromise = new Promise<number>((resolve) => {
    child.on('close', (code) => {
      settleUrl(undefined);
      resolve(code ?? 1);
    });
  });

  const timer = setTimeout(() => settleUrl(undefined), URL_WAIT_MS);
  timer.unref?.();

  return {
    urlHint: () => urlPromise,
    done: () => donePromise,
    // Nothing could stop this process before, so a sign-in nobody finishes held
    // the caller forever. On Windows the whole tree has to go: the CLI opens
    // helpers of its own, and killing only the parent leaves them holding on.
    cancel: () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          return;
        }
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
};
