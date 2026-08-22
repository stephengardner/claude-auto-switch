import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPtySession } from '../../src/launcher/pty-session.js';

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));

/**
 * The failure this exists to prevent, in one sentence: a session hit the same
 * wall over and over, every probe refused to confirm it, and ccx sat there
 * logging reasons not to act while the operator was blocked.
 *
 * Every guard on that path resolves uncertainty to "do not act", so they can
 * only ever agree to do nothing. Something has to be able to say "still stuck"
 * that none of them can veto.
 */
describe('a session that keeps hitting a wall nobody can explain', () => {
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_CAP_EVERY_MS;
    delete process.env.FAKE_CLAUDE_IDLE_MS;
  });

  function session(verifyCap: () => Promise<boolean>) {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-blocked-'));
    mkdirSync(dir, { recursive: true });
    process.env.FAKE_CLAUDE_CAP_EVERY_MS = '150';
    process.env.FAKE_CLAUDE_IDLE_MS = '30000';
    return runPtySession({
      claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
      args: [],
      configDir: dir,
      verifyCap,
      // Reached in seconds rather than minutes; production uses the defaults.
      blockedWatch: { after: 3, spreadMs: 600, minGapMs: 100 },
    });
  }

  it('moves anyway, even though every probe says the account has room', async () => {
    // The exact production shape: the API positively reports room every time,
    // so nothing downstream will ever confirm a cap. Before this, the session
    // ran until the operator gave up.
    let asked = 0;
    const outcome = await session(() => {
      asked += 1;
      return Promise.resolve(false); // refuted, every single time
    });

    expect(outcome.kind).toBe('capped');
    expect(asked).toBeGreaterThan(0); // it did ask; it just was not believed
    // Held briefly rather than benched: nothing was proven, so the pairing
    // comes back in minutes rather than the hours a confirmed cap buys.
    expect(outcome.resetAt).toBeDefined();
    expect(outcome.resetAt! - Date.now()).toBeLessThanOrEqual(2 * 60_000 + 5_000);
  }, 30_000);

  it('runs to the end refusing, if the pattern is never reached (the old behaviour)', async () => {
    // Proves the test above is detecting the fix and not something else. With
    // the threshold out of reach, this is exactly what shipped before: the
    // wall keeps arriving, every probe refutes it, and the session just keeps
    // going. That is the operator sitting blocked.
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-blocked-old-'));
    mkdirSync(dir, { recursive: true });
    process.env.FAKE_CLAUDE_CAP_EVERY_MS = '150';
    process.env.FAKE_CLAUDE_IDLE_MS = '2500';
    const outcome = await runPtySession({
      claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
      args: [],
      configDir: dir,
      verifyCap: () => Promise.resolve(false),
      blockedWatch: { after: Number.MAX_SAFE_INTEGER },
    });
    expect(outcome.kind).not.toBe('capped');
  }, 30_000);
  it('accumulates across refuted probes, at production pacing', async () => {
    // The case that matters, and the one a fast test hides. Real walls arrive
    // minutes apart, so EVERY episode gets probed and refuted before the next
    // one lands. Resetting on a refuted probe therefore clears the count every
    // single time and the pattern is never reached. The first version of this
    // change did exactly that, and the 150ms test above still passed because
    // episodes piled up faster than probes could resolve.
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-blocked-paced-'));
    mkdirSync(dir, { recursive: true });
    process.env.FAKE_CLAUDE_CAP_EVERY_MS = '400';
    process.env.FAKE_CLAUDE_IDLE_MS = '30000';
    let refuted = 0;
    const outcome = await runPtySession({
      claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
      args: [],
      configDir: dir,
      // Resolves immediately, so each refusal lands BETWEEN episodes.
      verifyCap: () => { refuted += 1; return Promise.resolve(false); },
      blockedWatch: { after: 3, spreadMs: 900, minGapMs: 100 },
      // Shorter than the gap between walls, so every episode really is probed
      // and refuted BEFORE the next one lands. With the 20s production backoff
      // the probes are suppressed instead, which hides the bug entirely.
      refuteBackoffMs: 150,
    });
    expect(outcome.kind).toBe('capped');
    expect(refuted).toBeGreaterThanOrEqual(1); // probes did run, and were not believed
  }, 30_000);
  it('still ends as a normal cap when the probe DOES confirm one', async () => {
    // The ordinary path has to keep working: a confirmed limit is a real cap,
    // not an unproven hold, and it carries whatever the probe reported.
    const outcome = await session(() => Promise.resolve(true));
    expect(outcome.kind).toBe('capped');
  }, 30_000);
});
