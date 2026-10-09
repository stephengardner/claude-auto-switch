// Stands in for ccx on another machine, for the `ccx login --host` tests. It
// speaks the same three commands the real one is asked over ssh:
//   state                   prints FAKE_REMOTE_STATE (JSON)
//   add <name> ...          records the registration
//   login <name> --relay    prints a link line, reads one code line, reports
// Everything it is asked and sent goes to FAKE_REMOTE_LOG, one JSON line each.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const log = (entry) => {
  if (process.env.FAKE_REMOTE_LOG) appendFileSync(process.env.FAKE_REMOTE_LOG, `${JSON.stringify(entry)}\n`);
};
log({ args });

if (args[0] === 'state') {
  process.stdout.write(process.env.FAKE_REMOTE_STATE ?? '{}');
  process.exit(0);
}

if (args[0] === 'add') {
  process.stdout.write(`registered "${args[1]}"\n`);
  process.exit(0);
}

if (args[0] === 'login' && args.includes('--relay')) {
  process.stdout.write(`logging in "${args[1]}"...\n`);
  process.stdout.write(`ccx-relay-url ${process.env.FAKE_REMOTE_LINK ?? 'https://claude.com/cai/oauth/authorize?fake=1'}\n`);
  const rl = createInterface({ input: process.stdin });
  let answered = false;
  rl.once('line', (line) => {
    answered = true;
    log({ account: args[1], code: line });
    rl.close();
    const ok = line.includes('#');
    process.stdout.write(ok ? '  ok: logged in (relayed)\n' : '  FAILED: the code was not accepted\n');
    process.exit(ok ? 0 : 1);
  });
  rl.once('close', () => {
    if (answered) return;
    log({ account: args[1], code: null });
    process.stdout.write('  FAILED: no code arrived from the machine approving the sign-in\n');
    process.exit(1);
  });
} else {
  process.stderr.write(`fake remote ccx: unknown command ${args.join(' ')}\n`);
  process.exit(2);
}
