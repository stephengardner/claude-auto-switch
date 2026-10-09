import { CasError } from './errors.js';

/**
 * Quote one word for sh, bash, zsh or fish alike.
 *
 * Single quotes are read the same by all four, except that fish treats a
 * backslash inside them as an escape. A backslash or control character is
 * therefore refused rather than escaped, and a single quote is closed, written
 * in double quotes, and reopened, which needs no backslash at all.
 */
export function shellQuote(word: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(word)) {
    throw new CasError(`cannot pass ${JSON.stringify(word)} through a shell safely`);
  }
  return `'${word.split("'").join(`'"'"'`)}'`;
}
