import { loadConfig, loadConfigFile, saveConfig } from '../config/config.js';
import { ConfigSchema, type PartialConfig } from '../config/config.schema.js';
import type { CliContext } from '../context.js';
import {
  SETTINGS,
  appliesWords,
  defaultOf,
  findSetting,
  parseSetting,
  typedRange,
  valueOf,
  type Setting,
} from '../dashboard/settings-catalog.js';
import { setHandoff, setMode, setPrompt } from './desktop.js';

/**
 * Change one setting, the same way from the dashboard's settings panel and from
 * `ccx config`. Returns what it is now, in words; throws with the reason when
 * the value is refused, and nothing is written then.
 *
 * Written on top of the FILE, never the loaded config: that has the `CAS_*`
 * environment overrides and every default folded in, and writing it back would
 * bake them into config.json. The whole result is checked against the schema
 * before it is saved, so a bad value can never leave a config that no longer
 * loads.
 *
 * The Desktop settings go through `ccx desktop`'s own commands, because
 * changing when conversations move installs hooks in Claude's settings too.
 */
export async function applySetting(context: CliContext, setting: Setting, value: unknown): Promise<string> {
  if (setting.key.startsWith('desktop.')) return applyDesktop(context, setting, value);
  const onDisk = loadConfigFile(context.ctx);
  const next = withValue(onDisk, setting.key, value);
  const checked = ConfigSchema.safeParse(next);
  if (!checked.success) {
    throw new Error(`${setting.label}: ${checked.error.issues[0]?.message ?? 'not a usable value'}`);
  }
  // The file now matches what the schema just accepted, so it is the shape
  // the rest of ccx reads.
  saveConfig(next as PartialConfig, context.ctx);
  reload(context);
  return `${setting.label}: ${setting.words(valueOf(context.config, setting.key))}`;
}

/** `file` with one setting replaced, nothing else touched. */
function withValue(file: PartialConfig, key: string, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...file };
  const [section, field] = key.split('.') as [string, string | undefined];
  if (field === undefined) {
    out[section] = value;
    return out;
  }
  const inner = out[section];
  out[section] = {
    ...(typeof inner === 'object' && inner !== null && !Array.isArray(inner) ? inner : {}),
    [field]: value,
  };
  return out;
}

/** The loaded config, in place, so every holder of it sees the change. */
function reload(context: CliContext): void {
  Object.assign(context.config, loadConfig(context.ctx));
}

async function applyDesktop(context: CliContext, setting: Setting, value: unknown): Promise<string> {
  const said: string[] = [];
  const quiet: CliContext = { ...context, out: (m: string) => said.push(m) };
  const code =
    setting.key === 'desktop.handoff'
      ? setHandoff(quiet, String(value))
      : setting.key === 'desktop.mode'
        ? setMode(quiet, String(value))
        : setPrompt(quiet, [String(value)]);
  reload(context);
  const text = said.filter((l) => l.trim() !== '').join(' ');
  if (code !== 0) throw new Error(text || `${setting.label} was not changed`);
  return text || `${setting.label}: ${setting.words(value)}`;
}

/**
 * `ccx config`: every setting with its value; `ccx config <key>` one of them,
 * with what it does; `ccx config <key> <value>` changes it (`default` puts the
 * default back). The same settings, rules and words as the dashboard's panel.
 */
export async function configCommand(context: CliContext, name?: string, words: string[] = []): Promise<number> {
  if (!name) {
    const width = Math.max(...SETTINGS.map((s) => s.key.length));
    let group = '';
    for (const s of SETTINGS) {
      if (s.group !== group) {
        if (group !== '') context.out('');
        context.out(s.group);
        group = s.group;
      }
      context.out(`  ${s.key.padEnd(width)}  ${s.words(valueOf(context.config, s.key))}`);
    }
    context.out('');
    context.out('ccx config <key> shows what one does; ccx config <key> <value> changes it.');
    return 0;
  }

  const found = findSetting(name);
  if (found === null) {
    context.out(`no setting called "${name}"; ccx config lists them`);
    return 1;
  }
  if ('ambiguous' in found) {
    context.out(`"${name}" could be ${found.ambiguous.map((s) => s.key).join(' or ')}`);
    return 1;
  }
  const setting = found;

  if (words.length === 0) {
    context.out(`${setting.key}: ${setting.words(valueOf(context.config, setting.key))}`);
    context.out(`  ${setting.help}`);
    context.out(`  ${appliesWords(setting.applies)}`);
    context.out(`  takes: ${takes(setting)}; default: ${setting.words(defaultOf(setting))}`);
    return 0;
  }

  const typed = words.join(' ');
  let value: unknown;
  try {
    value = /^default$/i.test(typed.trim()) ? defaultOf(setting) : parseSetting(setting, typed);
  } catch (err) {
    context.out(`${setting.key}: ${(err as Error).message}`);
    return 1;
  }
  try {
    context.out(await applySetting(context, setting, value));
  } catch (err) {
    context.out((err as Error).message);
    return 1;
  }
  context.out(appliesWords(setting.applies));
  return 0;
}

/** What a setting accepts, for `ccx config <key>`. */
function takes(setting: Setting): string {
  switch (setting.kind) {
    case 'toggle':
      return 'on or off';
    case 'choice':
      return (setting.choices ?? []).join(', ');
    case 'number': {
      const [min, max] = typedRange(setting);
      return `${min} to ${max} ${setting.unit ?? ''}`.trim() + (setting.off !== undefined ? ', or off' : '');
    }
    case 'models':
      return 'model names in order, such as: opus fable';
    default:
      return 'one line of text';
  }
}
