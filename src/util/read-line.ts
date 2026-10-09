import { createInterface } from 'node:readline';

/**
 * One line from standard input, or null when input ends first or the wait runs
 * out. Stops reading afterwards, so an open input cannot keep the process alive.
 */
export function readOneLine(timeoutMs: number, input: NodeJS.ReadableStream = process.stdin): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, crlfDelay: Infinity });
    let finished = false;
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rl.close();
      if (input === process.stdin) process.stdin.pause();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    rl.once('line', (line) => finish(line.trim() || null));
    rl.once('close', () => finish(null));
  });
}
