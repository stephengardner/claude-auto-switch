import { describe, it, expect } from 'vitest';
import { COMMAND_NOT_FOUND, SSH_FAILED, SSH_UNAVAILABLE, type RemoteResult } from '../remote/ssh.js';
import { APPLY_EXIT, applyArgs, applyFollow, tellFollowers, type ApplyDeps, type FollowRequest } from './followers.js';
import type { HandPick } from './decide.js';
import type { SwitchOutcome } from './pass.js';

const request: FollowRequest = { from: 'work', to: 'personal', kind: 'early', by: 'my-server' };
const answer = (exitCode: number, stdout = '', stderr = ''): RemoteResult => ({ exitCode, stdout, stderr });

describe('asking the machines that follow', () => {
  it('sends each the same move, by account name', async () => {
    const asked: Array<{ host: string; args: string[] }> = [];
    await tellFollowers(['laptop', 'me@desk'], request, (host, args) => {
      asked.push({ host, args });
      return Promise.resolve(answer(0, 'now on personal\n'));
    });
    expect(asked.map((a) => a.host)).toEqual(['laptop', 'me@desk']);
    expect(asked[0]?.args).toEqual(['autoswitch', 'apply', '--from', 'work', '--to', 'personal', '--kind', 'early', '--by', 'my-server']);
    expect(applyArgs(request)).toEqual(asked[0]?.args);
  });

  it('says how each one took it, in what that machine said', async () => {
    const answers: Record<string, RemoteResult> = {
      followed: answer(APPLY_EXIT.followed, 'ccx 9.9.9\nnow on personal; 1 running session asked to follow\n'),
      elsewhere: answer(APPLY_EXIT.leftAlone, 'on side, not work; left as it is\n'),
      'not-added': answer(APPLY_EXIT.failed, 'no account "personal" here; add it with: ccx add personal\n'),
    };
    const outcomes = await tellFollowers(Object.keys(answers), request, (host) => Promise.resolve(answers[host] as RemoteResult));
    expect(outcomes).toEqual([
      { host: 'followed', ok: true, detail: 'now on personal; 1 running session asked to follow' },
      { host: 'elsewhere', ok: false, detail: 'on side, not work; left as it is' },
      { host: 'not-added', ok: false, detail: 'no account "personal" here; add it with: ccx add personal' },
    ]);
  });

  it('tells a machine that cannot be reached from one without ccx, and from no ssh here', async () => {
    const answers: Record<string, RemoteResult> = {
      off: answer(SSH_FAILED, '', 'ssh: connect to host off port 22: Connection timed out\n'),
      bare: answer(COMMAND_NOT_FOUND, '', 'sh: ccx: not found\n'),
      'no-ssh': answer(SSH_UNAVAILABLE, '', 'Error: spawn ssh ENOENT'),
      odd: answer(42, '', ''),
    };
    const outcomes = await tellFollowers(Object.keys(answers), request, (host) => Promise.resolve(answers[host] as RemoteResult));
    expect(outcomes.map((o) => o.detail)).toEqual([
      'could not reach it (ssh: connect to host off port 22: Connection timed out)',
      'ccx was not found there',
      'ssh could not be started here',
      'ccx there exited 42',
    ]);
    expect(outcomes.every((o) => !o.ok)).toBe(true);
  });

  it('marks the two answers worth asking again for: out of reach, and busy switching', async () => {
    const answers: Record<string, RemoteResult> = {
      asleep: answer(SSH_FAILED, '', 'ssh: connect to host asleep port 22: Operation timed out\n'),
      busy: answer(APPLY_EXIT.busy, 'another switch was in progress here; not followed yet\n'),
      elsewhere: answer(APPLY_EXIT.leftAlone, 'on side, not work; left as it is\n'),
      'not-added': answer(APPLY_EXIT.failed, 'no account "personal" here\n'),
      bare: answer(COMMAND_NOT_FOUND),
      followed: answer(APPLY_EXIT.followed, 'now on personal\n'),
    };
    const outcomes = await tellFollowers(Object.keys(answers), request, (host) => Promise.resolve(answers[host] as RemoteResult));
    expect(outcomes.filter((o) => o.retry).map((o) => o.host)).toEqual(['asleep', 'busy']);
    expect(outcomes.find((o) => o.host === 'busy')?.detail).toBe('another switch was in progress here; not followed yet');
  });

  it('never lets one machine fail the others', async () => {
    const outcomes = await tellFollowers(['-oProxyCommand=x', 'laptop'], request, (host) => {
      if (host.startsWith('-')) throw new Error(`"${host}" is not a host ssh can be given safely`);
      return Promise.resolve(answer(0, 'now on personal\n'));
    });
    expect(outcomes).toEqual([
      { host: '-oProxyCommand=x', ok: false, detail: '"-oProxyCommand=x" is not a host ssh can be given safely' },
      { host: 'laptop', ok: true, detail: 'now on personal' },
    ]);
  });

  it('asks nobody when no machine follows', async () => {
    expect(await tellFollowers([], request, () => Promise.reject(new Error('never asked')))).toEqual([]);
  });
});

