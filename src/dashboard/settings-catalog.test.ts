import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../config/config.schema.js';
import {
  SETTINGS,
  appliesWords,
  defaultOf,
  editText,
  findSetting,
  isTyped,
  parseSetting,
  sameValue,
  stepSetting,
  valueOf,
  type Setting,
} from './settings-catalog.js';

const setting = (key: string): Setting => {
  const found = SETTINGS.find((s) => s.key === key);
  if (!found) throw new Error(`no setting ${key}`);
  return found;
};

/** Every `section.field` (or top-level key) the config holds by default. */
function configKeys(): string[] {
  const defaults = ConfigSchema.parse({}) as Record<string, unknown>;
  const keys: string[] = [];
  for (const [section, value] of Object.entries(defaults)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const field of Object.keys(value)) keys.push(`${section}.${field}`);
    } else {
      keys.push(section);
    }
  }
  return keys;
}

describe('the settings catalog', () => {
  it('covers every setting in the config, or leaves it out on purpose', () => {
    // A setting added to the config without a row here would be one the
    // dashboard silently cannot change. This fails until someone decides.
    const leftOut = ['browser.debugPort', 'browser.channel', 'realClaudePath'];
    const missing = configKeys().filter((k) => !leftOut.includes(k) && !SETTINGS.some((s) => s.key === k));
    expect(missing).toEqual([]);
  });

  it('only describes settings that exist, each once', () => {
    const defaults = ConfigSchema.parse({});
    for (const s of SETTINGS) expect(valueOf(defaults, s.key), s.key).not.toBeUndefined();
    expect(new Set(SETTINGS.map((s) => s.key)).size).toBe(SETTINGS.length);
  });

  it('can say every default in words', () => {
    for (const s of SETTINGS) expect(s.words(defaultOf(s)), s.key).not.toBe('');
  });

  it('asks before changing what edits files outside ccx, and only that', () => {
    expect(SETTINGS.filter((s) => s.confirm).map((s) => s.key)).toEqual([
      'desktop.handoff',
      'desktop.mode',
      'artifacts.home',
      'artifacts.updates',
    ]);
    expect(setting('artifacts.home').confirm?.('work')).toContain('~/.claude/settings.json');
    expect(setting('artifacts.updates').confirm?.('owner')).toContain('~/.claude/settings.json');
    expect(setting('desktop.handoff').confirm?.('credits')).toContain('~/.claude/settings.json');
  });
});

