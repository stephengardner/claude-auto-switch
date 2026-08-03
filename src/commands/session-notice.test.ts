import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * ccx must not print into Claude's interface.
 *
 * Reported: "these annoying [ccx] usage limit blah messages come up and actually
 * insert themselves into the UI of claude". They were doing exactly that. While
 * a session runs, Claude owns the screen, so anything ccx writes to stderr lands
 * inside its interface, and the worst offender fired whenever limit-looking text
 * rendered, which includes a conversation that merely TALKS about rate limits.
 *
 * Checked by reading the source: the property is "no mid-session path writes to
 * the screen", which is about which call is used where, not about a value some
 * function returns.
 */

const source = readFileSync(new URL('./session.ts', import.meta.url), 'utf8');

/** The body of runSession, which is everything that can run while Claude is up. */
function midSessionRegion(): string {
  const start = source.indexOf('runSession: async (');
  const end = source.indexOf('markCapped: (accountName', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('what ccx says while Claude owns the screen', () => {
  it('routes messages through notice(), which does not draw on the screen', () => {
    expect(source).toMatch(/const notice = \(message: string\): void => \{/);
    expect(source).toMatch(/if \(claudeOwnsScreen\) notifyTerminal/);
  });

  it('marks the screen as Claude own for exactly as long as the session runs', () => {
    const region = midSessionRegion();
    expect(region).toContain('claudeOwnsScreen = true;');
    // Cleared in a finally, so a session that throws does not leave ccx believing
    // the screen is still taken and silently swallowing everything afterwards.
    expect(region).toMatch(/finally \{\s*claudeOwnsScreen = false;/);
  });

  it('writes to the screen for ONE thing only: a login problem before launch', () => {
    // Everything else goes to the log and the terminal notification. A line per
    // session start was the most frequent offender and is gone; the account is
    // already shown in Claude's status line and in the terminal title.
    const region = midSessionRegion();
    const writes = [...region.matchAll(/err\(/g)];
    expect(writes).toHaveLength(1);
    expect(region).toContain('err(readinessNote)');
  });

  it('never puts the identity-guard message on the screen, whoever owns it', () => {
    // Reported twice. It can fire on every credential change, the operator
    // cannot act on it mid-session, and it was landing in Claude's interface.
    // Log only: `ccx doctor` reports the same mismatch properly.
    const idx = source.indexOf('if (!decision.save) {');
    expect(idx).toBeGreaterThan(0);
    const branch = source.slice(idx, idx + 600);
    expect(branch).toContain('logEvent(decision.reason)');
    expect(branch).not.toContain('err(');
    expect(branch).not.toContain('notice(decision.reason)');
  });

  it('keeps the noisiest message off the screen specifically', () => {
    // This is the one that fires when a conversation merely mentions rate limits.
    const idx = source.indexOf('limit text on screen');
    expect(idx).toBeGreaterThan(0);
    const line = source.slice(source.lastIndexOf('\n', source.lastIndexOf('(', idx)), idx);
    expect(line).toContain('notice');
  });
});
