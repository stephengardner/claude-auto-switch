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
    expect(source).toMatch(/const notice = \(message: string\): void => \{/);
    const start = source.indexOf('const notice = (message: string): void => {');
    const body = source.slice(start, source.indexOf('};', start));
    expect(body).toContain('logEvent(message)');
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

  it('settles a checked credential whether it was saved or REFUSED', () => {
    // The freeze. The ownership answer is an API call, and marking the
    // credential handled only on a successful save meant a refused one was
    // re-checked on every tick: twice a second, for the whole session. It filled
    // the log with 200 identical lines in 104 seconds and locked the machine up.
    //
    // A refusal is a settled answer about THIS credential. Nothing about it can
    // change until the file does, so asking again can only produce the same
    // refusal.
    const start = source.indexOf('void fetchTokenOwner(sessionDir)');
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, start + 1600);
    // Unconditional, not gated on saveBack's return value.
    expect(block).toContain('saveBack(account, owner);');
    expect(block).not.toContain('if (saveBack(account, owner)) mirroredStamp');
  });

  it('leaves a credential retryable when the API could not be reached', () => {
    // Different from a refusal: nothing was decided, so a network blip must not
    // mean a refreshed token is never written back for the rest of the session.
    const start = source.indexOf('void fetchTokenOwner(sessionDir)');
    const block = source.slice(start, start + 2000);
    const cat = block.indexOf('.catch(');
    expect(cat).toBeGreaterThan(0);
    const handler = block.slice(cat, block.indexOf('.finally(', cat));
    expect(handler).not.toContain('mirroredStamp = nowStamp');
  });
});
