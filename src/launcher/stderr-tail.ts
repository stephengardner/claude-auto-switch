/**
 * What ccx keeps of a Claude's standard error while it runs, for what is
 * judged once it has ended: the end of Claude's own words, never its debug
 * lines.
 *
 * The editor's extension (2.1.302) starts every chat's Claude with `--debug
 * --debug-to-stderr`, and that Claude runs until the chat is closed, so its
 * standard error is a debug log that grows for as long as the chat is open.
 * Claude 2.1.302 writes each debug entry as one whole line,
 * `<toISOString()> [LEVEL] <message>`, with any line break inside the message
 * escaped, and never splits one across writes. Everything else on standard
 * error is Claude's own. Debug lines talk about rate limits in ordinary turns
 * and name models on every request, so they are neither judged nor kept, which
 * also stops them pushing Claude's own words out of what is kept.
 *
 * The bound is in characters, not bytes: it is there to cap what is held, and
 * a limit message from 2.1.302 is one line of under 300 characters ("You've
 * hit your usage limit · resets <time>", the longest with an admin's address
 * and a second reset in it), so the last 65,536 characters of Claude's own
 * words hold it with room for hundreds of lines after it.
 */
export const STDERR_TAIL_CHARS = 64 * 1024;

/** A debug line as Claude 2.1.302 writes one: its levels are verbose, debug, info, warn and error. */
const DEBUG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[(?:VERBOSE|DEBUG|INFO|WARN|ERROR)\] /;
/** How much of a line tells whether it is a debug line: the longest start one can have. */
const TELLING_CHARS = '2026-01-01T00:00:00.000Z [VERBOSE] '.length;

export interface StderrTail {
  /** More of standard error, as it was read. */
  add(text: string): void;
  /**
   * What is kept: the end of Claude's own words, at most the bound, and the
   * start of a line too short yet to tell what it is.
   */
  text(): string;
}

export function createStderrTail(limit: number = STDERR_TAIL_CHARS): StderrTail {
  let kept = '';
  /** The start of the line being read, while too little of it has come to tell what it is. */
  let opening = '';
  /** What the line being read is, once that is known. */
  let line: 'debug' | 'own' | null = null;

  return {
    add(text) {
      const own: string[] = [];
      const tell = (): void => {
        line = DEBUG_LINE.test(opening) ? 'debug' : 'own';
        if (line === 'own') own.push(opening);
        opening = '';
      };
      text.split('\n').forEach((part, i) => {
        if (i > 0) {
          // The line before this part has ended.
          if (line === null) tell();
          if (line === 'own') own.push('\n');
          line = null;
        }
        if (line === null) {
          opening += part;
          if (opening.length >= TELLING_CHARS) tell();
        } else if (line === 'own') {
          own.push(part);
        }
      });
      if (own.length > 0) kept = (kept + own.join('')).slice(-limit);
    },
    text: () => kept + opening,
  };
}
