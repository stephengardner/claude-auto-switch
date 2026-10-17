import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { autoRotateHeadless } from '../../src/launcher/rotating-run.js';
import type { RecordedRefusal } from '../../src/session/refused-turn.js';
import type { RunOptions } from '../../src/util/exec.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function acct(name: string, priority: number) {
  return { name, priority, enabled: true, dir: `/dir/${name}` };
}

const base = {
  claude: { bin: 'node' },
  accounts: [acct('A', 0), acct('B', 1)],
  loggedIn: new Set(['A', 'B']),
  now: () => 1000,
  defaultBackoffMinutes: 300,
  out: () => {},
  // These tests are about ROTATION, so the account's usage is taken as agreeing
  // with the text. What happens when it does NOT agree is the subject of its
  // own test below, because that is the case that used to cap healthy accounts.
  confirmCap: () => Promise.resolve({ limited: true }),
  recordChange: () => {},
};

describe('autoRotateHeadless', () => {
  it('rotates past a capped account to a healthy one', async () => {
    const calls: string[] = [];
    const run = async (_bin: string, _args: string[], opts?: RunOptions) => {
      const dir = opts?.env?.CLAUDE_CONFIG_DIR ?? '';
      calls.push(dir);
      if (dir === '/dir/A') return { stdout: '', stderr: 'Usage limit reached.', exitCode: 1 };
      return { stdout: 'hello from B', stderr: '', exitCode: 0 };
    };

    const result = await autoRotateHeadless(['-p', 'hi'], { ...base, ledger: { caps: [] }, run });
    expect(result.exitCode).toBe(0);
    expect(result.account).toBe('B');
    expect(result.rotations).toBe(1);
    expect(result.ledger.caps.map((c) => c.account)).toContain('A');
    expect(calls).toEqual(['/dir/A', '/dir/B']);
  });

  it('caps every account and reports exhaustion when all are capped', async () => {
    let message = '';
    const run = async () => ({ stdout: '', stderr: 'rate limit', exitCode: 1 });
    const result = await autoRotateHeadless(['-p', 'hi'], {
      ...base,
      out: (m) => {
        message += m;
      },
      ledger: { caps: [] },
      run,
    });
    expect(result.exitCode).toBe(1);
    expect(result.ledger.caps).toHaveLength(2);
    expect(message).toContain('capped');
  });

  it("rotates on Claude 2.1.302's words at a limit, with no refused turn in the run's record", async () => {
    const words = "You've hit your limit · resets 9pm (America/New_York)";
    const asked: string[] = [];
    const run = async (_bin: string, _args: string[], opts?: RunOptions) =>
      opts?.env?.CLAUDE_CONFIG_DIR === '/dir/A'
        ? { stdout: `${words}\n`, stderr: '', exitCode: 1 }
        : { stdout: 'hello from B', stderr: '', exitCode: 0 };

    const result = await autoRotateHeadless(['-p', 'hi'], {
      ...base,
      ledger: { caps: [] },
      run,
      confirmCap: (_account, text) => {
        asked.push(text);
        return Promise.resolve({ limited: true });
      },
    });
    // The words only start the check, which is asked with them.
    expect(asked).toEqual([words]);
    expect(result.account).toBe('B');
    expect(result.ledger.caps.map((c) => c.account)).toEqual(['A']);
  });

  it('does not rotate when the first account succeeds', async () => {
    const run = async () => ({ stdout: 'ok', stderr: '', exitCode: 0 });
    const result = await autoRotateHeadless(['-p', 'hi'], { ...base, ledger: { caps: [] }, run });
    expect(result.account).toBe('A');
    expect(result.rotations).toBe(0);
  });

  it('does NOT cap an account when its usage refutes the limit text', async () => {
    // A resumed conversation replays old limit messages, and code on screen can
    // talk about rate limits. Capping from the text alone took healthy accounts
    // out for hours: five of them inside 87 seconds on a real machine.
    const run = async () => ({ stdout: 'talking about rate limits', stderr: 'rate limit', exitCode: 1 });
    const result = await autoRotateHeadless(['-p', 'hi'], {
      ...base,
      ledger: { caps: [] },
      run,
      confirmCap: () => Promise.resolve({ limited: false, detail: 'five-hour window at 3%' }),
    });

    expect(result.ledger.caps).toEqual([]); // nothing was taken out of rotation
    expect(result.rotations).toBe(0);
    expect(result.account).toBe('A'); // it stayed on the account it started with
  });

  it('records a model-scoped limit WITH its model, so the account keeps working', async () => {
    // The difference between "switch to Opus and carry on" and "every account
    // has hit its limit, come back in five hours".
    const run = async () => ({ stdout: "you've reached your Fable 5 limit", stderr: '', exitCode: 1 });
    const result = await autoRotateHeadless(['-p', 'hi'], {
      ...base,
      accounts: [acct('A', 0)],
      loggedIn: new Set(['A']),
      ledger: { caps: [] },
      run,
      confirmCap: () => Promise.resolve({ limited: true, model: 'Fable', resetAt: 5555 }),
    });

    expect(result.ledger.caps).toHaveLength(1);
    expect(result.ledger.caps[0]!.model).toBe('Fable');
    expect(result.ledger.caps[0]!.capUntil).toBe(5555);
  });

  it('walks the ACCOUNTS on one model before falling back (model-first)', async () => {
    // The headless path used to change model on the spot and stay put, which
    // ignored the strategy entirely: a setting that governs one of the two
    // ways to run is a setting that lies about what it does.
    const runs: Array<{ dir: string; model: string | undefined }> = [];
    const run = async (_bin: string, args: string[], opts?: RunOptions) => {
      const at = args.indexOf('--model');
      runs.push({
        dir: opts?.env?.CLAUDE_CONFIG_DIR ?? '',
        model: at >= 0 ? args[at + 1] : undefined,
      });
      // Out of Fable everywhere; fine on the fallback.
      return runs.length <= 2
        ? { stdout: "you've reached your Fable 5 limit", stderr: '', exitCode: 1 }
        : { stdout: 'done', stderr: '', exitCode: 0 };
    };

    const result = await autoRotateHeadless(['-p', 'hi', '--model', 'fable'], {
      ...base,
      ledger: { caps: [] },
      run,
      modelPreference: ['fable', 'opus'],
      modelStrategy: 'model-first',
      confirmCap: () => Promise.resolve({ limited: true, model: 'Fable' }),
    });

    expect(result.exitCode).toBe(0);
    // A on Fable, then B on Fable (not A on Opus), and only then the fallback.
    expect(runs.map((r) => `${r.dir}:${r.model}`)).toEqual([
      '/dir/A:fable',
      '/dir/B:fable',
      '/dir/A:opus',
    ]);
  });

  it('honours a model limit an EARLIER run recorded, instead of rediscovering it', async () => {
    // This path reads no usage numbers, so the ledger is the only thing that
    // remembers. Without it a fresh run offers Fable straight back to the
    // account that ran out of it minutes ago.
    const runs: string[] = [];
    const run = async (_bin: string, args: string[], opts?: RunOptions) => {
      const at = args.indexOf('--model');
      runs.push(`${opts?.env?.CLAUDE_CONFIG_DIR ?? ''}:${at >= 0 ? args[at + 1] : 'none'}`);
      return { stdout: 'done', stderr: '', exitCode: 0 };
    };

    await autoRotateHeadless(['-p', 'hi', '--model', 'fable'], {
      ...base,
      // A's Fable ran out earlier and has not reset yet.
      ledger: { caps: [{ account: 'A', capUntil: 9_999_999, reason: 'usage cap', at: 900, model: 'fable' }] },
      run,
      modelPreference: ['fable', 'opus'],
      modelStrategy: 'model-first',
    });

    // Straight to B on Fable: A is not offered Fable it demonstrably lacks.
    expect(runs).toEqual(['/dir/B:fable']);
  });

  it('says WHICH chain ran out, not that every account is capped', async () => {
    // Model-scoped exhaustion can leave every account perfectly usable. The
    // generic message is false then, and hides what actually happened.
    let said = '';
    const run = async () => ({ stdout: "you've reached your Fable 5 limit", stderr: '', exitCode: 1 });
    const result = await autoRotateHeadless(['-p', 'hi', '--model', 'fable'], {
      ...base,
      accounts: [acct('A', 0)],
      loggedIn: new Set(['A']),
      ledger: { caps: [] },
      run,
      out: (m) => {
        said += `${m}\n`;
      },
      modelPreference: ['fable'],
      modelStrategy: 'model-first',
      confirmCap: () => Promise.resolve({ limited: true, model: 'fable' }),
    });

    expect(result.exitCode).toBe(1);
    expect(said).toContain('out of fable');
    expect(said).not.toContain('all accounts are capped');
  });

  it('tries every pairing when the model in use is not in the preference', async () => {
    // The chain leads with the model in use even when it is not on the list,
    // so --model sonnet against a fable/opus preference has THREE models to
    // get through. Sizing the loop from the preference alone stopped it after
    // five attempts, leaving a pairing untried.
    const runs: string[] = [];
    let lastModel = 'sonnet';
    const run = async (_bin: string, args: string[], opts?: RunOptions) => {
      const at = args.indexOf('--model');
      lastModel = at >= 0 ? (args[at + 1] as string) : 'sonnet';
      runs.push(`${opts?.env?.CLAUDE_CONFIG_DIR ?? ''}:${lastModel}`);
      return { stdout: 'limit reached', stderr: '', exitCode: 1 };
    };

    const result = await autoRotateHeadless(['-p', 'hi', '--model', 'sonnet'], {
      ...base,
      ledger: { caps: [] },
      run,
      modelPreference: ['fable', 'opus'],
      modelStrategy: 'model-first',
      confirmCap: () => Promise.resolve({ limited: true, model: lastModel }),
    });

    expect(result.exitCode).toBe(1); // everything really was out
    expect(runs).toEqual([
      '/dir/A:sonnet',
      '/dir/B:sonnet',
      '/dir/A:fable',
      '/dir/B:fable',
      '/dir/A:opus',
      '/dir/B:opus',
    ]);
  });

  it('walks the MODELS on one account first when told to (account-first)', async () => {
    const runs: Array<{ dir: string; model: string | undefined }> = [];
    const run = async (_bin: string, args: string[], opts?: RunOptions) => {
      const at = args.indexOf('--model');
      runs.push({
        dir: opts?.env?.CLAUDE_CONFIG_DIR ?? '',
        model: at >= 0 ? args[at + 1] : undefined,
      });
      return runs.length <= 1
        ? { stdout: "you've reached your Fable 5 limit", stderr: '', exitCode: 1 }
        : { stdout: 'done', stderr: '', exitCode: 0 };
    };

    await autoRotateHeadless(['-p', 'hi', '--model', 'fable'], {
      ...base,
      ledger: { caps: [] },
      run,
      modelPreference: ['fable', 'opus'],
      modelStrategy: 'account-first',
      confirmCap: () => Promise.resolve({ limited: true, model: 'Fable' }),
    });

    expect(runs.map((r) => `${r.dir}:${r.model}`)).toEqual(['/dir/A:fable', '/dir/A:opus']);
  });

  it('starts the next model and keeps the account after a model-scoped cap', async () => {
    // The recorded cap is only half the job: the run itself must continue on
    // the fallback model instead of ending on an account with room left.
    const invocations: string[][] = [];
    let call = 0;
    const run = async (_bin: string, args: string[]) => {
      invocations.push(args);
      call += 1;
      return call === 1
        ? { stdout: '', stderr: "you've reached your Fable 5 limit", exitCode: 1 }
        : { stdout: 'done on the fallback', stderr: '', exitCode: 0 };
    };
    // A clock that moves, so the Fable limit is recorded before the Opus
    // attempt starts and only its model can keep it on the ledger.
    let clock = 1000;
    const result = await autoRotateHeadless(['-p', 'hi'], {
      ...base,
      now: () => (clock += 10),
      accounts: [acct('A', 0)],
      loggedIn: new Set(['A']),
      ledger: { caps: [] },
      run,
      modelPreference: ['fable', 'opus'],
      confirmCap: () => Promise.resolve({ limited: true, model: 'Fable' }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.account).toBe('A');
    expect(invocations).toHaveLength(2);
    expect(invocations[1]!.join(' ')).toContain('--model opus');
    // Running fine on Opus says nothing about Fable.
    expect(result.ledger.caps.map((c) => `${c.account}:${c.model}`)).toEqual(['A:Fable']);
  });

  it('with most-room order, starts on the least-used account, not the lowest priority', async () => {
    // A is priority 0 (the classic first) but heavily used; B has more room, so
    // the most-room order reaches for B first. Headless rotation must honour the
    // same `ccx order` setting as the interactive path.
    const calls: string[] = [];
    const run = async (_bin: string, _args: string[], opts?: RunOptions) => {
      calls.push(opts?.env?.CLAUDE_CONFIG_DIR ?? '');
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    };
    const result = await autoRotateHeadless(['-p', 'hi'], {
      ...base,
      order: 'most-room' as const,
      roomOf: (name: string) => (name === 'B' ? 0.9 : 0.1),
      ledger: { caps: [] },
      run,
    });
    expect(result.account).toBe('B');
    expect(result.rotations).toBe(0);
    expect(calls).toEqual(['/dir/B']); // launched B first, never A
  });
});
describe("the refused turn a print-mode run's own record holds", () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const FORK = '22222222-2222-4333-8444-555555555555';
  const MINE = "You've hit your session limit · resets 6pm (America/New_York)";
  const THEIRS = "You've hit your session limit · resets 9pm (America/New_York)";

  /** A refusal as Claude 2.1.302 writes one, `afterMs` from now. */
  const refusal = (text: string, afterMs: number): string =>
    JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      isApiErrorMessage: true,
      error: 'rate_limit',
      apiError: 'usage_limit_reached',
      apiErrorStatus: 429,
      apiErrorParams: { rate_limit_info: { rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 } },
      timestamp: new Date(Date.now() + afterMs).toISOString(),
      message: { content: [{ type: 'text', text }] },
    });

  /** A run on account folder `dir` that writes `lines` into the record of `id` and prints `stdout`, failing. */
  const runWriting = (dir: string, id: string, lines: string[], stdout: string) => async () => {
    const folder = path.join(dir, 'projects', 'work');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, `${id}.jsonl`), lines.map((l) => `${l}`).join(String.fromCharCode(10)));
    return { stdout, stderr: '', exitCode: 1 };
  };

  async function recordedFor(
    args: string[],
    run: (bin: string, argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
    dir: string,
  ) {
    const seen: RecordedRefusal[] = [];
    await autoRotateHeadless(args, {
      ...base,
      accounts: [{ name: 'A', priority: 0, enabled: true, dir }],
      loggedIn: new Set(['A']),
      ledger: { caps: [] },
      run,
      confirmCap: (_account, _text, recorded) => {
        if (recorded) seen.push(recorded);
        return Promise.resolve({ limited: false });
      },
    });
    return seen;
  }

  it('is the one it printed, of two runs resuming one conversation, though the other wrote later', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-print-two-'));
    const printed = JSON.stringify({ type: 'result', is_error: true, result: MINE, session_id: ID });
    const seen = await recordedFor(
      ['-p', '--resume', ID, 'hi'],
      runWriting(dir, ID, [refusal(MINE, 10), refusal(THEIRS, 20)], printed),
      dir,
    );
    expect(seen.map((r) => r.refusal.text)).toEqual([MINE]);
    expect(await seen[0]?.shown?.()).toBe(true);
  });

  it('proves nothing when two refusals since it started read like what it printed', async () => {
    // The same words from two runs on one conversation: which limit, and which
    // reset, was this run's cannot be told.
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-print-same-'));
    const printed = JSON.stringify({ type: 'result', is_error: true, result: MINE, session_id: ID });
    const seen = await recordedFor(
      ['-p', '--resume', ID, 'hi'],
      runWriting(dir, ID, [refusal(MINE, 10), refusal(MINE, 20)], printed),
      dir,
    );
    expect(seen).toHaveLength(1);
    expect(await seen[0]?.shown?.()).toBe(false);
  });

  /** A plain-text run that writes `lines` into the record of the conversation it was given, prints `stdout` and fails. */
  const plainRunWriting = (dir: string, lines: string[], stdout: string) => async (_bin: string, argv: string[]) => {
    const at = argv.indexOf('--session-id');
    const id = at === -1 ? undefined : argv[at + 1];
    if (id !== undefined) {
      const folder = path.join(dir, 'projects', 'work');
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, `${id}.jsonl`), lines.join(String.fromCharCode(10)));
    }
    return { stdout, stderr: '', exitCode: 1 };
  };

  it('is found for a plain-text run by the conversation ccx gave it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-print-plain-'));
    const seen = await recordedFor(['-p', 'hi'], plainRunWriting(dir, [refusal(MINE, 10)], `${MINE}\n`), dir);
    expect(seen.map((r) => r.refusal.text)).toEqual([MINE]);
    expect(seen[0]?.conversation).toEqual(expect.stringMatching(UUID));
    expect(await seen[0]?.shown?.()).toBe(true);
  });

  it('proves nothing for a plain-text run that did not print it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-print-plain-unshown-'));
    const seen = await recordedFor(
      ['-p', 'hi'],
      plainRunWriting(dir, [refusal(THEIRS, 10)], 'Something else went wrong.\n'),
      dir,
    );
    expect(seen).toHaveLength(1);
    expect(await seen[0]?.shown?.()).toBe(false);
  });

  it('is read from the conversation a fork reports, not the one it was copied from', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-print-fork-'));
    const printed = JSON.stringify({ type: 'result', is_error: true, result: MINE, session_id: FORK });
    const seen = await recordedFor(
      ['-p', '--resume', ID, '--fork-session', '--output-format', 'json', 'hi'],
      runWriting(dir, FORK, [refusal(MINE, 10)], printed),
      dir,
    );
    expect(seen.map((r) => r.conversation)).toEqual([FORK]);
  });
});

