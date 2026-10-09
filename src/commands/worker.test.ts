import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerWorkerCommand, reportLine, resultObject, workerOutput, type WorkerOptions } from './worker.js';

/** The command line as the real parser hands it to the worker. */
async function parsed(argv: string[]): Promise<{ words: string[]; options: WorkerOptions; passthrough: string[] }> {
  const program = new Command().exitOverride();
  let got: { words: string[]; options: WorkerOptions; passthrough: string[] } | null = null;
  const full = ['node', 'ccx', ...argv];
  registerWorkerCommand(
    program,
    () => full,
    (words, options, passthrough) => {
      got = { words, options, passthrough };
      return Promise.resolve();
    },
  );
  await program.parseAsync(full);
  if (!got) throw new Error('the worker command did not run');
  return got;
}

describe('the worker command line', () => {
  it('hands everything after -- to Claude, and the rest is the brief', async () => {
    const got = await parsed(['worker', '--agent', 'coder', 'fix it', '--', '--max-turns', '5']);
    expect(got.words).toEqual(['fix it']);
    expect(got.passthrough).toEqual(['--max-turns', '5']);
    expect(got.options.agent).toBe('coder');
  });

  it('has nothing for Claude without --', async () => {
    expect(await parsed(['worker', 'fix', 'it'])).toMatchObject({ words: ['fix', 'it'], passthrough: [] });
  });

  it('keeps a -- inside a quoted brief in the brief', async () => {
    expect(await parsed(['worker', 'a -- b'])).toMatchObject({ words: ['a -- b'], passthrough: [] });
  });

  it("passes a second -- on to Claude as Claude's own", async () => {
    const got = await parsed(['worker', 'fix', '--', '--add-dir', 'x', '--', 'y']);
    expect(got.words).toEqual(['fix']);
    expect(got.passthrough).toEqual(['--add-dir', 'x', '--', 'y']);
  });

  it('takes options after the brief as options', async () => {
    const got = await parsed(['worker', 'fix it', '--account', 'spare']);
    expect(got.words).toEqual(['fix it']);
    expect(got.options.account).toBe('spare');
  });

  it('reads a brief file with Claude flags after it', async () => {
    const got = await parsed(['worker', '--brief-file', 'brief.md', '--', '--max-turns', '2']);
    expect(got.words).toEqual([]);
    expect(got.passthrough).toEqual(['--max-turns', '2']);
    expect(got.options.briefFile).toBe('brief.md');
  });
});

describe('what a worker prints', () => {
  const ran = { accounts: ['work', 'spare'], moves: 1, sessionId: 'abc' };

  it("adds the report to Claude's json result", () => {
    const out = workerOutput('json', '{"type":"result","result":"done"}\n', ran);
    expect(JSON.parse(out.stdout)).toEqual({ type: 'result', result: 'done', ccx: ran });
    expect(out.stderr).toBe('');
  });

  it("finds Claude's result on its last line when something was printed before it", () => {
    expect(resultObject('a warning\n{"type":"result","result":"done"}\n')).toEqual({ type: 'result', result: 'done' });
    expect(resultObject('not json')).toBeNull();
    expect(resultObject('')).toBeNull();
    expect(resultObject('[1,2]')).toBeNull();
  });

  it('is still one json object, saying why, when Claude gave no result', () => {
    const report = { ...ran, error: 'every account is out' };
    const answer = JSON.parse(workerOutput('json', '', report).stdout) as Record<string, unknown>;
    expect(answer).toMatchObject({
      type: 'result',
      subtype: 'error_ccx',
      is_error: true,
      result: 'every account is out',
      session_id: 'abc',
      ccx: report,
    });
  });

  it('ends a stream with the report, and puts text on standard error', () => {
    expect(JSON.parse(workerOutput('stream-json', '', ran).stdout)).toEqual({ type: 'ccx', ...ran });
    const text = workerOutput('text', 'the answer\n', ran);
    expect(text.stdout).toBe('the answer\n');
    expect(text.stderr).toBe('[ccx] worker ran on work, then spare (session abc)\n');
  });

  it('says plainly when it did not run at all', () => {
    expect(reportLine({ accounts: [], moves: 0, sessionId: null, error: 'no accounts registered' })).toBe(
      '[ccx] worker did not run: no accounts registered',
    );
  });
});