describe('stepping a setting with the arrows', () => {
  it('flips a toggle', () => {
    expect(stepSetting(setting('update.follow'), true, 1)).toBe(false);
    expect(stepSetting(setting('update.follow'), false, -1)).toBe(true);
  });

  it('goes round a choice, either way', () => {
    const order = setting('rotation.accountOrder');
    expect(stepSetting(order, 'smart', 1)).toBe('most-room');
    expect(stepSetting(order, 'priority', 1)).toBe('smart');
    expect(stepSetting(order, 'smart', -1)).toBe('priority');
  });

  it('moves a number along its grid, snapping a typed value onto it, and stops at the ends', () => {
    const backoff = setting('rotation.defaultBackoffMinutes');
    expect(stepSetting(backoff, 300, 1)).toBe(315);
    expect(stepSetting(backoff, 302, 1)).toBe(315);
    expect(stepSetting(backoff, 302, -1)).toBe(300);
    expect(stepSetting(backoff, 1440, 1)).toBeNull();
    expect(stepSetting(backoff, 15, -1)).toBeNull();
  });

  it('turns hold-back off past its top, and back on from there', () => {
    const holdBack = setting('rotation.holdBackAtPercent');
    expect(stepSetting(holdBack, 80, 1)).toBe(85);
    expect(stepSetting(holdBack, 95, 1)).toBe(100);
    expect(stepSetting(holdBack, 100, -1)).toBe(95);
    expect(stepSetting(holdBack, 100, 1)).toBeNull();
    expect(stepSetting(holdBack, 50, -1)).toBeNull();
    expect(setting('rotation.holdBackAtPercent').words(100)).toBe('off');
  });

  it('turns early moves on from off at the bottom of their range, and off again below it', () => {
    const early = setting('rotation.proactivePercent');
    expect(stepSetting(early, 0, 1)).toBe(50);
    expect(stepSetting(early, 50, -1)).toBe(0);
    expect(stepSetting(early, 0, -1)).toBeNull();
    expect(early.words(0)).toBe('off');
  });

  it('steps a value set outside the arrows range back into it, never the wrong way', () => {
    // 30 came from `ccx proactive on --percent 30`: right is up, into the
    // range, not off; left is further down, past the bottom, which is off.
    const early = setting('rotation.proactivePercent');
    expect(stepSetting(early, 30, 1)).toBe(50);
    expect(stepSetting(early, 30, -1)).toBe(0);
    const daemon = setting('rotation.capThresholdPercent');
    expect(stepSetting(daemon, 30, 1)).toBe(50);
    expect(stepSetting(daemon, 30, -1)).toBeNull();
    const holdBack = setting('rotation.holdBackAtPercent');
    expect(stepSetting(holdBack, 97, 1)).toBe(100);
    expect(stepSetting(holdBack, 97, -1)).toBe(95);
  });

  it('cycles the usual model preferences both ways, and leaves a chain of your own alone', () => {
    const models = setting('rotation.modelPreference');
    expect(stepSetting(models, ['opus', 'fable'], 1)).toEqual(['fable', 'opus']);
    expect(stepSetting(models, ['opus', 'fable'], -1)).toEqual(['fable']);
    expect(stepSetting(models, ['sonnet', 'opus'], 1)).toBeNull();
    expect(stepSetting(models, ['sonnet', 'opus'], -1)).toBeNull();
  });

  it('does not step text, which is typed', () => {
    expect(stepSetting(setting('resume.prompt'), 'carry on', 1)).toBeNull();
    expect(isTyped(setting('resume.prompt'))).toBe(true);
    expect(isTyped(setting('update.follow'))).toBe(false);
  });
});

describe('typing a value', () => {
  it('takes on and off for a toggle, in the usual spellings', () => {
    const follow = setting('update.follow');
    for (const yes of ['on', 'YES', 'true', '1']) expect(parseSetting(follow, yes)).toBe(true);
    for (const no of ['off', 'no', 'False', '0']) expect(parseSetting(follow, no)).toBe(false);
    expect(() => parseSetting(follow, 'maybe')).toThrow('say on or off');
  });

  it('takes a choice by its name or by the words the screen shows', () => {
    const order = setting('rotation.accountOrder');
    expect(parseSetting(order, 'most-room')).toBe('most-room');
    expect(parseSetting(order, 'Longest run first')).toBe('smart');
    expect(() => parseSetting(order, 'fastest')).toThrow('one of: smart, most-room, priority');
  });

  it('takes a whole number in range, or off where there is one', () => {
    const holdBack = setting('rotation.holdBackAtPercent');
    expect(parseSetting(holdBack, ' 85 ')).toBe(85);
    expect(parseSetting(holdBack, 'off')).toBe(100);
    expect(parseSetting(holdBack, '100')).toBe(100);
    expect(parseSetting(holdBack, '97')).toBe(97);
    expect(() => parseSetting(holdBack, '40')).toThrow('a whole number from 50 to 99, or off');
    expect(() => parseSetting(holdBack, '82.5')).toThrow('a whole number');
    expect(() => parseSetting(setting('rotation.usageCheckSeconds'), 'off')).toThrow('from 30 to 86400');
  });

  it('takes what the command line takes, even outside the range the arrows step through', () => {
    // `ccx proactive on --percent 30` sets 30; it can be typed here too.
    expect(parseSetting(setting('rotation.proactivePercent'), '30')).toBe(30);
    expect(parseSetting(setting('rotation.capThresholdPercent'), '20')).toBe(20);
  });

  it('takes a model chain separated by commas or spaces', () => {
    const models = setting('rotation.modelPreference');
    expect(parseSetting(models, 'opus, fable')).toEqual(['opus', 'fable']);
    expect(parseSetting(models, 'fable opus')).toEqual(['fable', 'opus']);
    expect(() => parseSetting(models, ' , ')).toThrow('name at least one model');
  });

  it('checks a prompt the way the session will, before it is saved', () => {
    const prompt = setting('resume.prompt');
    expect(parseSetting(prompt, '  carry   on ')).toBe('carry on');
    expect(() => parseSetting(prompt, '   ')).toThrow('empty');
    expect(() => parseSetting(prompt, '--resume')).toThrow('flag');
  });

  it('opens the box with the value as it would be typed', () => {
    expect(editText(setting('rotation.modelPreference'), ['opus', 'fable'])).toBe('opus, fable');
    expect(editText(setting('rotation.holdBackAtPercent'), 100)).toBe('off');
    expect(editText(setting('rotation.holdBackAtPercent'), 80)).toBe('80');
  });
});

