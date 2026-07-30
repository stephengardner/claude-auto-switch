import path from 'node:path';
import { profilesDir } from '../config/paths.js';
import { addAccount, removeAccount } from '../accounts/registry.js';
import { settleNewLogin } from '../login/settle-login.js';
import { runInherit } from '../util/exec.js';
import { invokerArgs } from '../invoker.js';
import { assertProfileName, assertInsideProfiles } from '../util/names.js';
import { secureMkdir } from '../util/secret-file.js';
import { getClaude, type CliContext } from '../context.js';

export interface AddOptions {
  dir?: string;
  email?: string;
  /** Run the browser login after registering (default true). */
  login?: boolean;
}

/** Register a new account (its own profile folder) and, by default, log it in. */
export async function addCommand(
  context: CliContext,
  name: string,
  options: AddOptions = {},
): Promise<number> {
  assertProfileName(name);
  const profiles = profilesDir(context.config, context.ctx);
  const dir = options.dir ? path.resolve(options.dir) : path.join(profiles, name);
  // A custom --dir must still live inside the profiles tree, so a later
  // `remove --purge` can never be pointed at an arbitrary system directory.
  assertInsideProfiles(profiles, dir);
  secureMkdir(dir);
  addAccount({ name, dir, ...(options.email ? { email: options.email } : {}) }, context.ctx);
  context.out(`registered "${name}" -> ${dir}`);

  if (options.login !== false) {
    const claude = getClaude(context);
    const loginArgs = [
      'auth',
      'login',
      '--claudeai',
      ...(options.email ? ['--email', options.email] : []),
    ];
    await runInherit(claude.bin, invokerArgs(claude, loginArgs), {
      env: { CLAUDE_CONFIG_DIR: dir },
    });

    // The browser is usually still signed in to the account you added last, so
    // this is the most likely place to end up with two profiles on one account.
    // Checked through the same choke point as `ccx login`, and if it is refused
    // the registration is undone so you are back where you started rather than
    // holding a profile that cannot work.
    const settled = await settleNewLogin(context, { name, dir });
    if (!settled.ok) {
      removeAccount(name, context.ctx);
      context.out(`  "${name}" was not kept.`);
      return 1;
    }
  }
  return 0;
}
