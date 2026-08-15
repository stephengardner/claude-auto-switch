import { describe, it, expect } from 'vitest';
import {
  planConversation,
  relaunchArgs,
  freshStartArgs,
  wantsExistingConversation,
  conversationIdIn,
  withoutConversationFlags,
  looksLikeConversationId,
} from './conversation.js';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';
const ids = (...values: string[]): (() => string) => {
  let i = 0;
  return () => values[i++] ?? 'exhausted';
};

describe('deciding which conversation a run is in', () => {
  it('NAMES a fresh conversation, so a swap can resume exactly it', () => {
    // The whole point. `--continue` means "the most recent conversation in this
    // directory", so with two sessions open on one project a swap in either of
    // them could pick up the other one's thread. An id of our own cannot be
    // confused with anybody else's.
    const plan = planConversation(['--model', 'opus'], ids(ID));
    expect(plan.id).toBe(ID);
    expect(plan.args).toEqual(['--model', 'opus', '--session-id', ID]);
  });

  it('leaves a conversation the operator asked for exactly as typed', () => {
    // They may be resuming a specific thread. Rewriting that would be ccx
    // deciding which conversation they are in, which is the bug, not the fix.
    for (const args of [['--continue'], ['-c'], ['--resume'], ['-r']]) {
      const plan = planConversation([...args], ids(ID));
      expect(plan.args).toEqual(args);
      expect(plan.id).toBeNull();
    }
  });

  it('adopts an id the operator named, rather than inventing another', () => {
    for (const args of [
      ['--resume', OTHER],
      ['-r', OTHER],
      ['--session-id', OTHER],
    ]) {
      const plan = planConversation([...args], ids(ID));
      expect(plan.id).toBe(OTHER);
      expect(plan.args).toEqual(args);
    }
  });
});

describe('two sessions open on the same project', () => {
  it('never resumes the OTHER terminal’s conversation', () => {
    // The reported failure, stated directly: after switching accounts, the
    // session came back in a parallel conversation rather than its own. Each
    // run names its own thread, so "most recent in this directory" stops being
    // part of the answer at all.
    const a = planConversation([], ids(ID));
    const b = planConversation([], ids(OTHER));
    expect(a.id).not.toBe(b.id);

    const aAfterSwap = relaunchArgs(a.args, a.id);
    const bAfterSwap = relaunchArgs(b.args, b.id);
    expect(aAfterSwap).toContain(ID);
    expect(aAfterSwap).not.toContain(OTHER);
    expect(bAfterSwap).toContain(OTHER);
    expect(bAfterSwap).not.toContain(ID);
    // And neither falls back to the directory-scoped flag that caused it.
    expect(aAfterSwap).not.toContain('--continue');
    expect(bAfterSwap).not.toContain('--continue');
  });

  it('stays on its own conversation across MANY swaps, not just the first', () => {
    const plan = planConversation([], ids(ID));
    let args = plan.args;
    for (let swap = 0; swap < 5; swap++) {
      args = relaunchArgs(args, plan.id);
      expect(args.filter((a) => a === '--resume')).toHaveLength(1);
      expect(conversationIdIn(args)).toBe(ID);
    }
  });
});

describe('picking the conversation back up after a swap', () => {
  it('resumes THIS run’s conversation by id', () => {
    expect(relaunchArgs(['--model', 'opus'], ID)).toEqual(['--model', 'opus', '--resume', ID]);
  });

  it('replaces the flags already there instead of stacking another on', () => {
    // A swap relaunches args that already came back from a previous swap. Two
    // resume flags on one command line is at best ignored and at worst the
    // wrong conversation.
    expect(relaunchArgs(['-p', '--resume', OTHER], ID)).toEqual(['-p', '--resume', ID]);
    expect(relaunchArgs(['-p', '--continue'], ID)).toEqual(['-p', '--resume', ID]);
    expect(relaunchArgs(['-p', '--session-id', OTHER], ID)).toEqual(['-p', '--resume', ID]);
  });

  it('falls back to the old behaviour when nothing knows the id', () => {
    // Worse than resuming by id, but it is what was available before and it is
    // the best answer when nothing has told us which conversation this is.
    expect(relaunchArgs(['-p'], null)).toEqual(['-p', '--continue']);
  });
});

