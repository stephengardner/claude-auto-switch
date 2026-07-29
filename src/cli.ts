#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { buildContext } from './context.js';
import { listCommand } from './commands/list.js';
import { statusCommand } from './commands/status.js';
import { addCommand } from './commands/add.js';
import { useCommand } from './commands/use.js';
import { rotateCommand } from './commands/rotate.js';
import { usageCommand } from './commands/usage.js';
import { autoCommand, type AutoOptions } from './commands/auto.js';
import { proactiveCommand } from './commands/proactive-config.js';
import { statuslineCommand } from './commands/statusline.js';
import { historyCommand } from './commands/history.js';
import { runCommand } from './commands/run.js';
import { removeCommand } from './commands/remove.js';
import { onCommand, offCommand } from './commands/onoff.js';
import { doctorCommand } from './commands/doctor.js';
import { capCommand } from './commands/cap.js';
import { loginCommand } from './commands/login.js';
import { enableCommand, disableCommand, priorityCommand } from './commands/account-config.js';
import { tokenCommand } from './commands/token.js';
import { daemonCommand } from './commands/daemon.js';
import { dashboardCommand } from './commands/dashboard.js';
import { homeCommand } from './commands/home.js';
import { setupCommand } from './commands/setup.js';
import { editorCommand } from './commands/editor.js';
import { CasError } from './util/errors.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  description: string;
};

const program = new Command();
program
  .name('ccx')
  .description(pkg.description)
  .version(pkg.version)
  .option('--json', 'output JSON where supported', false)
  .option('--quiet', 'reduce output', false);

// Bare `ccx`: getting-started guide (no accounts) or a status glance (accounts).
program.action(async () => {
  process.exitCode = await homeCommand(context());
});

function context() {
  const opts = program.opts<{ json: boolean; quiet: boolean }>();
  return buildContext({ json: opts.json, quiet: opts.quiet });
}

program
  .command('list')
  .description('show all accounts and their health')
  .action(async () => {
    process.exitCode = await listCommand(context());
  });

program
  .command('dashboard')
  .alias('watch')
  .description('live account dashboard (auto-refreshing)')
  .option('--once', 'print a single frame and exit')
  .option('--interval <seconds>', 'refresh interval in seconds')
  .action(async (opts: { once?: boolean; interval?: string }) => {
    process.exitCode = await dashboardCommand(context(), opts);
  });

program
  .command('status [name]')
  .description('detailed health for one or all accounts')
  .action(async (name?: string) => {
    process.exitCode = await statusCommand(context(), name);
  });

program
  .command('setup')
  .description('show the next step to get set up (state-aware)')
  .action(() => {
    process.exitCode = setupCommand(context());
  });

program
  .command('add <name>')
  .description('register a new account and log it in')
  .option('--email <email>', 'email to pre-fill on the login page')
  .option('--dir <dir>', 'profile folder (defaults to <profilesDir>/<name>)')
  .option('--no-login', 'register without running the browser login')
  .action(async (name: string, opts: { email?: string; dir?: string; login?: boolean }) => {
    process.exitCode = await addCommand(context(), name, opts);
  });

program
  .command('use <name>')
  .description('switch the active account (a running session moves to it seamlessly)')
  .option('--now', 'switch instantly by restarting the session (--continue) instead of the seamless in-place swap')
  .action((name: string, opts: { now?: boolean }) => {
    process.exitCode = useCommand(context(), name, opts);
  });

program
  .command('login [name]')
  .description('log in a stale account via the browser (or --all)')
  .option('--all', 'log in every currently logged-out account')
  .action(async (name: string | undefined, opts: { all?: boolean }) => {
    process.exitCode = await loginCommand(context(), name, opts);
  });

program
  .command('rotate')
  .description('switch to the next healthy account')
  .action(async () => {
    process.exitCode = await rotateCommand(context());
  });

program
  .command('usage')
  .description('show real per-account usage (5-hour + weekly) with reset times')
  .action(async () => {
    process.exitCode = await usageCommand(context());
  });

program
  .command('history')
  .description('what has happened to your logins and accounts (why you were asked to sign in)')
  .option('--limit <n>', 'how many entries to show')
  .option('--logins', 'only login events, without the switches')
  .action((opts: { limit?: string; logins?: boolean }) => {
    process.exitCode = historyCommand(context(), opts);
  });