describe('a machine asked to follow', () => {
  const here = (over: Partial<{ active: string | null; pick: HandPick | null; paused: string | null; earlyOff: boolean; signedIn: boolean; known: boolean; outcome: SwitchOutcome }> = {}) => {
    const made: Array<{ from: string; to: string; reason: string }> = [];
    const deps: ApplyDeps = {
      active: () => (over.active === undefined ? 'work' : over.active),
      account: () => (over.known === false ? null : { loggedIn: over.signedIn !== false }),
      controls: () => ({ paused: over.paused ?? null, earlyOff: over.earlyOff ?? false }),
      handPick: () => over.pick ?? null,
      switchTo: (from, to, reason) => {
        made.push({ from, to, reason });
        return over.outcome ?? { code: 'done', sessions: 1 };
      },
    };
    return { deps, made };
  };

  it('makes the same move when it is on the account being left', () => {
    const { deps, made } = here();
    expect(applyFollow(deps, request)).toEqual({ exit: APPLY_EXIT.followed, said: 'now on personal; 1 running session asked to follow' });
    expect(made).toEqual([{ from: 'work', to: 'personal', reason: 'followed my-server (early)' }]);
  });

  it('has nothing to do when it is there already', () => {
    const { deps, made } = here({ active: 'personal' });
    expect(applyFollow(deps, request)).toEqual({ exit: APPLY_EXIT.followed, said: 'already on personal' });
    expect(made).toEqual([]);
  });

  it('stays where it is when it is on some other account', () => {
    const { deps, made } = here({ active: 'side' });
    expect(applyFollow(deps, request)).toEqual({ exit: APPLY_EXIT.leftAlone, said: 'on side, not work; left as it is' });
    expect(made).toEqual([]);
  });

  it('keeps its own pick against an early move, and lets it go once that account cannot run', () => {
    const pick = { account: 'work', at: 1 };
    expect(applyFollow(here({ pick }).deps, request).exit).toBe(APPLY_EXIT.leftAlone);
    expect(applyFollow(here({ pick }).deps, { ...request, kind: 'spent' }).exit).toBe(APPLY_EXIT.followed);
  });

  it('keeps its own pause against every move, and its early-moves switch against early ones', () => {
    expect(applyFollow(here({ paused: 'upgrading' }).deps, { ...request, kind: 'spent' })).toEqual({
      exit: APPLY_EXIT.leftAlone,
      said: 'switching is paused here (upgrading); not followed',
    });
    expect(applyFollow(here({ earlyOff: true }).deps, request).exit).toBe(APPLY_EXIT.leftAlone);
    expect(applyFollow(here({ earlyOff: true }).deps, { ...request, kind: 'spent' }).exit).toBe(APPLY_EXIT.followed);
  });

  it('says what to do when the account is not there, or not signed in', () => {
    expect(applyFollow(here({ known: false }).deps, request)).toEqual({
      exit: APPLY_EXIT.failed,
      said: 'no account "personal" here; add it with: ccx add personal',
    });
    expect(applyFollow(here({ signedIn: false }).deps, request)).toEqual({
      exit: APPLY_EXIT.failed,
      said: '"personal" is not signed in here; sign it in with: ccx login personal',
    });
  });

  it('reports a switch that did not go through', () => {
    // Busy has an exit code of its own: it is the one answer worth asking again for.
    expect(applyFollow(here({ outcome: { code: 'busy' } }).deps, request)).toEqual({
      exit: APPLY_EXIT.busy,
      said: 'another switch was in progress here; not followed yet',
    });
    expect(applyFollow(here({ outcome: { code: 'changed', active: 'side' } }).deps, request)).toEqual({
      exit: APPLY_EXIT.leftAlone,
      said: 'on side, not work; left as it is',
    });
    expect(applyFollow(here({ outcome: { code: 'failed', why: 'disk full' } }).deps, request)).toEqual({
      exit: APPLY_EXIT.failed,
      said: 'disk full',
    });
  });
});
