export type KeyAction = 'quit' | 'move' | 'pin' | 'toggle' | 'rotate' | 'none';

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
  if (key === 'q' || byte0 === 3 || byte0 === 4) return { selected, action: 'quit' };
  if (key === 'j' || key === '\x1b[B') return { selected: clamp(selected + 1, count), action: 'move' };
  if (key === 'k' || key === '\x1b[A') return { selected: clamp(selected - 1, count), action: 'move' };
  if (key === 'p') return { selected, action: 'pin' };
  if (key === 'e') return { selected, action: 'toggle' };
  if (key === 'r') return { selected, action: 'rotate' };
  return { selected, action: 'none' };
}
