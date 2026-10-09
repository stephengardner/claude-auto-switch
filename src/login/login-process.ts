import { spawn, execFile } from 'node:child_process';
import type { StartAuthLogin } from './login.js';

/** A URL counts only once whitespace follows it, so one split across reads is never taken half-written. */
const URL_RE = /(https?:\/\/\S+)\s/;
const URL_WAIT_MS = 3000;
/** Enough for the line carrying the URL; output past this is not searched. */
const MAX_SCANNED_CHARS = 64 * 1024;
/** Enough for the last thing claude said, which explains a refused code. */
const MAX_TAIL_CHARS = 2048;

/**
 * Real adapter: spawn `claude auth login` and sniff an auth URL from its output.
 * If the CLI auto-opens the browser (no URL printed), `urlHint` resolves
 * undefined after a short wait and the browser step works with the already-open
 * page. With `acceptsCode`, the child's input stays open so `submitCode` can
 * answer its "Paste code here" prompt.
 */
export const spawnAuthLogin: StartAuthLogin = (invoker, args, env, options = {}) => {
  const child = spawn(invoker.bin, args, {
    env: { ...process.env, ...env },
    stdio: [options.acceptsCode ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  // A child that exits before reading its input turns the write into EPIPE,
  // which is an 'error' event and, unlistened, an uncaught exception.
  child.stdin?.on('error', () => {
    /* the exit code and the stored login say what happened */
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

  let scanned = '';
  let tail = '';
  const onData = (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-MAX_TAIL_CHARS);
    if (settled || scanned.length > MAX_SCANNED_CHARS) return;
    scanned += chunk.toString();
    const match = scanned.match(URL_RE);
    if (match) settleUrl(match[1]);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  let finish: (code: number) => void = () => {};
  const donePromise = new Promise<number>((resolve) => {
    finish = resolve;
    child.on('close', (code) => {
      settleUrl(undefined);
      resolve(code ?? 1);
    });
  });

  // A child that cannot be STARTED emits 'error' and never emits 'close'. Node
  // re-throws an 'error' with no listener as an uncaught exception, which ends
  // the whole program rather than this one sign-in: from the dashboard, that
  // looked like pressing "l" crashed the terminal. It is also the only way out
  // of here that a try/catch around the caller cannot see, because it arrives
  // on a later tick as an event rather than a rejected promise.
  child.on('error', () => {
    settleUrl(undefined);
    finish(1);
  });

  const timer = setTimeout(() => settleUrl(undefined), options.urlWaitMs ?? URL_WAIT_MS);
  timer.unref?.();

  return {
    urlHint: () => urlPromise,
    done: () => donePromise,
    lastLine: () => lastNonEmptyLine(tail),
    ...(options.acceptsCode
      ? {
          submitCode: (code: string) => {
            child.stdin?.write(`${code}\n`);
          },
        }
      : {}),
    // Nothing could stop this process before, so a sign-in nobody finishes held
    // the caller forever. On Windows the whole tree has to go: the CLI opens
    // helpers of its own, and killing only the parent leaves them holding on.
    cancel: () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          // Non-blocking on purpose. This is called from a caller that is waiting
          // to return, so a synchronous kill would hold everything up until
          // taskkill exits, including the dashboard loop that relays the screen.
          // Unref'd so the killer itself can never keep the process alive.
          const killer = execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
          killer.on('error', () => {
            /* taskkill missing or refused: nothing better to do */
          });
          killer.unref?.();
          return;
        }
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
};

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** Colour codes, and the link wrapper some terminals get. */
const TERMINAL_CODES = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]|${ESC}\\][^${BEL}]*${BEL}`, 'g');
const PASTE_PROMPT = /^Paste code here if prompted >\s*/;

/** The last line of output with words in it, without terminal codes or the paste prompt. */
function lastNonEmptyLine(text: string): string | undefined {
  const lines = text
    .replace(TERMINAL_CODES, '')
    .split(/\r?\n/)
    .map((line) => line.replace(PASTE_PROMPT, '').trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}
