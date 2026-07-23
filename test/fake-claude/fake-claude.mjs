#!/usr/bin/env node
// Fake `claude` for tests. Impersonates the subset of the real CLI that
// claude-auto-switch drives: `auth status`, `auth login`, and a generic run.
// Behavior is driven by a scenario JSON, resolved from FAKE_CLAUDE_SCENARIO or
// <CLAUDE_CONFIG_DIR>/fake-scenario.json. No network, no model spend, no logins.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? process.cwd();

function loadScenario() {
  const explicit = process.env.FAKE_CLAUDE_SCENARIO;
  const perDir = path.join(configDir, 'fake-scenario.json');
  const file =
    explicit && existsSync(explicit) ? explicit : existsSync(perDir) ? perDir : null;
  if (!file) {
    return {
      authStatus: { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' },
      capped: false,
    };
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const scenario = loadScenario();

// claude auth status -> print the scenario auth JSON; exit 0 if logged in.
if (args[0] === 'auth' && args[1] === 'status') {
  const status = scenario.authStatus ?? { loggedIn: false, authMethod: 'none' };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exit(status.loggedIn ? 0 : 1);
}

// claude auth login -> simulate a successful login by marking this dir logged in.
if (args[0] === 'auth' && args[1] === 'login') {
  const loginResult = scenario.loginResult ?? {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: scenario.email ?? 'test@example.com',
    subscriptionType: scenario.plan ?? 'max',
  };
  writeJson(path.join(configDir, 'fake-scenario.json'), {
    ...scenario,
    authStatus: loginResult,
    capped: scenario.capped ?? false,
  });
  process.stdout.write('Logged in (fake).\n');
  process.exit(0);
}

// Any other invocation is a "run" (e.g. -p "..."). Honor a capped scenario.
if (scenario.capped) {
  process.stderr.write(`${scenario.capMessage ?? 'Usage limit reached. Try again later.'}\n`);
  process.exit(scenario.capExitCode ?? 1);
}

// Record the invocation so launcher tests can assert on args + config dir.
writeJson(path.join(configDir, 'fake-last-run.json'), { args, configDir });
process.stdout.write(`fake-claude ran: ${args.join(' ')}\n`);
process.exit(0);