describe('the page settings', () => {
  it('are both off by default, and say so in words', () => {
    expect(defaultOf(setting('artifacts.home'))).toBeNull();
    expect(setting('artifacts.home').words(null)).toContain('off');
    expect(setting('artifacts.home').words('work')).toBe('work');
    expect(defaultOf(setting('artifacts.updates'))).toBe('off');
    expect(setting('artifacts.updates').words('off')).toContain('off');
    expect(setting('artifacts.updates').words('owner')).toContain('owns');
  });

  it('take an account name for the home account, or off', () => {
    const home = setting('artifacts.home');
    expect(parseSetting(home, ' work ')).toBe('work');
    expect(parseSetting(home, 'stephen.alvis-2')).toBe('stephen.alvis-2');
    for (const off of ['off', 'OFF', 'none']) expect(parseSetting(home, off)).toBeNull();
    expect(() => parseSetting(home, 'two words')).toThrow('an account name, or off');
    expect(() => parseSetting(home, '../etc')).toThrow('an account name, or off');
    expect(() => parseSetting(home, '')).toThrow('an account name, or off');
  });

  it('type the home account rather than step it, and open the box with what would be typed', () => {
    const home = setting('artifacts.home');
    expect(isTyped(home)).toBe(true);
    expect(stepSetting(home, null, 1)).toBeNull();
    expect(editText(home, null)).toBe('off');
    expect(editText(home, 'work')).toBe('work');
  });

  it('step updates between off and the owner', () => {
    const updates = setting('artifacts.updates');
    expect(stepSetting(updates, 'off', 1)).toBe('owner');
    expect(stepSetting(updates, 'owner', 1)).toBe('off');
    expect(parseSetting(updates, 'owner')).toBe('owner');
    expect(() => parseSetting(updates, 'always')).toThrow('one of: off, owner');
  });

  it('say that a running session follows when its Claude next starts', () => {
    expect(appliesWords(setting('artifacts.home').applies)).toContain('next starts');
    expect(appliesWords(setting('artifacts.updates').applies)).toContain('next starts');
  });
});

describe('finding a setting by name', () => {
  it('by its whole key, or by its last part when only one ends that way, in any case', () => {
    expect(findSetting('rotation.accountOrder')).toBe(setting('rotation.accountOrder'));
    expect(findSetting('holdbackatpercent')).toBe(setting('rotation.holdBackAtPercent'));
    expect(findSetting('nothing')).toBeNull();
  });

  it('says when a short name could be more than one', () => {
    const found = findSetting('prompt');
    expect(found && 'ambiguous' in found ? found.ambiguous.map((s) => s.key) : []).toEqual([
      'resume.prompt',
      'desktop.prompt',
    ]);
  });
});

describe('defaults and timing', () => {
  it('reads defaults from the schema itself', () => {
    expect(defaultOf(setting('rotation.holdBackAtPercent'))).toBe(80);
    expect(defaultOf(setting('rotation.accountOrder'))).toBe('smart');
    expect(sameValue(defaultOf(setting('rotation.modelPreference')), ['opus', 'fable'])).toBe(true);
  });

  it('says when a change takes effect', () => {
    expect(appliesWords('next-move')).toBe("Takes effect at each session's next move.");
    expect(appliesWords('new-sessions')).toBe('Takes effect in sessions started after the change.');
  });
});
