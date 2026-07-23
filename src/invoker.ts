/**
 * How to invoke the real `claude` binary. Usually just a path (`bin`), but tests
 * point `bin` at Node with `prefixArgs` pointing at the fake-claude script, so
 * the same call path drives both the real CLI and the fake with zero changes.
 */
export interface ClaudeInvoker {
  bin: string;
  prefixArgs?: string[];
}

/** Compose the full argument list for a claude invocation. */
export function invokerArgs(invoker: ClaudeInvoker, args: string[]): string[] {
  return [...(invoker.prefixArgs ?? []), ...args];
}
