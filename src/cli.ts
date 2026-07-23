#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { buildContext } from './context.js';
import { listCommand } from './commands/list.js';
import { statusCommand } from './commands/status.js';
import { addCommand } from './commands/add.js';
import { useCommand } from './commands/use.js';
import { rotateCommand } from './commands/rotate.js';
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
  .description('pin the active account')
  .action((name: string) => {
    process.exitCode = useCommand(context(), name);
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
  .description('install the transparent claude shim into your shell profile')
  .option('--profile <path>', 'profile path (defaults to your $PROFILE / rc file)')
  .option('--shell <shell>', 'powershell or posix (defaults to your platform)')
  .action((opts: { profile?: string; shell?: string }) => {
    process.exitCode = onCommand(context(), opts);
  });

program
  .command('off')
  .description('remove the transparent claude shim')
  .option('--profile <path>', 'profile path (defaults to your $PROFILE / rc file)')
  .option('--shell <shell>', 'powershell or posix (defaults to your platform)')
  .action((opts: { profile?: string; shell?: string }) => {
    process.exitCode = offCommand(context(), opts);
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
