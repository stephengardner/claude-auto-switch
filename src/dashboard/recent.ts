/**
 * Recent activity as the dashboard words it.
 *
 * The event log is written for whoever is working out why ccx did something,
 * so its lines say how a move works. `ccx history` and `ccx state` keep them
 * as written. The dashboard is glanced at, so it rewords the lines about
 * sessions and accounts, folds repeats together and shows only the last few.
 */

/** How many lines the dashboard gives to recent activity. */
export const RECENT_LINES = 3;

/** No line this reworder knows is longer, which also bounds the matching. */
const LONGEST_KNOWN = 300;

const NAME = '"?([^"\\s]+)"?';

/**
 * Log wording, and the same thing said plainly. Each pattern matches a whole
 * message, so a line that only resembles one is left as it was written.
 */
const PLAIN: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`^switching to ${NAME} \\(no restart; takes effect within ~\\d+s\\)$`), 'a session moved to $1'],
  [new RegExp(`^session on ${NAME}$`), 'a session started on $1'],
  [
    new RegExp(`^${NAME} hit its limit; moved this session to ${NAME} in place \\(no restart\\)$`),
    '$1 ran out; its session moved to $2',
  ],
  [new RegExp(`^seamless cap relief: ${NAME} -> ${NAME}$`), '$1 ran out; its session moved to $2'],
  [new RegExp(`^${NAME} hit its limit; continuing on another account\\.\\.\\.$`), '$1 ran out; its session moved on'],
  [new RegExp(`^${NAME} hit its limit( \\(editor\\))?$`), '$1 ran out$2'],
  [
    /^moving (.+) to (\S+) \((?:in place, within ~\d+s|now, restarting)\); new sessions start there too$/,
    'moved $1 to $2; new sessions start there too',
  ],
  [/^swap: (session \d+ asked to move to \S+)$/, '$1'],
];

function plain(message: string): string {
  if (message.length > LONGEST_KNOWN) return message;
  for (const [pattern, words] of PLAIN) {
    if (pattern.test(message)) return message.replace(pattern, words);
  }
  return message;
}

const TIMED = /^\d\d:\d\d {2}/;
const BUILD = '  [ccx ';
const REPEATED = / \(x(\d+)\)$/;

/**
 * One line as `formatEvent` writes it, `HH:MM  message (xN)  [ccx 1.2.3]`,
 * taken apart. A line with no time in front is not one of those, and is kept
 * whole.
 */
function parse(event: string): { time: string; message: string; count: number } {
  if (!TIMED.test(event)) return { time: '', message: event, count: 1 };
  let message = event.slice(7);
  const build = message.lastIndexOf(BUILD);
  if (build >= 0 && message.endsWith(']')) message = message.slice(0, build);
  const repeated = REPEATED.exec(message);
  if (repeated) message = message.slice(0, repeated.index);
  return { time: event.slice(0, 5), message: plain(message), count: repeated ? Number(repeated[1]) : 1 };
}

/**
 * The last few things that happened, oldest first, each once: a repeat keeps
 * the time of its latest occurrence and says how many times it happened.
 */
export function plainRecent(events: readonly string[], limit = RECENT_LINES): string[] {
  const seen = new Map<string, { time: string; count: number }>();
  for (const event of events) {
    const { time, message, count } = parse(event);
    const before = seen.get(message);
    // Taken out and put back, so a repeat moves to where its latest occurrence is.
    seen.delete(message);
    seen.set(message, { time, count: (before?.count ?? 0) + count });
  }
  return [...seen]
    .slice(-limit)
    .map(([message, { time, count }]) => `${time ? `${time} ` : ''}${message}${count > 1 ? ` (x${count})` : ''}`);
}