describe('starting over when there is nothing to resume', () => {
  it('names the new conversation instead of leaving the run on a dead id', () => {
    // Without this, every later swap resumes the id that just failed, fails
    // again, and starts fresh again: the conversation is lost on every swap
    // rather than once.
    const fresh = freshStartArgs(['--model', 'opus', '--resume', OTHER], ids(ID));
    expect(fresh.id).toBe(ID);
    expect(fresh.args).toEqual(['--model', 'opus', '--session-id', ID]);
  });

  it('is genuinely fresh, carrying no resume flag the operator typed', () => {
    expect(freshStartArgs(['-c', '-p'], ids(ID)).args).toEqual(['-p', '--session-id', ID]);
  });
});

describe('reading conversation flags', () => {
  it('sees every spelling that asks for an existing conversation', () => {
    expect(wantsExistingConversation(['--continue'])).toBe(true);
    expect(wantsExistingConversation(['-p', '-c'])).toBe(true);
    expect(wantsExistingConversation(['--resume', ID])).toBe(true);
    expect(wantsExistingConversation(['-r'])).toBe(true);
    expect(wantsExistingConversation([])).toBe(false);
    expect(wantsExistingConversation(['--model', 'opus'])).toBe(false);
    // A fresh start that merely NAMES its conversation is not a resume: there
    // is nothing to find, so "no conversation found" must not be watched for.
    expect(wantsExistingConversation(['--session-id', ID])).toBe(false);
  });

  it('is not fooled by a longer flag that starts the same way', () => {
    expect(wantsExistingConversation(['--continue-session'])).toBe(false);
    expect(wantsExistingConversation(['--resume-last'])).toBe(false);
  });

  it('does not mistake the next flag for an id', () => {
    // `--resume` with nothing after it opens a picker. Reading the next
    // argument as its id would both invent an id and eat a real flag.
    expect(conversationIdIn(['--resume', '--model', 'opus'])).toBeNull();
    expect(conversationIdIn(['--resume'])).toBeNull();
    expect(conversationIdIn(['--resume', 'not-a-uuid'])).toBeNull();
    expect(conversationIdIn(['--resume', ID])).toBe(ID);
  });

  it('accepts only real UUIDs, which is all Claude accepts', () => {
    expect(looksLikeConversationId(ID)).toBe(true);
    expect(looksLikeConversationId('abc')).toBe(false);
    expect(looksLikeConversationId('')).toBe(false);
    expect(looksLikeConversationId(undefined)).toBe(false);
  });
});

describe('stripping conversation flags', () => {
  it('removes every spelling, and the ids they carry', () => {
    expect(withoutConversationFlags(['--continue', '-p', '-c'])).toEqual(['-p']);
    expect(withoutConversationFlags(['--resume', ID, '-p'])).toEqual(['-p']);
    expect(withoutConversationFlags(['-r', ID, '-p'])).toEqual(['-p']);
    expect(withoutConversationFlags(['--session-id', ID, '-p'])).toEqual(['-p']);
  });

  it('keeps a real argument that follows a bare --resume', () => {
    expect(withoutConversationFlags(['--resume', '--model', 'opus'])).toEqual(['--model', 'opus']);
  });

  it('leaves everything else in order', () => {
    expect(withoutConversationFlags(['--model', 'opus', '--continue', '-p'])).toEqual([
      '--model',
      'opus',
      '-p',
    ]);
  });

  it('does not mutate what it was given', () => {
    const args = ['--continue'];
    withoutConversationFlags(args);
    expect(args).toEqual(['--continue']);
  });
});
