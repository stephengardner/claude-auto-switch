import { ConfigSchema, type Config } from '../config/config.schema.js';
import { checkResumePrompt } from '../session/resume-prompt.js';
import {
  MODEL_CHOICES,
  modelPreferenceWords,
  nextModelPreference,
  orderWords,
  ORDER_CHOICES,
} from './rotation-settings.js';

/**
 * Every setting the dashboard's settings panel and `ccx config` show and change,
 * described once: where it lives, what it means, how it reads, how a key steps
 * it, what typing it accepts, and when a running session feels the change.
 *
 * Pure. Saving is the caller's (commands/settings.ts), so the stepping and
 * parsing rules can be tested without a terminal or a config file.
 *
 * Left out on purpose: where account folders go and which claude binary runs
 * (moving those under a running session breaks it), and the sign-in browser's
 * port and channel (set once, by hand, if ever). They stay in config.json.
 */

export type SettingKind = 'toggle' | 'choice' | 'number' | 'text' | 'models';

/** When a change reaches sessions that are already running. */
export type Applies = 'next-move' | 'next-restart' | 'next-check' | 'now' | 'new-sessions' | 'next-run' | 'daemon-start';

export interface Setting {
  /** Where it lives in config.json, dotted: `rotation.accountOrder`. */
  key: string;
  group: string;
  label: string;
  /** What it does, in one or two sentences. */
  help: string;
  applies: Applies;
  kind: SettingKind;
  /** choice: the values, in the order a step goes through them. */
  choices?: readonly string[];
  /** number: the range the arrows move within, and by how much. */
  min?: number;
  max?: number;
  step?: number;
  /** number: the value that means off, which sits just past one end of the range. */
  off?: number;
  /** number: what it counts, for the box that asks for one. */
  unit?: string;
  /** The value as the screen says it. */
  words: (value: unknown) => string;
  /** Asked before a change is made, for a setting that edits files outside ccx. */
  confirm?: (next: unknown) => string;
}

const onOff = (value: unknown): string => (value === true ? 'on' : 'off');

