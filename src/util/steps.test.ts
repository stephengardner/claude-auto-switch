import { describe, expect, it } from 'vitest';
import { call, runBlocking, runOnTimers, type Steps } from './steps.js';

/** Work that pauses, asks twice, and says what it heard and what it caught. */
function* work(ask: (n: number) => unknown, heard: string[]): Steps<string> {
  yield 20;
  heard.push(String(yield* call(() => ask(1))));
  try {
    heard.push(String(yield* call(() => ask(2))));
  } catch (error) {
    heard.push(`caught ${(error as Error).message}`);
  }
  return heard.join(', ');
}

describe('work written once as steps', () => {
  it('runs blocking, the thread held through its pauses', () => {
    const heard: string[] = [];
    const started = Date.now();
    const answer = runBlocking(
      work((n) => {
        if (n === 2) throw new Error('no');
        return `answer ${n}`;
      }, heard),
    );
    expect(answer).toBe('answer 1, caught no');
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('refuses, inside the work, a call that would answer later when run blocking', () => {
    const heard: string[] = [];
    expect(runBlocking(work((n) => (n === 1 ? 'now' : Promise.resolve('later')), heard))).toBe(
      'now, caught a step that answers later was run blocking',
    );
  });

  it('runs on timers, the thread free through its pauses and its waits', async () => {
    const heard: string[] = [];
    let ticks = 0;
    const tick = setInterval(() => (ticks += 1), 5);
    let answer: string;
    try {
      answer = await runOnTimers(
        work(async (n) => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          if (n === 2) throw new Error('refused');
          return `answer ${n}`;
        }, heard),
      );
    } finally {
      clearInterval(tick);
    }
    expect(answer).toBe('answer 1, caught refused');
    expect(ticks).toBeGreaterThan(5);
  });

  it('takes its first steps before it returns, up to the first that waits', () => {
    const seen: string[] = [];
    void runOnTimers(
      (function* (): Steps<void> {
        seen.push('first');
        yield* call(() => seen.push('a call answered at once'));
        yield 10;
        seen.push('after the pause');
      })(),
    );
    expect(seen).toEqual(['first', 'a call answered at once']);
  });

  it('fails with what the work threw', async () => {
    await expect(
      runOnTimers(
        (function* (): Steps<void> {
          yield 1;
          throw new Error('broken');
        })(),
      ),
    ).rejects.toThrow('broken');
    expect(() =>
      runBlocking(
        (function* (): Steps<void> {
          yield 1;
          throw new Error('broken');
        })(),
      ),
    ).toThrow('broken');
  });
});
