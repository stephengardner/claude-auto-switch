import { describe, it, expect } from 'vitest';
import {
  planConversation,
  relaunchArgs,
  freshStartArgs,
  wantsExistingConversation,
  conversationIdIn,
  withoutConversationFlags,
  looksLikeConversationId,
  withResumePrompt,
  hasOwnPrompt,
  startsByResuming,
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

  it('takes a NAMED resume with it, not just an id', () => {
    // `--resume` also accepts a session name or a search term. Leaving one
    // behind turns it into a stray positional argument to Claude, which is
    // neither what the operator typed nor anything Claude was asked for.
    expect(withoutConversationFlags(['--resume', 'auth-refactor', '-p'])).toEqual(['-p']);
    expect(withoutConversationFlags(['-r', 'my session', '-p'])).toEqual(['-p']);
    expect(relaunchArgs(['--resume', 'auth-refactor'], ID)).toEqual(['--resume', ID]);
    // Still not treated as an id: only a real UUID can be resumed exactly.
    expect(conversationIdIn(['--resume', 'auth-refactor'])).toBeNull();
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

describe('the prompt a session armed for its own relaunch', () => {
  it('rides a resume by id as the one prompt argument', () => {
    // `claude [options] [prompt]`: a resumed conversation that is also handed a
    // prompt submits it at once, so an unattended session carries on by itself.
    const relaunch = relaunchArgs(['--effort', 'max'], ID);
    expect(withResumePrompt(relaunch, 'carry on')).toEqual({
      applied: true,
      args: ['--effort', 'max', '--resume', ID, 'carry on'],
    });
  });

  it('rides a --continue relaunch the same way', () => {
    expect(withResumePrompt(relaunchArgs(['-p'], null), 'carry on')).toEqual({
      applied: true,
      args: ['-p', '--continue', 'carry on'],
    });
  });

  it('does not mistake a flag value for a prompt the operator typed', () => {
    const relaunch = relaunchArgs(['--model', 'opus', '--permission-mode', 'acceptEdits'], ID);
    expect(withResumePrompt(relaunch, 'carry on').applied).toBe(true);
  });

  it('stands aside when the run was launched with a prompt of its own', () => {
    // Claude takes ONE prompt. Adding a second would at best be ignored and at
    // worst refuse to start, so the armed prompt is skipped and the reason kept.
    const placed = withResumePrompt(relaunchArgs(['fix the flaky test'], ID), 'carry on');
    expect(placed.applied).toBe(false);
    expect(placed.args).toEqual(['fix the flaky test', '--resume', ID]);
    if (!placed.applied) expect(placed.reason).toMatch(/prompt of its own/);
  });

  it('sees the prompt after a flag that takes no value', () => {
    // The unattended runs this is for usually start this way. Reading the task
    // as the flag's value would hand Claude two prompts.
    for (const flag of [
      '--dangerously-skip-permissions',
      '--verbose',
      '--ide',
      '--strict-mcp-config',
    ]) {
      const relaunch = relaunchArgs([flag, 'fix the flaky test'], ID);
      expect(withResumePrompt(relaunch, 'carry on').applied).toBe(false);
    }
  });

  it('reads an optional value as the value, the way Claude does', () => {
    expect(withResumePrompt(relaunchArgs(['--debug', 'api'], ID), 'carry on').applied).toBe(true);
  });

  it('gives a list-taking flag every value up to the next flag', () => {
    const relaunch = relaunchArgs(['--add-dir', '../lib', '../docs', '--effort', 'max'], ID);
    expect(withResumePrompt(relaunch, 'carry on').applied).toBe(true);
  });

  it('keeps a value written into the flag itself out of the question', () => {
    expect(withResumePrompt(relaunchArgs(['--model=opus'], ID), 'carry on').applied).toBe(true);
    expect(withResumePrompt(relaunchArgs(['--model=opus', 'fix it'], ID), 'carry on').applied).toBe(
      false,
    );
  });

  it('stands aside when an unknown flag is followed by text, since that may be the prompt', () => {
    const relaunch = relaunchArgs(['--some-future-flag', 'something'], ID);
    expect(withResumePrompt(relaunch, 'carry on').applied).toBe(false);
  });

  it('counts everything after -- as the prompt, dash or not', () => {
    expect(hasOwnPrompt(['--', '-leading dash'])).toBe(true);
    expect(hasOwnPrompt(['--effort', 'max', '--'])).toBe(false);
  });
});

describe('the other spellings of a conversation flag', () => {
  it('reads --resume=<id> as --resume <id>, so ccx does not add a --session-id Claude refuses', () => {
    // Claude Desktop launches its sessions this way. Read as a fresh start, ccx
    // appended --session-id, and Claude will not take that with a resume.
    const plan = planConversation([`--resume=${ID}`], ids(OTHER));
    expect(plan).toEqual({ args: [`--resume=${ID}`], id: ID });
    expect(wantsExistingConversation([`--resume=${ID}`])).toBe(true);
    expect(conversationIdIn([`--session-id=${ID}`])).toBe(ID);
  });

  it('strips an inline value with its flag, and never the argument after it', () => {
    expect(withoutConversationFlags([`--resume=${ID}`, '--model', 'opus'])).toEqual([
      '--model',
      'opus',
    ]);
    expect(withoutConversationFlags([`--session-id=${ID}`, 'do the thing'])).toEqual([
      'do the thing',
    ]);
    expect(relaunchArgs([`--resume=${ID}`, '--effort', 'max'], ID)).toEqual([
      '--effort',
      'max',
      '--resume',
      ID,
    ]);
  });
});

describe('a fork', () => {
  const FORK = '77777777-6666-4555-8444-333333333333';

  it('is named up front, because the id after --resume is where it came FROM', () => {
    const plan = planConversation(['--resume', ID, '--fork-session'], ids(FORK));
    expect(plan.id).toBe(FORK);
    expect(plan.args).toEqual(['--resume', ID, '--fork-session', '--session-id', FORK]);
  });

  it('keeps a name the operator already gave it', () => {
    const plan = planConversation(
      ['--resume', ID, '--fork-session', '--session-id', FORK],
      ids(OTHER),
    );
    expect(plan).toEqual({
      args: ['--resume', ID, '--fork-session', '--session-id', FORK],
      id: FORK,
    });
    const inline = planConversation(
      [`--resume=${ID}`, '--fork-session', `--session-id=${FORK}`],
      ids(OTHER),
    );
    expect(inline.id).toBe(FORK);
  });

  it('does not claim a name Claude would reject', () => {
    const plan = planConversation(
      ['--resume', ID, '--fork-session', '--session-id', 'nope'],
      ids(OTHER),
    );
    expect(plan).toEqual({
      args: ['--resume', ID, '--fork-session', '--session-id', 'nope'],
      id: null,
    });
  });

  it('is named from --continue too', () => {
    expect(planConversation(['--continue', '--fork-session'], ids(FORK))).toEqual({
      args: ['--continue', '--fork-session', '--session-id', FORK],
      id: FORK,
    });
  });

  it('is resumed by a swap, never copied again', () => {
    // Keeping --fork-session made every swap another copy, and resuming the
    // source id dropped everything done in the copy.
    const plan = planConversation(['--resume', ID, '--fork-session', '--effort', 'max'], ids(FORK));
    expect(relaunchArgs(plan.args, plan.id)).toEqual(['--effort', 'max', '--resume', FORK]);
  });

  it('does not survive into a fresh start either', () => {
    expect(freshStartArgs(['--resume', ID, '--fork-session'], ids(OTHER)).args).toEqual([
      '--session-id',
      OTHER,
    ]);
  });

  it('means nothing without a resume, so a plain start is named as before', () => {
    expect(planConversation(['--fork-session'], ids(FORK))).toEqual({
      args: ['--fork-session', '--session-id', FORK],
      id: FORK,
    });
  });
});

describe('whether a launch picks a conversation back up by itself', () => {
  it('does for --continue and for a resume that names one', () => {
    for (const args of [['--continue'], ['-c'], ['--resume', ID], ['-r', ID], [`--resume=${ID}`]]) {
      expect(startsByResuming(args)).toBe(true);
    }
    expect(startsByResuming(['--resume', ID, '--fork-session', '--session-id', OTHER])).toBe(true);
  });

  it('does not for the picker, whose search term a prompt would become', () => {
    expect(startsByResuming(['--resume'])).toBe(false);
    expect(startsByResuming(['--resume', '--model', 'opus'])).toBe(false);
    expect(startsByResuming(['--resume='])).toBe(false);
  });

  it('does not for a new conversation, even one ccx named', () => {
    expect(startsByResuming([])).toBe(false);
    expect(startsByResuming(['--session-id', ID])).toBe(false);
  });
});
