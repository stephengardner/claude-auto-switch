/**
 * The crontab entry behind `ccx keepalive`.
 *
 * Every four hours it runs `ccx usage`, which renews any login whose access
 * token has expired (they last about eight hours), under the same rules that
 * keep it away from an account a session or an editor is using. A machine
 * nobody touches for a day can otherwise find its logins lapsed.
 *
 * The entry is found by its marker comment, so ccx only ever adds, replaces or
 * removes its own line and leaves the rest of the crontab as it was.
 */

export const KEEPALIVE_MARK = '# ccx keepalive';
/** Seventeen past, so it does not land on the hour with everyone else's jobs. */
const SCHEDULE = '17 */4 * * *';

/** cron turns an unescaped % in a command into a new line, so each one is escaped. */
export function keepaliveLine(command: string): string {
  return `${SCHEDULE} ${command.replaceAll('%', '\\%')} >/dev/null 2>&1 ${KEEPALIVE_MARK}`;
}

/** ccx's line, if cron would run it: a line commented out is not running. */
export function findKeepalive(crontab: string): string | null {
  return (
    crontab
      .split('\n')
      .find((line) => !line.trimStart().startsWith('#') && line.includes(KEEPALIVE_MARK)) ?? null
  );
}

/** The crontab with ccx's line replaced by `line`, or removed when `line` is null. */
export function withKeepalive(crontab: string, line: string | null): string {
  const kept = crontab.split('\n').filter((l) => !l.includes(KEEPALIVE_MARK));
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') kept.pop();
  if (line) kept.push(line);
  return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}
