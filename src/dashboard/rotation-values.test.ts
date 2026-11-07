import { describe, it, expect } from 'vitest';
import { rotationValues, settingsWords } from './rotation-settings.js';
import { loadConfig } from '../config/config.js';

/** `ccx state`'s settings: the same rules the screen words them by, as values. */
describe('the rotation settings as values', () => {
  const base = {
    modelPreference: ['opus', 'fable'],
    accountOrder: 'smart' as const,
    holdBackAtPercent: 80,
    modelStrategy: 'model-first' as const,
    preferSameModel: true,
    proactivePercent: 0,
  };

  it('gives each one as it is set', () => {
    expect(rotationValues({ ...base, proactivePercent: 90 })).toEqual({
      accountOrder: 'smart',
      modelPreference: ['opus', 'fable'],
      modelStrategy: 'model-first',
      preferSameModel: true,
      holdBackAtPercent: 80,
      proactivePercent: 90,
    });
  });

  it('says hold-back is off exactly where the screen leaves it unsaid', () => {
    // Only the smart order holds accounts back, and 100 turns it off: the
    // value and the words come from one rule, so they cannot disagree.
    for (const rotation of [
      { ...base, accountOrder: 'most-room' as const },
      { ...base, accountOrder: 'priority' as const },
      { ...base, holdBackAtPercent: 100 },
    ]) {
      expect(rotationValues(rotation).holdBackAtPercent).toBeNull();
      expect(settingsWords(rotation).holdBack).toBeUndefined();
    }
    expect(settingsWords(base).holdBack).toBe('weeks 80%+ used');
  });

  it('says proactive moves are off when they are', () => {
    expect(rotationValues(base).proactivePercent).toBeNull();
  });

  it('copies the model list, so a reader cannot change the settings it was handed', () => {
    const preference = ['fable'];
    const values = rotationValues({ ...base, modelPreference: preference });
    values.modelPreference.push('opus');
    expect(preference).toEqual(['fable']);
  });

  it('reads the defaults the way a fresh install has them', () => {
    const config = loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: '/nonexistent-ccx-home' } });
    expect(rotationValues(config.rotation)).toEqual({
      accountOrder: 'smart',
      modelPreference: ['opus', 'fable'],
      modelStrategy: 'model-first',
      preferSameModel: true,
      holdBackAtPercent: 80,
      proactivePercent: null,
    });
  });
});
