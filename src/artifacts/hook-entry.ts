/**
 * The program Claude runs for ccx's Artifact hooks: `node hook-entry.js pre|post|fail|batch`.
 *
 * Every Claude on the machine runs it around every call of the Artifact tool,
 * and after every batch of tool calls of any kind, and waits for it, so it
 * decides first and cheaply. Only a ccx session has a config folder named for
 * its process under ccx's `sessions` folder: plain `claude`, Claude Desktop
 * and the editor are gone here, and so is a batch with no Artifact call in
 * it, before a module of ccx is loaded.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.CLAUDE_CONFIG_DIR;
const event = process.argv[2];
if (
  dir &&
  process.env.CLAUDE_CODE_ENTRYPOINT !== 'claude-desktop' &&
  /^\d+$/.test(path.basename(dir)) &&
  path.basename(path.dirname(dir)) === 'sessions'
) {
  let text = '';
  try {
    text = readFileSync(0, 'utf8');
  } catch {
    text = '';
  }
  // The quick look: a batch matters only when an Artifact call is in it.
  if (event !== 'batch' || text.includes('"Artifact"')) {
    const { runArtifactHook } = await import('./hook-run.js');
    await runArtifactHook(event, dir, text);
  }
}

export {};
