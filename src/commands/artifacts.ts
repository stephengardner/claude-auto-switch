import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasUsableLogin } from '../accounts/credential-vault.js';
import { listAccounts } from '../accounts/registry.js';
import { planArtifactHooks, thisArtifactHookProgram } from '../artifacts/hooks.js';
import { readPages, type Page } from '../artifacts/record.js';
import { SCAN_ENV, readResults, writePlan } from '../artifacts/scan.js';
import type { HookProgram } from '../claude/settings-hooks.js';
import { configHome } from '../config/paths.js';
import type { CliContext } from '../context.js';
import { STATE_SCHEMA_VERSION } from '../dashboard/state-payload.js';

/** "3 minutes ago", "2 days ago". */
function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * `ccx artifacts`: the pages ccx has recorded, and the account that owns each.
 */
export function artifactsCommand(context: CliContext, now: number = Date.now()): number {
  const pages = readPages(context.ctx).reverse();
  const { home, updates } = context.config.artifacts;

  if (context.json) {
    context.out(
      JSON.stringify(
        {
          schemaVersion: STATE_SCHEMA_VERSION,
          settings: { home, updates },
          pages: pages.map((p: Page) => ({
            url: p.url,
            title: p.title,
            owner: p.owner,
            file: p.file,
            firstSeen: p.firstAt,
            lastSeen: p.at,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const settings = (): void => {
    context.out(`new pages are published as: ${home ?? 'the account the session is on'}  (ccx config artifacts.home <account>)`);
    context.out(
      `a page is changed as: ${updates === 'owner' ? 'the account that owns it' : 'the account the session is on'}  (ccx config artifacts.updates owner)`,
    );
  };

  if (pages.length === 0) {
    context.out('no pages recorded yet');
    context.out('');
    context.out('ccx records a page when a ccx session publishes it while either setting below is on.');
    context.out('ccx artifacts scan asks each account for the pages it already has.');
    context.out('');
    settings();
    return 0;
  }

  // Titles and links come from outside, so nothing in them reaches the
  // terminal as a control sequence.
  const safe = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  const rows = pages.map((p) => ({
    owner: p.owner === null ? '?' : safe(p.owner),
    title: safe(p.title ?? '(untitled)').slice(0, 48),
    seen: ago(p.at, now),
    url: safe(p.url),
  }));
  const wOwner = Math.max(7, ...rows.map((r) => r.owner.length));
  const wTitle = Math.max(4, ...rows.map((r) => r.title.length));
  const wSeen = Math.max(9, ...rows.map((r) => r.seen.length));
  context.out(`${'ACCOUNT'.padEnd(wOwner)}  ${'PAGE'.padEnd(wTitle)}  ${'LAST SEEN'.padEnd(wSeen)}  LINK`);
  for (const r of rows) {
    context.out(`${r.owner.padEnd(wOwner)}  ${r.title.padEnd(wTitle)}  ${r.seen.padEnd(wSeen)}  ${r.url}`);
  }
  context.out('');
  if (rows.some((r) => r.owner === '?')) {
    context.out('? is a page ccx could not tell the account of; ccx artifacts scan finds out.');
  }
  settings();
  return 0;
}

export interface ScanOptions {
  /** Only these accounts; every account otherwise. */
  account?: string[];
}

export interface ScanDeps {
  /** Run `ccx worker` with these arguments, and these added to its environment. Resolves with its exit code. */
  runWorker?: (args: string[], env: Record<string, string>) => Promise<{ code: number; said: string }>;
  program?: HookProgram;
}

/** What the scan's Claude is told. The hook decides which account answers each call. */
export function scanBrief(count: number): string {
  return [
    'You are listing published pages for ccx, a tool that manages several Claude accounts. Follow these steps exactly and do nothing else.',
    '',
    'Rules:',
    '- Use only the Artifact tool, and only with the input written below. Do not load skills, and do not read, write or edit any file.',
    '- If you have no tool named exactly `Artifact`, reply with only: no artifact tool',
    '',
    `Make exactly ${count} ${count === 1 ? 'call' : 'calls'} of the Artifact tool, one per message, waiting for each result before the next. Every call has exactly this input:`,
    '{"action": "list", "scope": "mine", "limit": 200}',
    '',
    `A call that is refused or fails still counts as one of the ${count}: go on to the next. Do not repeat or summarise what the calls return.`,
    `After the ${count} ${count === 1 ? 'call' : 'calls'}, reply with only: done`,
  ].join('\n');
}

/** The real `ccx worker`: this ccx, as a process of its own, so the scan's variables reach only its Claude. */
function runWorkerProcess(args: string[], env: Record<string, string>): Promise<{ code: number; said: string }> {
  return new Promise((resolve) => {
    const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let said = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (said = (said + chunk).slice(-2000)));
    child.on('error', (error) => resolve({ code: 127, said: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, said }));
  });
}

/**
 * `ccx artifacts scan`: ask each signed-in account for the pages it already
 * has, and record each one's owner (see artifacts/scan). Best effort.
 */
export async function artifactsScanCommand(
  context: CliContext,
  options: ScanOptions = {},
  deps: ScanDeps = {},
): Promise<number> {
  const accounts = listAccounts(context.ctx);
  const wanted = options.account && options.account.length > 0 ? options.account : accounts.map((a) => a.name);
  const unknown = wanted.filter((name) => !accounts.some((a) => a.name === name));
  if (unknown.length > 0) {
    context.out(`no account called ${unknown.map((n) => `"${n}"`).join(', ')}; ccx list names them`);
    return 1;
  }
  const signedIn = wanted.filter((name) => hasUsableLogin(accounts.find((a) => a.name === name)?.dir ?? ''));
  const signedOut = wanted.filter((name) => !signedIn.includes(name));
  if (signedIn.length === 0) {
    context.out('no signed-in account to list pages for (ccx login <name>)');
    return 1;
  }

  const dir = path.join(configHome(context.ctx), `artifact-scan-${randomUUID()}`);
  let worker: { code: number; said: string };
  let results: ReturnType<typeof readResults>;
  try {
    writePlan(dir, signedIn);
    const settings = path.join(dir, 'claude-settings.json');
    writeFileSync(settings, JSON.stringify(planArtifactHooks({}, true, deps.program ?? thisArtifactHookProgram())), 'utf8');
    const brief = path.join(dir, 'brief.md');
    writeFileSync(brief, scanBrief(signedIn.length), 'utf8');
    context.out(
      `listing the pages of ${signedIn.length} ${signedIn.length === 1 ? 'account' : 'accounts'} with one headless Claude ` +
        '(a few short turns of usage on one account)...',
    );
    worker = await (deps.runWorker ?? runWorkerProcess)(
      // Claude's own flags last: its --allowedTools takes every word after it.
      ['worker', '--model', 'sonnet', '--output', 'json', '--timeout', '10', '--cwd', dir, '--brief-file', brief, '--', '--settings', settings, '--allowedTools', 'Artifact'],
      {
        // What gives a headless Claude the Artifact tool at all, and keeps it
        // from opening a browser tab. Neither is documented by Claude Code.
        CLAUDE_CODE_ARTIFACT: '1',
        CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '0',
        [SCAN_ENV]: dir,
      },
    );
    results = readResults(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a folder of plans and counts, with nothing in it worth a failure */
    }
  }

  const width = Math.max(...wanted.map((name) => name.length));
  let listed = 0;
  for (const { account, result } of results) {
    if (result && 'listed' in result) {
      listed += 1;
      const more = result.total !== null && result.total > result.listed ? ` of ${result.total} (the newest ${result.listed} were recorded)` : '';
      context.out(`  ${account.padEnd(width)}  ${result.listed} ${result.listed === 1 ? 'page' : 'pages'}${more}`);
    } else {
      context.out(`  ${account.padEnd(width)}  not listed: ${result ? result.error : 'the scan ended before reaching it'}`);
    }
  }
  for (const name of signedOut) context.out(`  ${name.padEnd(width)}  not listed: not signed in (ccx login ${name})`);
  if (listed < results.length) {
    const why = worker.said.trim().split('\n').pop();
    if (worker.code !== 0 && why) context.out(`the headless Claude ended early: ${why.trim()}`);
    context.out('ccx artifacts scan is best effort: it needs a Claude Code whose headless mode has the Artifact tool.');
  }
  context.out('ccx artifacts shows what is recorded.');
  return listed === results.length && signedOut.length === 0 ? 0 : 1;
}