describe('the conversation ccx gives a print-mode run', () => {
  const ID = '33333333-4444-4555-8666-777777777777';

  /** The arguments each launch was given: A out of room, B fine. */
  async function launchedWith(args: string[]): Promise<string[][]> {
    const seen: string[][] = [];
    const run = async (_bin: string, argv: string[], opts?: RunOptions) => {
      seen.push(argv);
      return opts?.env?.CLAUDE_CONFIG_DIR === '/dir/A'
        ? { stdout: '', stderr: 'Usage limit reached.', exitCode: 1 }
        : { stdout: 'ok', stderr: '', exitCode: 0 };
    };
    await autoRotateHeadless(args, { ...base, ledger: { caps: [] }, run });
    return seen;
  }

  const idIn = (argv: string[] | undefined): string | undefined =>
    argv === undefined ? undefined : argv[argv.indexOf('--session-id') + 1];

  it('is a new one for each launch when the person named none', async () => {
    const seen = await launchedWith(['-p', 'hi']);
    expect(seen).toHaveLength(2);
    const [onA, onB] = seen.map(idIn);
    expect(seen).toEqual([
      ['-p', 'hi', '--session-id', onA],
      ['-p', 'hi', '--session-id', onB],
    ]);
    expect(onA).toEqual(expect.stringMatching(UUID));
    expect(onB).toEqual(expect.stringMatching(UUID));
    expect(onB).not.toBe(onA);
  });

  it('goes before a `--`, after which Claude reads everything as the prompt', async () => {
    const [argv] = await launchedWith(['-p', '--', '--continue']);
    expect(argv).toEqual(['-p', '--session-id', idIn(argv), '--', '--continue']);
    expect(idIn(argv)).toEqual(expect.stringMatching(UUID));
  });

  // Each spelling a person can name a conversation with, beside a command line
  // with none, which ccx then names itself.
  it.each<[string, string[]]>([
    ['--resume <id>', ['-p', '--resume', ID, 'hi']],
    ['--resume=<id>', ['-p', `--resume=${ID}`, 'hi']],
    ['--resume, the picker', ['-p', 'hi', '--resume']],
    ['-r <id>', ['-p', '-r', ID, 'hi']],
    ['-r<id>', ['-p', `-r${ID}`, 'hi']],
    ['--continue', ['-p', '--continue', 'hi']],
    ['-c', ['-p', '-c', 'hi']],
    ['-c in a cluster', ['-p', '-pc', 'hi']],
    ['--session-id <id>', ['-p', '--session-id', ID, 'hi']],
    ['--session-id=<id>', ['-p', `--session-id=${ID}`, 'hi']],
    ['--fork-session', ['-p', '--fork-session', 'hi']],
    ['--from-pr', ['-p', '--from-pr', '123', 'hi']],
    ['--teleport', ['-p', '--teleport', 'hi']],
    ['--cloud', ['-p', '--cloud', 'hi']],
    ['--remote', ['-p', '--remote', 'hi']],
  ])('is the one named with %s, the command line left as typed', async (_form, named) => {
    for (const argv of await launchedWith(named)) expect(argv).toEqual(named);
    const [bare] = await launchedWith(['-p', 'hi']);
    expect(bare).toEqual(['-p', 'hi', '--session-id', idIn(bare)]);
  });

  it('never takes an option value or the prompt for a conversation flag', async () => {
    // `-dc` is --debug with the filter "c", not -d and -c.
    const typed = ['-p', '-dc', '--name', 'resume', 'continue the refactor'];
    const [argv] = await launchedWith(typed);
    expect(argv).toEqual([...typed, '--session-id', idIn(argv)]);
    expect(idIn(argv)).toEqual(expect.stringMatching(UUID));
  });
});
