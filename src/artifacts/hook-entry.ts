/**
 * The program Claude runs for ccx's Artifact hooks: `node hook-entry.js pre|post|fail`.
 *
 * Every Claude on the machine runs it around every call of the Artifact tool,
 * and waits for it, so it decides first and cheaply. Only a ccx session has a
 * config folder named for its process under ccx's `sessions` folder: plain
 * `claude`, Claude Desktop and the editor are gone here, before a module of
 * ccx is loaded.
 */
import path from 'node:path';

const dir = process.env.CLAUDE_CONFIG_DIR;
if (
  dir &&
  process.env.CLAUDE_CODE_ENTRYPOINT !== 'claude-desktop' &&
  /^\d+$/.test(path.basename(dir)) &&
  path.basename(path.dirname(dir)) === 'sessions'
) {
  const { runArtifactHook } = await import('./hook-run.js');
  await runArtifactHook(process.argv[2], dir);
}

export {};