program
  .command('statusline')
  .description('one line for Claude status line: the account in use and how full it is')
  .option('--install', 'print the settings snippet that wires this into Claude')
  .option('--wrap <command>', 'run your existing status line command and append ccx to it')
  .option('--compact', 'leave out the account name (when your line already shows it)')
  .action(async (opts: { install?: boolean; wrap?: string; compact?: boolean }) => {
    process.exitCode = await statuslineCommand(context(), opts);
  });

program
  .command('proactive [action]')
  .description('turn "move me to a roomier account before I run out" on or off')
  .option('--percent <percent>', 'move once the binding limit reaches this percent')
  .action((action: string | undefined, opts: { percent?: string }) => {
    const verb = action === 'on' || action === 'off' || action === 'status' ? action : undefined;
    if (action && !verb) {
      process.stderr.write(`unknown action "${action}" (use: on, off, status)\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = proactiveCommand(context(), verb, opts);
  });

program
  .command('auto')
  .description('move to a roomier account before the current one runs out')
  .option('--once', 'run a single check and exit (cron friendly)')
  .option('--json', 'emit JSON instead of prose')
  .option('--model <name>', 'decide using one model\'s weekly window (e.g. Fable)')
  .option('--interval <seconds>', 'seconds between checks when looping')
  .option('--dry-run', 'report what would happen without switching')
  .option('--threshold <percent>', 'treat an account as nearly out at this percent')
  .action(async (opts: AutoOptions) => {
    process.exitCode = await autoCommand(context(), opts);
  });

program
  .command('enable <name>')
  .description('include an account in rotation')
  .action((name: string) => {
    process.exitCode = enableCommand(context(), name);
  });

program
  .command('disable <name>')
  .description('exclude an account from rotation')
  .action((name: string) => {
    process.exitCode = disableCommand(context(), name);
  });

program
  .command('priority <name> <value>')
  .description('set an account priority (lower is preferred earlier)')
  .action((name: string, value: string) => {
    process.exitCode = priorityCommand(context(), name, value);
  });

program
  .command('token <name>')
  .description('mint a long-lived headless token (claude setup-token)')
  .action(async (name: string) => {
    process.exitCode = await tokenCommand(context(), name);
  });

program
  .command('cap <name>')
  .description('manually mark an account capped (or clear it)')
  .option('--until <time>', 'reset time (ISO or any parseable time)')
  .option('--minutes <n>', 'cap for N minutes from now')
  .option('--clear', 'clear the cap instead of setting one')
  .action((name: string, opts: { until?: string; minutes?: string; clear?: boolean }) => {
    process.exitCode = capCommand(context(), name, opts);
  });

program
  .command('run')
  .description('run claude on the active/healthiest account (pass args after --)')
  .allowUnknownOption()
  .argument('[args...]')
  .action(async (args: string[]) => {
    process.exitCode = await runCommand(context(), args);
  });

program
  .command('remove <name>')
  .description('deregister an account')
  .option('--purge', 'also delete its profile folder')
  .action((name: string, opts: { purge?: boolean }) => {
    process.exitCode = removeCommand(context(), name, opts);
  });

program
  .command('on')
  .description('set up ccx everywhere: transparent `claude` in the shell + your editors')
  .option('--profile <path>', 'profile path (defaults to your $PROFILE / rc file)')
  .option('--shell <shell>', 'powershell or posix (defaults to your platform)')
  .option('--no-editor', 'set up the terminal only, not editors')
  .action((opts: { profile?: string; shell?: string; editor?: boolean }) => {
    process.exitCode = onCommand(context(), opts);
  });

program
  .command('off')
  .description('remove ccx from your shell and editors')
  .option('--profile <path>', 'profile path (defaults to your $PROFILE / rc file)')
  .option('--shell <shell>', 'powershell or posix (defaults to your platform)')
  .option('--no-editor', 'remove from the terminal only')
  .action((opts: { profile?: string; shell?: string; editor?: boolean }) => {
    process.exitCode = offCommand(context(), opts);
  });

program
  .command('editor [action]')
  .description('make your editor (Cursor/VS Code) launch Claude through ccx: on|off')
  .option('--editor <name>', 'cursor or vscode (defaults to cursor)')
  .action((action: string | undefined, opts: { editor?: string }) => {
    process.exitCode = editorCommand(context(), action, opts);
  });

program
  .command('doctor')
  .description('verify config, git-safety, claude resolution, and browser port')
  .action(async () => {
    process.exitCode = await doctorCommand(context());
  });

program
  .command('daemon [action]')
  .description('always-on rotation everywhere: install|uninstall|status|start|stop|run')
  .action(async (action?: string) => {
    process.exitCode = await daemonCommand(context(), action);
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CasError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

void main();
