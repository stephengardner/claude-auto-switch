import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RESUME_PROMPT_FILE,
  RESUME_PROMPT_MAX_CHARS,
  checkResumePrompt,
  readResumePrompt,
  writeResumePrompt,
  clearResumePrompt,
} from './resume-prompt.js';

const sessionDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-resume-prompt-'));
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe('what a resume prompt may be', () => {
  it('keeps ordinary text exactly as written', () => {
    expect(checkResumePrompt('Resumed after a swap: carry on.')).toEqual({
      ok: true,
      prompt: 'Resumed after a swap: carry on.',
    });
  });

  it('turns every line break and control character into a space, one line on the command line', () => {
    // It becomes ONE argument to Claude, and a newline in an argument is where a
    // command line stops meaning what it says on some platforms. An escape
    // sequence could also move the cursor on the operator's terminal.
    expect(checkResumePrompt('first line\r\nsecond\tline\u001b[2Jend')).toEqual({
      ok: true,
      prompt: 'first line second line [2Jend',
    });
  });

  it('collapses runs of whitespace and trims the ends', () => {
    expect(checkResumePrompt('   carry    on   ')).toEqual({ ok: true, prompt: 'carry on' });
  });

  it('refuses an empty prompt rather than arming nothing', () => {
    for (const raw of ['', '   ', '\n\t\r']) {
      const checked = checkResumePrompt(raw);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.reason).toMatch(/empty/);
    }
  });

  it('refuses a prompt that starts with a dash, which Claude would read as a flag', () => {
    const checked = checkResumePrompt('--dangerously-do-something');
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(/flag/);
  });

  it('refuses a prompt longer than the cap instead of cutting it short', () => {
    // Truncating a prompt changes what it asks for, silently. Refusing says so.
    const checked = checkResumePrompt('a'.repeat(RESUME_PROMPT_MAX_CHARS + 1));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(String(RESUME_PROMPT_MAX_CHARS));
    expect(checkResumePrompt('a'.repeat(RESUME_PROMPT_MAX_CHARS)).ok).toBe(true);
  });
});

describe('arming, reading and disarming a session', () => {
  it('reads as unarmed when nothing was ever armed', () => {
    expect(readResumePrompt(sessionDir())).toEqual({ armed: false });
  });

  it('round-trips what it writes, normalised', () => {
    const dir = sessionDir();
    expect(writeResumePrompt(dir, 'carry\non')).toEqual({ ok: true, prompt: 'carry on' });
    expect(readResumePrompt(dir)).toEqual({ armed: true, prompt: 'carry on' });
  });

  it('refuses to write an invalid prompt and leaves any armed one in place', () => {
    const dir = sessionDir();
    writeResumePrompt(dir, 'the good one');
    const refused = writeResumePrompt(dir, '   ');
    expect(refused.ok).toBe(false);
    expect(readResumePrompt(dir)).toEqual({ armed: true, prompt: 'the good one' });
  });

  it('reads a hand-edited file that fails the rules as NOT armed, and says why', () => {
    // The command refuses these, so the file only gets here by hand. Reading it
    // as unarmed is the safe answer; the reason is what the relaunch logs.
    const dir = sessionDir();
    writeFileSync(path.join(dir, RESUME_PROMPT_FILE), '-oops', 'utf8');
    const read = readResumePrompt(dir);
    expect(read.armed).toBe(false);
    if (!read.armed) expect(read.invalid).toMatch(/flag/);
  });

  it('disarms, and disarming twice is not an error', () => {
    const dir = sessionDir();
    writeResumePrompt(dir, 'carry on');
    expect(clearResumePrompt(dir)).toBe(true);
    expect(existsSync(path.join(dir, RESUME_PROMPT_FILE))).toBe(false);
    expect(readResumePrompt(dir)).toEqual({ armed: false });
    expect(clearResumePrompt(dir)).toBe(false);
  });
});
