export type KeyAction =
  | 'quit'
  | 'move'
  | 'use'
  | 'force'
  | 'toggle'
  | 'rotate'
  | 'add'
  | 'rename'
  | 'login'
  /** Claude Desktop: when its conversations move by themselves (d). */
  | 'desktop-handoff'
  /** Claude Desktop: continue a moved conversation as a copy or as itself (m). */
  | 'desktop-mode'
  /** Claude Desktop: what a moved conversation carries on with (t). */
  | 'desktop-prompt'
  /** Claude Desktop: move one of its conversations to a terminal (D). */
  | 'desktop-move'
  /** Rotation: cycle which model sessions prefer (M). */
  | 'model-preference'
  /** Rotation: cycle how the next account is picked (o). */
  | 'pick-order'
  /** Priority: move the highlighted account up or down the order ([ and ]). */
  | 'move-up'
  | 'move-down'
  | 'none';

export interface KeyOutcome {
  /** New selection index (clamped to the row count). */
  selected: number;
  action: KeyAction;
}

function clamp(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

/**
 * Pure key dispatch for the live dashboard: given a key (and its first byte, for
 * control keys) plus the current selection, decide the new selection and which
 * action to run. Keeping this pure makes the interactive core testable without a
 * real terminal.
 */
export function dispatchKey(
  key: string,
  byte0: number | undefined,
  selected: number,
  count: number,
): KeyOutcome {
  // Esc quits too, matched on the KEY rather than on its first byte, because
  // byte0 is optional and a caller that omits it would otherwise not quit. A
  // chunk that IS a bare Escape is the key itself; one that merely STARTS with
  // it is an arrow or function key (`[A`), a different string, which still
  // reaches navigation and keeps moving the selection.
  if (key === 'q' || byte0 === 3 || byte0 === 4) return { selected, action: 'quit' };
  if (key === '') return { selected, action: 'quit' };
  if (key === 'j' || key === '\x1b[B') return { selected: clamp(selected + 1, count), action: 'move' };
  if (key === 'k' || key === '\x1b[A') return { selected: clamp(selected - 1, count), action: 'move' };
  // Enter (also u / p) activates the highlighted account: it becomes the one
  // your next `claude` uses, in the terminal and the editor.
  if (byte0 === 13 || byte0 === 10 || key === 'u' || key === 'p') {
    return { selected, action: 'use' };
  }
  if (key === 'f') return { selected, action: 'force' }; // instant switch (restarts the session)
  if (key === 'a') return { selected, action: 'add' }; // register another account
  if (key === 'n') return { selected, action: 'rename' }; // rename the highlighted one
  // Sign this account in again, as itself or as a different account. Either case:
  // l sits right next to j and k, so a stray press while moving is likely, and
  // that is handled by asking for confirmation rather than by hiding the key
  // behind shift. A key nobody can find is not a safe key, it is a missing one.
  if (key === 'l' || key === 'L') return { selected, action: 'login' };
  if (key === 'e') return { selected, action: 'toggle' };
  if (key === 'r') return { selected, action: 'rotate' };
  // Claude Desktop. Lowercase for the settings, which only cycle and are undone
  // by pressing again; the capital for the one that opens a window.
  if (key === 'd') return { selected, action: 'desktop-handoff' };
  if (key === 'm') return { selected, action: 'desktop-mode' };
  if (key === 't') return { selected, action: 'desktop-prompt' };
  if (key === 'D') return { selected, action: 'desktop-move' };
  // Rotation settings. The model is a capital because m already belongs to
  // Desktop; the brackets read as "up" and "down" the list.
  if (key === 'M') return { selected, action: 'model-preference' };
  if (key === 'o') return { selected, action: 'pick-order' };
  if (key === '[') return { selected, action: 'move-up' };
  if (key === ']') return { selected, action: 'move-down' };
  return { selected, action: 'none' };
}

/** Answer to a yes/no question in the dashboard. Anything but yes means no. */
export function confirmKey(key: string, byte0?: number): 'yes' | 'no' {
  if (key === 'y' || key === 'Y') return 'yes';
  if (byte0 === 13 || byte0 === 10) return 'yes';
  return 'no';
}
