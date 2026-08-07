import { describe, it, expect } from 'vitest';
import { screenGatedOutput } from './screen-gated-output.js';

const collector = () => {
  const said: string[] = [];
  return { said, out: screenGatedOutput((m) => said.push(m)) };
};

describe('screenGatedOutput', () => {
  it('says it straight away when the screen is free', () => {
    const { said, out } = collector();
    out.say('every account has hit its limit');
    expect(said).toEqual(['every account has hit its limit']);
  });

  it('does NOT write while Claude is drawing', () => {
    // The reported failure: these words appeared inside the input box of a
    // session that was running fine, which reads as a live refusal.
    const { said, out } = collector();
    out.setBusy(true);
    out.say('every account has hit its limit');
    expect(said).toEqual([]);
    expect(out.held()).toBe('every account has hit its limit');
  });

  it('says it once the screen comes back, rather than losing it', () => {
    // The opposite failure, which shipped first: silence leaves the operator at
    // a blank prompt with nothing explaining why nothing ran.
    const { said, out } = collector();
    out.setBusy(true);
    out.say('needs signing in');
    out.setBusy(false);
    expect(said).toEqual(['needs signing in']);
    expect(out.held()).toBeNull();
  });

  it('keeps only the LAST ending, since an ending replaces the one before it', () => {
    const { said, out } = collector();
    out.setBusy(true);
    out.say('first');
    out.say('second');
    out.setBusy(false);
    expect(said).toEqual(['second']);
  });

  it('does not repeat itself when the screen is handed back twice', () => {
    const { said, out } = collector();
    out.setBusy(true);
    out.say('once only');
    out.setBusy(false);
    out.setBusy(false);
    expect(said).toEqual(['once only']);
  });

  it('writes normally again after the screen has been released', () => {
    const { said, out } = collector();
    out.setBusy(true);
    out.setBusy(false);
    out.say('later message');
    expect(said).toEqual(['later message']);
  });
});
