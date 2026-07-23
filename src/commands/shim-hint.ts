import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MARKER = '.shim-hinted';

/** Offer the transparent shim only when it is not installed and not yet hinted. */
export function shouldHintShim(shimInstalled: boolean, alreadyHinted: boolean): boolean {
  return !shimInstalled && !alreadyHinted;
}

export function shimHintText(): string {
  return 'tip: run `ccx on` to type `claude` directly and auto-switch without `ccx run`. (shown once)';
}

export function wasHinted(configHome: string): boolean {
  return existsSync(path.join(configHome, MARKER));
}

/** Remember that the tip was shown, so it never repeats. */
export function markHinted(configHome: string): void {
  try {
    writeFileSync(path.join(configHome, MARKER), '');
  } catch {
    /* best effort: worst case the tip shows once more */
  }
}
