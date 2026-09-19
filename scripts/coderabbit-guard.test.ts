import { afterEach, expect, it, vi } from 'vitest';

const gh = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: gh }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Execute the real guard against synthetic GitHub responses and capture its exit code. */
async function runGuard({ state = 'success', covered = false, severity = '', source = 'inline', resolved = false, paused = false, supersededBody = false, details = 'Finding details.', headerPrefix = '' } = {}) {
  vi.resetModules();
  const finding = severity ? `
${headerPrefix}_⚠️ Potential issue_ | _🟠 ${severity}_\n${details}` : '';
  const reviews = supersededBody
    ? [
        {
          id: 1, user: { login: 'coderabbitai[bot]' }, commit_id: 'old',
          body: finding, submitted_at: '2026-09-19T00:00:00Z',
        },
        {
          id: 2, user: { login: 'coderabbitai[bot]' }, commit_id: 'head',
          body: '', submitted_at: '2026-09-19T00:00:00Z',
        },
      ]
    : covered || source === 'body' ? [{
        id: 1, user: { login: 'coderabbitai[bot]' }, commit_id: covered ? 'head' : 'old',
        body: source === 'body' ? finding : 'Review complete.', submitted_at: '2026-09-19T00:00:00Z',
      }] : [];
  const threads = source === 'inline' && finding ? [{
    isResolved: resolved, comments: { nodes: [{ author: { login: 'coderabbitai' }, body: finding, path: 'file.ts', line: 1 }] },
  }] : [];
  gh.mockImplementation((_command: string, args: string[]) => {
    if (args[0] === 'repo') return JSON.stringify({ owner: { login: 'owner' }, name: 'repo' });
    if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } });
    const path = args[1]!;
    if (path.endsWith('/comments')) return JSON.stringify(
      supersededBody
        ? [{
            user: { login: 'coderabbitai[bot]' },
            body: '> [!IMPORTANT]\n> ## Review skipped\n>\n> No new commits to review since the last review.',
            created_at: '2026-09-19T00:00:00Z',
            updated_at: '2026-09-19T00:02:00Z',
          }]
        : source === 'summary' ? [{ user: { login: 'coderabbitai[bot]' }, body: finding, created_at: '2026-09-19T00:00:00Z' }]
        : paused ? [{ user: { login: 'coderabbitai[bot]' }, body: 'Review paused by CodeRabbit' }]
        : [],
    );
    if (path.endsWith('/reviews')) return JSON.stringify(reviews);
    if (path.endsWith('/pulls/87')) return JSON.stringify({ head: { sha: 'head' }, base: { ref: 'main' } });
    if (path.endsWith('/status')) return JSON.stringify({ statuses: state === 'absent' ? [] : [{ context: 'CodeRabbit', state }] });
    if (path.endsWith('/check-runs')) return JSON.stringify({ check_runs: [] });
    if (path.includes('/compare/')) return JSON.stringify({ status: 'ahead' });
    if (path.endsWith('/commits/head')) return JSON.stringify({ commit: { committer: { date: '2026-09-18T00:00:00Z' } }, parents: [{ sha: 'parent' }] });
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  });
  vi.stubGlobal('process', { ...process, argv: ['node', 'coderabbit-guard.mjs', '87', '--wait', '0'] });
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  exit.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // @ts-expect-error -- execute the actual JavaScript CLI with mocked GitHub responses
  await expect(import('./coderabbit-guard.mjs')).rejects.toThrow('exit');
  return exit.mock.calls[0]?.[0];
}

it.each([
  { state: 'success' },
  { state: 'pending' },
  { state: 'absent' },
  { paused: true },
  { state: 'absent', source: 'body' },
  { state: 'success', source: 'body' },
])('returns neutral when the head has no finished review: %j', async (options) => {
  expect(await runGuard(options)).toBe(2);
});

it.each(['Major', 'Critical'])('blocks unresolved %s findings even before the head review finishes', async (severity) => {
  expect(await runGuard({ severity, state: 'pending' })).toBe(1);
});

it.each(['inline', 'body', 'summary'])('blocks critical/major findings in %s', async (source) => {
  expect(await runGuard({ severity: 'Major', source, covered: true })).toBe(1);
});

it.each(['inline', 'body', 'summary'])('does not block minor/nitpick findings in %s', async (source) => {
  for (const severity of ['Minor', 'Nitpick']) {
    expect(await runGuard({ severity, source, covered: true })).toBe(0);
  }
});

it('clears resolved major findings on a reviewed head', async () => {
  expect(await runGuard({ severity: 'Major', resolved: true, covered: true })).toBe(0);
});

it('clears a reviewed head without findings', async () => {
  expect(await runGuard({ covered: true })).toBe(0);
});

it.each(['Minor', 'Nitpick'])('ignores critical/major badges in %s inline details', async (severity) => {
  expect(await runGuard({ severity, covered: true, details: 'Example: _🟠 Major_\nQuoted label: _critical_' })).toBe(0);
});

it('checks the full inline header without the display excerpt limit', async () => {
  expect(await runGuard({ severity: 'Major', covered: true, headerPrefix: '_Category_ | '.repeat(15) })).toBe(1);
});

it.each(['body', 'summary'])('ignores quoted severity badges in %s finding details', async (source) => {
  for (const severity of ['Minor', 'Nitpick']) {
    expect(await runGuard({
      severity, source, covered: true,
      details: 'A detail quotes `_Major_` or `_Critical_`.\n```markdown\n_⚠️ Potential issue_ | _🔴 Critical_\n```',
    })).toBe(0);
  }
});

it.each(['body', 'summary'])('keeps indented fence-like lines inside %s examples', async (source) => {
  for (const prefix of ['', '> ', '> > ']) {
    const details = ['```markdown', '    ```', '_🔴 Critical_', '```']
      .map((line) => prefix + line).join('\n');
    expect(await runGuard({ severity: 'Minor', source, covered: true, details })).toBe(0);
  }
});

it.each(['body', 'summary'])('does not hide a blocking %s finding after an invalid fence opener', async (source) => {
  expect(await runGuard({
    source, covered: true, severity: 'Minor', details: '```markdown`\n_🔴 Critical_',
  })).toBe(1);
});

it('ignores older review-body findings after a later clean review covers the head, even in the same second', async () => {
  expect(await runGuard({ severity: 'Major', source: 'body', supersededBody: true })).toBe(0);
});
