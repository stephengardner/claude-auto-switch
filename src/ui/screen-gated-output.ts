/**
 * Saying something without writing over a screen someone else is drawing.
 *
 * ccx and Claude share one terminal. While Claude is drawing, anything ccx
 * writes lands in the middle of that drawing, and the place it lands is Claude's
 * input box. The operator then sees ccx's words sitting at their prompt as
 * though they had typed them: a screenshot of this showed
 * "ccx: every account has hit its limit" in the input box of a session that was
 * running perfectly well on Opus, which reads as a live refusal and is not one.
 *
 * The opposite mistake is just as bad and shipped first: dropping the message
 * leaves the operator at a blank prompt with nothing to explain why nothing ran.
 *
 * So a message is HELD while the screen is busy and said when it comes back.
 * Only the last one is kept, deliberately: these are endings, and an ending
 * replaces the one before it rather than queueing behind it.
 */

export interface ScreenGatedOutput {
  /** Say it now, or hold it until the screen comes back. */
  say: (message: string) => void;
  /** Screen taken (true) or handed back (false). Releasing flushes what is held. */
  setBusy: (busy: boolean) => void;
  /** What is waiting, for tests and for a caller that wants to check. */
  held: () => string | null;
}

export function screenGatedOutput(write: (message: string) => void): ScreenGatedOutput {
  let busy = false;
  let pending: string | null = null;

  const flush = (): void => {
    if (pending === null) return;
    const message = pending;
    pending = null;
    write(message);
  };

  return {
    say: (message) => {
      if (busy) {
        pending = message;
        return;
      }
      write(message);
    },
    setBusy: (next) => {
      busy = next;
      if (!next) flush();
    },
    held: () => pending,
  };
}
