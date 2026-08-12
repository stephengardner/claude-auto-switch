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
  it('sends a mid-session message to the LOG and nowhere else', () => {
    // Not even an escape sequence. It renders nothing, but it is still bytes
    // pushed into a terminal that is mid-draw, which garbles the display and can
    // leave the terminal in a mode Claude is not expecting.
    expect(source).toMatch(/const notice = \(message: string, detail: EventDetail = \{\}\): void => \{/);
    const start = source.indexOf('const notice = (message: string, detail: EventDetail = {}): void => {');
    const body = source.slice(start, source.indexOf('};', start));
    expect(body).toContain('logEvent(message, detail)');
    expect(body).toContain('if (!claudeOwnsScreen)');
    expect(body).not.toContain('notifyTerminal');
  });

  it('goes silent on the terminal for exactly as long as Claude owns it', () => {
    // The flag and the terminal silence are set together, so they cannot drift
    // apart and leave ccx writing while it believes it is quiet.
    expect(source).toMatch(/const takeScreen = \(owned: boolean\): void => \{/);
    const start = source.indexOf('const takeScreen = (owned: boolean): void => {');
    const body = source.slice(start, source.indexOf('};', start));
    expect(body).toContain('claudeOwnsScreen = owned');
    expect(body).toContain('setTerminalOwnedElsewhere(owned)');
  });

  it('takes the screen for exactly as long as the session runs', () => {
    const region = midSessionRegion();
    expect(region).toContain('takeScreen(true);');
    // Released in a finally, so a session that throws does not leave ccx mute
    // and believing the screen is still taken.
    expect(region).toMatch(/finally \{\s*takeScreen\(false\);/);
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

  it('uses the tested mirror rules rather than its own bookkeeping', () => {
    // The behaviour itself is pinned in mirror-state.test.ts, where it can be
    // exercised properly: check twice, refuse, retry, out-of-order answers. What
    // matters here is that the session actually routes through those rules,
    // because a second copy of this bookkeeping is how it went wrong twice.
    expect(source).toContain("from '../session/mirror-state.js'");
    expect(source).toContain('shouldCheck(mirror,');
    expect(source).toContain('beginCheck(mirror,');
    expect(source).toContain('finishCheck(mirror,');
    expect(source).toContain('abandonCheck(mirror,');
    // No stamp variables of its own: one place decides, not two.
    expect(source).not.toContain('mirroredStamp');
    expect(source).not.toContain('checkingStamp');
  });

  it('records the API answer through finishCheck, not by hand', () => {
    // finishCheck is what distinguishes a settled answer (written or refused)
    // from a retryable failure. Assigning around it is how the freeze happened.
    const start = source.indexOf('void fetchTokenOwner(sessionDir)');
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, start + 1200);
    expect(block).toContain('finishCheck(mirror, nowStamp, saveBack(account, owner))');
    expect(block).toContain('abandonCheck(mirror, nowStamp)');
  });
});
