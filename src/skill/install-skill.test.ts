import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installSkill, removeSkill, skillPath, SKILL_MARK, SKILL_TEXT } from './install-skill.js';
import type { PathCtx } from '../config/paths.js';

function home(): PathCtx {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-skill-'));
  return { env: { HOME: dir, USERPROFILE: dir } };
}

describe('the /ccx skill', () => {
  it('lands in ~/.claude/skills/ccx, where Claude, Desktop and every ccx session read it', () => {
    const ctx = home();
    expect(installSkill(ctx)).toBe('installed');
    expect(skillPath(ctx)).toBe(path.join(ctx.env!.HOME as string, '.claude', 'skills', 'ccx', 'SKILL.md'));
    expect(readFileSync(skillPath(ctx), 'utf8')).toBe(SKILL_TEXT);
    expect(installSkill(ctx)).toBe('already');
  });

  it('is named ccx and says when to use it, which is how Claude finds it', () => {
    expect(SKILL_TEXT.startsWith('---\nname: ccx\ndescription: ')).toBe(true);
    expect(SKILL_TEXT).toContain('ccx swap --json');
    expect(SKILL_TEXT).toContain('AskUserQuestion');
  });

  it('brings an older copy of its own up to date, but never one the user took over', () => {
    const ctx = home();
    mkdirSync(path.dirname(skillPath(ctx)), { recursive: true });
    writeFileSync(skillPath(ctx), `old text\n${SKILL_MARK}\n`);
    expect(installSkill(ctx)).toBe('updated');
    writeFileSync(skillPath(ctx), 'my own version, mark removed');
    expect(installSkill(ctx)).toBe('user-owned');
    expect(readFileSync(skillPath(ctx), 'utf8')).toBe('my own version, mark removed');
    expect(removeSkill(ctx)).toBe('user-owned');
    expect(existsSync(skillPath(ctx))).toBe(true);
  });

  it('is removed by ccx off', () => {
    const ctx = home();
    installSkill(ctx);
    expect(removeSkill(ctx)).toBe('removed');
    expect(existsSync(path.dirname(skillPath(ctx)))).toBe(false);
    expect(removeSkill(ctx)).toBe('not-present');
  });
});
