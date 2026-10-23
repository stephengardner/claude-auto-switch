/**
 * Work written once as a series of steps, and run one of two ways: blocking
 * the thread, for a command with nothing else to do, or on the event loop,
 * for a session, whose thread relays Claude's terminal and the keys typed
 * into it.
 *
 * A step is a pause (how many milliseconds to wait before going on) or a call.
 * Run blocking, a pause sleeps and a call must answer at once; run on timers,
 * a pause is a timer and a call may answer later. What a call returns, or
 * throws, is handed back to the work at the point that made it.
 */
export type Step = number | (() => unknown);
export type Steps<T> = Generator<Step, T, unknown>;

/** A call, as one step of some work: `const value = yield* call(() => read())`. */
export function* call<T>(make: () => T | Promise<T>): Steps<T> {
  return (yield make) as T;
}

/** Block the current thread briefly without spinning the CPU. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** How many blocking runs are under way on this thread now, one inside another included. */
let blockingRuns = 0;

/** Whether the code running now is a step of a blocking run, so all of the work around it is synchronous. */
export function runningBlocking(): boolean {
  return blockingRuns > 0;
}

export function runBlocking<T>(steps: Steps<T>): T {
  blockingRuns += 1;
  try {
    let next: IteratorResult<Step, T> = steps.next();
    for (;;) {
      if (next.done) return next.value;
      const step = next.value;
      if (typeof step === 'number') {
        sleepSync(step);
        next = steps.next();
        continue;
      }
      let answer: unknown;
      try {
        answer = step();
        if (isThenable(answer)) throw new Error('a step that answers later was run blocking');
      } catch (error) {
        next = steps.throw(error);
        continue;
      }
      next = steps.next(answer);
    }
  } finally {
    blockingRuns -= 1;
  }
}

/**
 * Each step runs as the one before it settles, so nothing else in this process
 * runs between a call that answers at once and the step after it. The first
 * step is taken before this returns. The pauses are unref'd, so a wait never
 * keeps a process alive by itself: one that ends meanwhile never hears the
 * outcome.
 */
export async function runOnTimers<T>(steps: Steps<T>): Promise<T> {
  let next: IteratorResult<Step, T> = steps.next();
  for (;;) {
    if (next.done) return next.value;
    const step = next.value;
    if (typeof step === 'number') {
      await new Promise<void>((resolve) => setTimeout(resolve, step).unref());
      next = steps.next();
      continue;
    }
    let answer: unknown;
    try {
      answer = step();
      if (isThenable(answer)) answer = await answer;
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(answer);
  }
}
