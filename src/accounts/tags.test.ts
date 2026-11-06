import { describe, it, expect } from 'vitest';
import {
  MAX_TAGS,
  normalizeTag,
  storedTags,
  parseTags,
  tagIndex,
  tagNote,
  taggedAll,
  withTags,
  withoutTags,
} from './tags.js';
import { TagError } from '../util/errors.js';

describe('a tag', () => {
  it('is lowercased and trimmed', () => {
    expect(normalizeTag('  Pat ')).toBe('pat');
    expect(normalizeTag('BOT-1')).toBe('bot-1');
    expect(normalizeTag('team.ops_2')).toBe('team.ops_2');
  });

  it('is refused, with the tag named, when it is not one', () => {
    for (const bad of ['', '   ', '-pat', '.pat', 'pat smith', 'pat/1', 'p@t', 'x'.repeat(33), 'émile']) {
      expect(() => normalizeTag(bad), JSON.stringify(bad)).toThrow(TagError);
    }
    expect(() => normalizeTag('p@t')).toThrow(/"p@t"/);
  });

  it('may be 32 characters, not 33', () => {
    expect(normalizeTag('a'.repeat(32))).toBe('a'.repeat(32));
    expect(() => normalizeTag('a'.repeat(33))).toThrow(TagError);
  });
});

describe('tags typed as one string', () => {
  it('split on spaces and commas, come out sorted and once each', () => {
    expect(parseTags('Pat, bot  pat,,stephen')).toEqual(['bot', 'pat', 'stephen']);
  });

  it('are none when the string is empty', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags(' , ')).toEqual([]);
  });

  it('refuse the whole string for one bad tag', () => {
    expect(() => parseTags('pat b@d')).toThrow(/"b@d"/);
  });
});

describe('adding and removing tags', () => {
  it('adds without repeating, sorted', () => {
    expect(withTags(['pat'], ['Bot', 'pat'])).toEqual(['bot', 'pat']);
    expect(withTags(undefined, ['pat'])).toEqual(['pat']);
  });

  it(`refuses more than ${MAX_TAGS} on one account`, () => {
    const many = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    expect(withTags(many.slice(1), [many[0]!])).toHaveLength(MAX_TAGS);
    expect(() => withTags(many, ['one-more'])).toThrow(TagError);
  });

  it('removes only the tags named, in any case', () => {
    expect(withoutTags(['bot', 'pat'], ['PAT'])).toEqual(['bot']);
    expect(withoutTags(['bot'], ['pat'])).toEqual(['bot']);
    expect(withoutTags(undefined, ['pat'])).toEqual([]);
  });
});

const accounts = [
  { name: 'a', tags: ['bot', 'pat'], enabled: false },
  { name: 'b', tags: ['pat'], enabled: true },
  { name: 'c', enabled: true },
];

describe('accounts carrying tags', () => {
  it('are the ones carrying every tag asked for', () => {
    expect(taggedAll(accounts, ['pat']).map((a) => a.name)).toEqual(['a', 'b']);
    expect(taggedAll(accounts, ['pat', 'BOT']).map((a) => a.name)).toEqual(['a']);
    expect(taggedAll(accounts, ['nobody'])).toEqual([]);
  });

  it('are indexed by tag, every tag in use once, sorted', () => {
    expect(tagIndex(accounts)).toEqual([
      { tag: 'bot', accounts: ['a'] },
      { tag: 'pat', accounts: ['a', 'b'] },
    ]);
  });
});

describe('tags in a line of text', () => {
  it('read as hash words, nothing when there are none', () => {
    expect(tagNote(['bot', 'pat'])).toBe('#bot #pat');
    expect(tagNote(undefined)).toBe('');
    expect(tagNote([])).toBe('');
  });
});

describe('tags as a file may hold them', () => {
  // A hand-edited accounts.json can hold `Pat`, or something that is not a
  // tag at all. What is stored is matched and removed in any case, kept
  // rather than lost, and never stops a good tag being added beside it.
  it('match, index and remove in any case', () => {
    const stored = [{ name: 'a', tags: ['BOT', 'Pat'] }];
    expect(taggedAll(stored, ['bot']).map((a) => a.name)).toEqual(['a']);
    expect(tagIndex(stored)).toEqual([
      { tag: 'bot', accounts: ['a'] },
      { tag: 'pat', accounts: ['a'] },
    ]);
    expect(withoutTags(['BOT', 'Pat'], ['pat'])).toEqual(['bot']);
  });

  it('do not stop a good tag being added beside one that is not a tag', () => {
    expect(withTags(['b@d'], ['pat'])).toEqual(['b@d', 'pat']);
    expect(() => withTags(['b@d'], ['also b@d'])).toThrow(TagError);
  });

  it('may already be over the limit: kept, and nothing new added until some go', () => {
    const many = Array.from({ length: MAX_TAGS + 2 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    expect(withTags(many, [many[0]!])).toHaveLength(MAX_TAGS + 2);
    expect(() => withTags(many, ['new'])).toThrow(TagError);
  });
});

describe('the tags field as read from the file', () => {
  it('is lowercased, trimmed, once each and sorted, and nothing is dropped for not being a tag', () => {
    expect(storedTags([' Pat', 'BOT', 'pat', 'b@d'])).toEqual(['b@d', 'bot', 'pat']);
  });

  it('takes a lone string as one tag, and other values as text', () => {
    expect(storedTags('Pat')).toEqual(['pat']);
    expect(storedTags([7, true])).toEqual(['7', 'true']);
  });

  it('is no tags for nothing, an empty list, or something that cannot be one', () => {
    expect(storedTags(undefined)).toBeUndefined();
    expect(storedTags([])).toBeUndefined();
    expect(storedTags(['', '  '])).toBeUndefined();
    expect(storedTags({ pat: true })).toBeUndefined();
  });
});