/** "5h", "90 min", "1h 30m". */
function minutesWords(value: unknown): string {
  const minutes = typeof value === 'number' ? value : 0;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** "5 min", "90s". */
function secondsWords(value: unknown): string {
  const seconds = typeof value === 'number' ? value : 0;
  if (seconds < 60 || seconds % 60 !== 0) return `${seconds}s`;
  return `${seconds / 60} min`;
}

const chainOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export const SETTINGS: readonly Setting[] = [
  {
    key: 'rotation.accountOrder',
    group: 'Picking accounts',
    label: 'Pick the next account by',
    kind: 'choice',
    choices: ORDER_CHOICES,
    words: (value) => orderWords(value === 'most-room' || value === 'priority' ? value : 'smart'),
    help:
      'Longest run first: the most work before any window stops it. Most room: the least used. ' +
      'Your order: the list order, which [ and ] change.',
    applies: 'next-move',
  },
  {
    key: 'rotation.holdBackAtPercent',
    group: 'Picking accounts',
    label: 'Hold back weeks used past',
    kind: 'number',
    min: 50,
    max: 95,
    step: 5,
    off: 100,
    unit: 'percent',
    words: (value) => (value === 100 ? 'off' : `${String(value)}%`),
    help:
      'Under longest run first, an account whose week is this full goes after every healthier ' +
      'one, and is still used when nothing healthier has room.',
    applies: 'next-move',
  },
  {
    key: 'rotation.defaultBackoffMinutes',
    group: 'Picking accounts',
    label: 'Skip a spent account for',
    kind: 'number',
    min: 15,
    max: 1440,
    step: 15,
    unit: 'minutes',
    words: minutesWords,
    help: 'How long an account that ran out is left alone when the reset time is unknown.',
    applies: 'next-move',
  },
  {
    key: 'rotation.modelPreference',
    group: 'Models',
    label: 'Model preference',
    kind: 'models',
    words: (value) => modelPreferenceWords(chainOf(value)),
    help:
      'Which model sessions start on, then fall back to. The arrows go through the usual ' +
      'choices; enter types a chain of your own, such as "opus, fable".',
    applies: 'next-move',
  },
  {
    key: 'rotation.modelStrategy',
    group: 'Models',
    label: 'When a model runs out',
    kind: 'choice',
    choices: ['model-first', 'account-first'],
    words: (value) => (value === 'account-first' ? 'change model, keep the account' : 'keep the model, change account'),
    help:
      'Keep the model: try it on every account before falling back. Change model: use each ' +
      'account up across the whole chain before moving.',
    applies: 'next-move',
  },
  {
    key: 'rotation.preferSameModel',
    group: 'Models',
    label: 'Follow models',
    kind: 'toggle',
    words: onOff,
    help: 'Off: rotation ignores models and moves on account-wide caps alone.',
    applies: 'next-move',
  },
  {
    key: 'resume.auto',
    group: 'Restarts',
    label: 'Carry on after a restart',
    kind: 'toggle',
    words: onOff,
    help: 'A restarted session is sent the restart prompt, so it picks the work up by itself.',
    applies: 'next-restart',
  },
  {
    key: 'resume.prompt',
    group: 'Restarts',
    label: 'Restart prompt',
    kind: 'text',
    words: (value) => String(value),
    help: 'What a restarted session is told. Enter edits it; d puts the default back.',
    applies: 'next-restart',
  },
  {
    key: 'update.follow',
    group: 'Restarts',
    label: 'Follow ccx updates',
    kind: 'toggle',
    words: onOff,
    help: 'A running session moves to a newer ccx by itself, between turns, keeping its conversation and account.',
    applies: 'now',
  },
  {
    key: 'rotation.proactivePercent',
    group: 'Moving early',
    label: 'Move a session early at',
    kind: 'number',
    min: 50,
    max: 95,
    step: 5,
    off: 0,
    unit: 'percent',
    words: (value) => (value === 0 ? 'off' : `${String(value)}% used`),
    help: 'Moves a running session to another account before its own runs out. Off: only after a turn is refused.',
    applies: 'next-check',
  },
  {
    key: 'rotation.proactiveHysteresisPercent',
    group: 'Moving early',
    label: 'Only to an account with',
    kind: 'number',
    min: 0,
    max: 50,
    step: 5,
    unit: 'points',
    words: (value) => `${String(value)} points more room`,
    help: 'An early move only goes to an account with at least this much more room, so sessions do not bounce.',
    applies: 'next-check',
  },
  {
    key: 'rotation.usageCheckSeconds',
    group: 'Moving early',
    label: 'Check usage every',
    kind: 'number',
    min: 30,
    max: 3600,
    step: 30,
    unit: 'seconds',
    words: secondsWords,
    help: 'How often a running session reads its usage, which early moves and the pick order work from.',
    applies: 'new-sessions',
  },
  {
    key: 'desktop.handoff',
    group: 'Claude Desktop',
    label: 'Move Desktop conversations',
    kind: 'choice',
    choices: ['off', 'limit', 'credits'],
    words: (value) =>
      value === 'limit' ? 'when a turn is refused' : value === 'credits' ? 'also before usage credits' : 'off, by hand only',
    help:
      'When a Claude Desktop conversation carries on in a terminal by itself: never, when a turn ' +
      'there is refused, or also before Desktop would spend usage credits.',
    applies: 'now',
    confirm: (next) => {
      const what =
        next === 'off'
          ? 'Stop moving Desktop conversations by themselves'
          : next === 'limit'
            ? 'Move a Desktop conversation to a terminal when a turn there is refused'
            : 'Also hold back Desktop messages once its account is past its plan, and carry them on in a terminal';
      return `${what}? This edits the hooks in ~/.claude/settings.json.`;
    },
  },
  {
    key: 'desktop.mode',
    group: 'Claude Desktop',
    label: 'A moved conversation goes on',
    kind: 'choice',
    choices: ['fork', 'same'],
    words: (value) => (value === 'same' ? 'as itself' : 'as a copy'),
    help:
      'As a copy: Desktop keeps the original untouched. As itself: reopening it in Desktop shows ' +
      'the work, but Desktop must send nothing more to it meanwhile.',
    applies: 'now',
    confirm: (next) =>
      next === 'same'
        ? 'Carry moved Desktop conversations on as the SAME conversation, not a copy? Desktop must then send nothing more to them.'
        : 'Carry moved Desktop conversations on as a copy, leaving the original in Desktop as it was?',
  },
  {
    key: 'desktop.prompt',
    group: 'Claude Desktop',
    label: 'A moved conversation is told',
    kind: 'text',
    words: (value) => String(value),
    help: 'Sent when a moved Desktop conversation continues in a terminal, so the work picks itself up.',
    applies: 'now',
  },
  {
    key: 'rotation.autoRotateHeadless',
    group: 'Other',
    label: 'ccx run -p moves by itself',
    kind: 'toggle',
    words: onOff,
    help: 'A one-shot ccx run (claude -p) moves to another account when its own runs out.',
    applies: 'next-run',
  },
  {
    key: 'rotation.capThresholdPercent',
    group: 'Other',
    label: 'ccx daemon moves at',
    kind: 'number',
    min: 50,
    max: 100,
    step: 5,
    unit: 'percent',
    words: (value) => `${String(value)}% used`,
    help: 'Only for ccx daemon: it moves its shared link off an account this full.',
    applies: 'daemon-start',
  },
];

/** When a change takes effect, as a sentence. */
export function appliesWords(applies: Applies): string {
  switch (applies) {
    case 'next-move':
      return "Takes effect at each session's next move.";
    case 'next-restart':
      return "Takes effect at each session's next restart.";
    case 'next-check':
      return "Takes effect at each session's next usage check.";
    case 'new-sessions':
      return 'Takes effect in sessions started after the change.';
    case 'next-run':
      return 'Takes effect from the next ccx run.';
    case 'daemon-start':
      return 'Takes effect when ccx daemon next starts.';
    default:
      return 'Takes effect now.';
  }
}

/** The setting's value in `config`, read by its dotted key. */
export function valueOf(config: Config, key: string): unknown {
  let at: unknown = config;
  for (const part of key.split('.')) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/** What the setting is when nothing sets it. */
export function defaultOf(setting: Setting): unknown {
  return valueOf(ConfigSchema.parse({}), setting.key);
}

/**
 * A setting by its key: the whole dotted key, or its last part when only one
 * setting ends that way (`holdBackAtPercent`, but not `prompt`). Any case.
 */
export function findSetting(name: string): Setting | { ambiguous: Setting[] } | null {
  const wanted = name.toLowerCase();
  const exact = SETTINGS.find((s) => s.key.toLowerCase() === wanted);
  if (exact) return exact;
  const tail = SETTINGS.filter((s) => s.key.split('.').pop()?.toLowerCase() === wanted);
  if (tail.length === 1) return tail[0] as Setting;
  return tail.length > 1 ? { ambiguous: tail } : null;
}

/** Two values of one setting are the same (a model chain is compared whole). */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The value one step on (+1) or back (-1), or null when a step cannot change
 * it: a number already at that end, text (which is typed, not stepped), and a
 * model chain of the user's own, which a step would replace with something it
 * cannot give back.
 */
export function stepSetting(setting: Setting, value: unknown, direction: 1 | -1): unknown {
  switch (setting.kind) {
    case 'toggle':
      return value !== true;
    case 'choice': {
      const choices = setting.choices ?? [];
      if (choices.length === 0) return null;
      const at = choices.indexOf(String(value));
      const from = at < 0 ? (direction > 0 ? -1 : 0) : at;
      return choices[(from + direction + choices.length) % choices.length] ?? null;
    }
    case 'number':
      return stepNumber(setting, value, direction);
    case 'models': {
      const chain = chainOf(value);
      return direction > 0 ? nextModelPreference(chain) : previousModelPreference(chain);
    }
    default:
      return null;
  }
}

function stepNumber(setting: Setting, value: unknown, direction: 1 | -1): number | null {
  const min = setting.min ?? 0;
  const max = setting.max ?? Number.MAX_SAFE_INTEGER;
  const step = setting.step ?? 1;
  const { off } = setting;
  const current = typeof value === 'number' ? value : min;
  // Off sits just past one end of the range: below it for "move early" (0),
  // above it for "hold back" (100). Stepping off that end turns it off, and
  // stepping back from off returns to that end.
  if (off !== undefined && current === off) {
    const offBelow = off < min;
    if (direction > 0) return offBelow ? min : null;
    return offBelow ? null : max;
  }
  // Onto the step grid, so a typed 87 steps to 90 or 85 rather than 92 or 82.
  const next = direction > 0 ? Math.floor(current / step) * step + step : Math.ceil(current / step) * step - step;
  if (off !== undefined && next < min && off < min) return off;
  if (off !== undefined && next > max && off > max) return off;
  const clamped = Math.min(max, Math.max(min, next));
  return clamped === current ? null : clamped;
}

/** The model preference before `current` in the dashboard's cycle; null for a chain of the user's own. */
function previousModelPreference(current: readonly string[]): [string, ...string[]] | null {
  // Stepping forward through every choice but one is stepping back by one.
  let chain: readonly string[] = current;
  for (let i = 0; i < MODEL_CHOICES.length - 1; i += 1) {
    const next = nextModelPreference(chain);
    if (!next) return null;
    chain = next;
  }
  return chain.length > 0 ? (chain as [string, ...string[]]) : null;
}

/** What the box opens with when the setting is typed rather than stepped. */
export function editText(setting: Setting, value: unknown): string {
  if (setting.kind === 'models') return chainOf(value).join(', ');
  if (setting.kind === 'number' && value === setting.off) return 'off';
  return value === undefined || value === null ? '' : String(value);
}

/** Settings a key steps (toggles and choices); the rest open a box on enter. */
export function isTyped(setting: Setting): boolean {
  return setting.kind === 'text' || setting.kind === 'number' || setting.kind === 'models';
}

/**
 * A typed value, checked. Throws with what is wrong, worded for the person
 * typing it, so the box can stay open with the reason under it.
 */
export function parseSetting(setting: Setting, text: string): unknown {
  const typed = text.trim();
  switch (setting.kind) {
    case 'toggle': {
      if (/^(on|yes|true|1)$/i.test(typed)) return true;
      if (/^(off|no|false|0)$/i.test(typed)) return false;
      throw new Error('say on or off');
    }
    case 'choice': {
      const choices = setting.choices ?? [];
      const hit =
        choices.find((c) => c.toLowerCase() === typed.toLowerCase()) ??
        choices.find((c) => setting.words(c).toLowerCase() === typed.toLowerCase());
      if (hit === undefined) throw new Error(`one of: ${choices.join(', ')}`);
      return hit;
    }
    case 'number': {
      if (setting.off !== undefined && /^off$/i.test(typed)) return setting.off;
      const min = setting.min ?? 0;
      const max = setting.max ?? Number.MAX_SAFE_INTEGER;
      const n = Number(typed);
      const range = `a whole number from ${min} to ${max}${setting.off !== undefined ? ', or off' : ''}`;
      if (typed === '' || !Number.isInteger(n)) throw new Error(range);
      if (n === setting.off) return n;
      if (n < min || n > max) throw new Error(range);
      return n;
    }
    case 'models': {
      const chain = typed.split(/[\s,]+/).filter(Boolean);
      if (chain.length === 0) throw new Error('name at least one model, such as: opus, fable');
      return chain;
    }
    default: {
      // Both prompts are typed into a session, so they follow the rules the
      // session itself checks them by: one line, not empty, not a flag.
      const checked = checkResumePrompt(typed);
      if (!checked.ok) throw new Error(checked.reason);
      return checked.prompt;
    }
  }
}
