import { describe, expect, it } from 'vitest';
import {
  gatherMcpLogins,
  holdsMcpLogins,
  holdsMcpLoginsOf,
  holdsNoLogin,
  mergeMcpLogins,
  parkMcpLogins,
  withMcpLogins,
} from './mcp-logins.js';

const claude = (n: number) => ({
  accessToken: `a-${n}`,
  refreshToken: `r-${n}`,
  expiresAt: 1_800_000_000_000 + n,
});
const mcp = (n: number) => ({
  'notion|1': { accessToken: `mcp-access-fake-${n}`, refreshToken: `mcp-refresh-fake-${n}` },
});
/** Sign-ins to a second server, so a merge per server can be told from one that replaces the lot. */
const datadog = (n: number) => ({
  'datadog|2': { accessToken: `dd-access-fake-${n}`, refreshToken: `dd-refresh-fake-${n}` },
});
const text = (value: unknown): string => JSON.stringify(value);
const parse = (value: string): Record<string, unknown> =>
  JSON.parse(value) as Record<string, unknown>;

describe('the text written when one login is installed over another', () => {
  const source = text({ claudeAiOauth: claude(2), mcpOAuth: mcp(2) });
  const target = text({ claudeAiOauth: claude(1), mcpOAuth: mcp(1) });

  it('keeps the target its own MCP logins, and the source its Claude login, by default', () => {
    const merged = parse(mergeMcpLogins(source, target));
    expect(merged.claudeAiOauth).toEqual(claude(2));
    expect(merged.mcpOAuth).toEqual(mcp(1));
  });

  it('gives the source no MCP logins when the target has none', () => {
    const merged = parse(mergeMcpLogins(source, text({ claudeAiOauth: claude(1) })));
    expect(merged).toEqual({ claudeAiOauth: claude(2) });
  });

  it('gives a target with no text no MCP logins either, as an account with no login has none', () => {
    expect(parse(mergeMcpLogins(source, null))).toEqual({ claudeAiOauth: claude(2) });
  });

  it('adds the target its MCP logins to a source that has none', () => {
    const merged = parse(mergeMcpLogins(text({ claudeAiOauth: claude(2) }), target));
    expect(merged).toEqual({ claudeAiOauth: claude(2), mcpOAuth: mcp(1) });
  });

  it('keeps every other key of the source as it is, and MCP logins where the source had them', () => {
    const rich = text({
      organizationUuid: 'org',
      claudeAiOauth: claude(2),
      mcpOAuth: mcp(2),
      future: { a: [1, 2] },
    });
    const merged = mergeMcpLogins(rich, target);
    expect(Object.keys(parse(merged))).toEqual([
      'organizationUuid',
      'claudeAiOauth',
      'mcpOAuth',
      'future',
    ]);
    expect(parse(merged)).toEqual({
      organizationUuid: 'org',
      claudeAiOauth: claude(2),
      mcpOAuth: mcp(1),
      future: { a: [1, 2] },
    });
  });

  it('is the source itself, byte for byte, when neither side holds MCP logins', () => {
    const pretty = `${JSON.stringify({ claudeAiOauth: claude(2), other: 1 }, null, 2)}\n`;
    const plain = text({ claudeAiOauth: claude(1) });
    expect(mergeMcpLogins(pretty, plain)).toBe(pretty);
    expect(mergeMcpLogins(pretty, null)).toBe(pretty);
    expect(mergeMcpLogins(pretty, plain, 'folder')).toBe(pretty);
  });

  it.each([
    ['a source that is not JSON', '{"claudeAiOauth":', target],
    ['a target that is not JSON', source, '{"claudeAiOauth":'],
    ['a source that is not an object', '[1,2]', target],
    ['a target that is not an object', source, 'null'],
    ['a target that is blank', source, '  '],
  ])('is the source as it is, and throws nothing, for %s', (_what, from, over) => {
    expect(mergeMcpLogins(from, over)).toBe(from);
    expect(mergeMcpLogins(from, over, 'folder')).toBe(from);
  });

  describe('from a store that is ending (park)', () => {
    it('is the source whole when it holds MCP logins, though the target holds some of the same servers', () => {
      expect(mergeMcpLogins(source, target, 'park')).toBe(source);
      expect(mergeMcpLogins(source, null, 'park')).toBe(source);
    });

    it('joins the two server by server: the source for a server it holds, the target for the rest', () => {
      const ending = text({ claudeAiOauth: claude(2), mcpOAuth: { ...mcp(2) } });
      const parked = text({ claudeAiOauth: claude(1), mcpOAuth: { ...mcp(1), ...datadog(1) } });
      const merged = parse(mergeMcpLogins(ending, parked, 'park'));
      expect(merged.claudeAiOauth).toEqual(claude(2));
      expect(merged.mcpOAuth).toEqual({ ...mcp(2), ...datadog(1) });
    });

    it('keeps the target a server the source does not hold, and gives the source its own', () => {
      const ending = text({ claudeAiOauth: claude(2), mcpOAuth: datadog(2) });
      const merged = parse(mergeMcpLogins(ending, target, 'park'));
      expect(merged.mcpOAuth).toEqual({ ...mcp(1), ...datadog(2) });
    });

    it('holds nothing in an empty set, so it leaves the target its MCP logins', () => {
      const emptied = text({ claudeAiOauth: claude(2), mcpOAuth: {} });
      expect(parse(mergeMcpLogins(emptied, target, 'park'))).toEqual({
        claudeAiOauth: claude(2),
        mcpOAuth: mcp(1),
      });
    });

    it('leaves the target its MCP logins when the source holds none, since another store may have parked them', () => {
      const none = text({ claudeAiOauth: claude(2) });
      expect(parse(mergeMcpLogins(none, target, 'park'))).toEqual({
        claudeAiOauth: claude(2),
        mcpOAuth: mcp(1),
      });
    });

    it('is the source as it is when neither holds any', () => {
      const none = `${JSON.stringify({ claudeAiOauth: claude(2) }, null, 2)}\n`;
      expect(mergeMcpLogins(none, text({ claudeAiOauth: claude(1) }), 'park')).toBe(none);
    });
  });

  describe('into a folder a Claude runs on', () => {
    it.each([null, '', '  \n', '{}', ' { } '])(
      'starts a folder holding %j from the source whole',
      (held) => {
        expect(mergeMcpLogins(source, held, 'folder')).toBe(source);
      },
    );

    it('keeps a folder its own MCP logins once it holds a login', () => {
      expect(parse(mergeMcpLogins(source, target, 'folder')).mcpOAuth).toEqual(mcp(1));
    });

    it('keeps its MCP logins in a folder whose Claude signed out, though it holds no login', () => {
      const signedOut = text({
        claudeAiOauth: { accessToken: '', refreshToken: '' },
        mcpOAuth: mcp(1),
      });
      expect(parse(mergeMcpLogins(source, signedOut, 'folder')).mcpOAuth).toEqual(mcp(1));
      const onlyMcp = text({ mcpOAuth: mcp(1) });
      expect(parse(mergeMcpLogins(source, onlyMcp, 'folder')).mcpOAuth).toEqual(mcp(1));
    });

    it('writes the source as it is over a folder whose text is not JSON', () => {
      expect(mergeMcpLogins(source, '{"claudeAiOauth":', 'folder')).toBe(source);
    });
  });
});

describe('whether a store holds no login at all', () => {
  it.each([null, '', ' ', '\n', '{}', ' {\n} '])('is true for %j', (held) => {
    expect(holdsNoLogin(held)).toBe(true);
  });

  it.each([
    text({ claudeAiOauth: claude(1) }),
    text({ mcpOAuth: mcp(1) }),
    text({ claudeAiOauth: { accessToken: '' } }),
    '{"claudeAiOauth":',
    '[]',
  ])('is false for %j', (held) => {
    expect(holdsNoLogin(held)).toBe(false);
  });
});

describe("an ending store's MCP logins, parked in an account's saved login", () => {
  const saved = text({ claudeAiOauth: claude(5), mcpOAuth: mcp(1) });

  it('replaces the saved sign-in of a server it holds, and keeps the saved Claude login as it is', () => {
    const parked = parse(
      parkMcpLogins(saved, text({ claudeAiOauth: claude(3), mcpOAuth: mcp(2) })),
    );
    expect(parked.claudeAiOauth).toEqual(claude(5));
    expect(parked.mcpOAuth).toEqual(mcp(2));
  });

  it('keeps the saved sign-ins of servers it does not hold, so two stores that ended each leave theirs', () => {
    const first = parse(parkMcpLogins(saved, text({ mcpOAuth: datadog(2) })));
    expect(first.mcpOAuth).toEqual({ ...mcp(1), ...datadog(2) });
    const second = parse(parkMcpLogins(text(first), text({ mcpOAuth: mcp(3) })));
    expect(second.mcpOAuth).toEqual({ ...mcp(3), ...datadog(2) });
  });

  it('parks nothing for an empty set, which is a store signed out of its last server', () => {
    expect(parkMcpLogins(saved, text({ claudeAiOauth: claude(3), mcpOAuth: {} }))).toBe(saved);
  });

  it('adds them to a saved login that has none', () => {
    const parked = parse(
      parkMcpLogins(text({ claudeAiOauth: claude(5) }), text({ mcpOAuth: mcp(2) })),
    );
    expect(parked).toEqual({ claudeAiOauth: claude(5), mcpOAuth: mcp(2) });
  });

  it('leaves the saved login alone, as the same string, when the store holds none', () => {
    expect(parkMcpLogins(saved, text({ claudeAiOauth: claude(3) }))).toBe(saved);
  });

  it('leaves the saved login alone, as the same string, when it holds the same ones already', () => {
    const pretty = `${JSON.stringify({ claudeAiOauth: claude(5), mcpOAuth: mcp(2) }, null, 2)}\n`;
    expect(parkMcpLogins(pretty, text({ mcpOAuth: mcp(2) }))).toBe(pretty);
    const more = text({ claudeAiOauth: claude(5), mcpOAuth: { ...mcp(2), ...datadog(1) } });
    expect(parkMcpLogins(more, text({ mcpOAuth: mcp(2) }))).toBe(more);
  });

  it.each([
    ['a saved login that is not JSON', '{"claudeAiOauth":', text({ mcpOAuth: mcp(2) })],
    ["an ending store's text that is not JSON", saved, '{"mcpOAuth":'],
  ])('leaves the saved login alone for %s', (_what, copy, ending) => {
    expect(parkMcpLogins(copy, ending)).toBe(copy);
  });
});

describe('whether a text holds MCP logins', () => {
  it('does when it has sign-ins in mcpOAuth', () => {
    expect(holdsMcpLogins(text({ claudeAiOauth: claude(1), mcpOAuth: mcp(1) }))).toBe(true);
  });

  it.each([
    text({ claudeAiOauth: claude(1) }),
    text({ mcpOAuth: {} }),
    text({ mcpOAuth: [] }),
    text({ mcpOAuth: 'notion' }),
    '{}',
    '{"mcpOAuth":',
    '[]',
    '',
  ])('does not for %j', (held) => {
    expect(holdsMcpLogins(held)).toBe(false);
  });
});

describe('whether a saved login holds the MCP logins of another text', () => {
  it('does when each server is there with the same sign-in, and more is fine', () => {
    const ending = text({ mcpOAuth: mcp(1) });
    expect(holdsMcpLoginsOf(text({ claudeAiOauth: claude(1), mcpOAuth: mcp(1) }), ending)).toBe(
      true,
    );
    expect(holdsMcpLoginsOf(text({ mcpOAuth: { ...mcp(1), ...datadog(1) } }), ending)).toBe(true);
  });

  it('does not when a server is missing or holds another sign-in', () => {
    const ending = text({ mcpOAuth: { ...mcp(1), ...datadog(1) } });
    expect(holdsMcpLoginsOf(text({ mcpOAuth: mcp(1) }), ending)).toBe(false);
    expect(holdsMcpLoginsOf(text({ mcpOAuth: { ...mcp(1), ...datadog(2) } }), ending)).toBe(false);
    expect(holdsMcpLoginsOf(text({ claudeAiOauth: claude(1) }), ending)).toBe(false);
  });

  it('does not when either text is not a JSON object', () => {
    expect(holdsMcpLoginsOf('{"mcpOAuth":', text({ mcpOAuth: mcp(1) }))).toBe(false);
    expect(holdsMcpLoginsOf(text({ mcpOAuth: mcp(1) }), '{"mcpOAuth":')).toBe(false);
  });
});

describe('the MCP logins of several stores of one folder', () => {
  it('are those they hold between them, server by server', () => {
    const gathered = gatherMcpLogins([
      text({ claudeAiOauth: claude(1), mcpOAuth: mcp(1) }),
      text({ mcpOAuth: datadog(2) }),
    ]);
    expect(gathered).toEqual({ ...mcp(1), ...datadog(2) });
  });

  it('are those of the first store for a server more than one holds', () => {
    const gathered = gatherMcpLogins([
      text({ mcpOAuth: mcp(1) }),
      text({ mcpOAuth: { ...mcp(2), ...datadog(2) } }),
      text({ mcpOAuth: datadog(3) }),
    ]);
    expect(gathered).toEqual({ ...mcp(1), ...datadog(2) });
  });

  it('are none when no store holds a sign-in, or its text is not a login at all', () => {
    expect(gatherMcpLogins([])).toBeNull();
    expect(
      gatherMcpLogins([
        text({ claudeAiOauth: claude(1) }),
        text({ mcpOAuth: {} }),
        '{}',
        '{"mcpOAuth":',
      ]),
    ).toBeNull();
  });

  it('are carried by a text with its Claude login as it is', () => {
    const carried = parse(
      withMcpLogins(text({ claudeAiOauth: claude(1), mcpOAuth: mcp(1) }), {
        ...mcp(1),
        ...datadog(2),
      }),
    );
    expect(carried.claudeAiOauth).toEqual(claude(1));
    expect(carried.mcpOAuth).toEqual({ ...mcp(1), ...datadog(2) });
  });

  it('leave a text that holds them already as the same string', () => {
    const pretty = `${JSON.stringify({ claudeAiOauth: claude(1), mcpOAuth: mcp(1) }, null, 2)}\n`;
    expect(withMcpLogins(pretty, mcp(1))).toBe(pretty);
  });

  it('are all that a text which is not a login carries', () => {
    expect(parse(withMcpLogins('{"claudeAiOauth":', mcp(1)))).toEqual({ mcpOAuth: mcp(1) });
  });
});

describe('the newest sign-in of a server that both sides hold', () => {
  /** A sign-in to Notion expiring at `expiresAt`, a later expiry being a later refresh, its tokens named by `by`. */
  const notionAt = (expiresAt: number | string | undefined, by: string) => ({
    'notion|1': {
      accessToken: `mcp-access-fake-${by}`,
      refreshToken: `mcp-refresh-fake-${by}`,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
  });
  const T0 = 1_900_000_000_000;
  const T1 = T0 + 3_600_000;
  const refreshed = notionAt(T1, 'refreshed');
  const untouched = notionAt(T0, 'untouched');

  describe('parked from a store that is ending', () => {
    it('keeps the target the sign-in that expires later than the source', () => {
      const ending = text({ claudeAiOauth: claude(2), mcpOAuth: untouched });
      const parked = text({ claudeAiOauth: claude(1), mcpOAuth: refreshed });
      const merged = parse(mergeMcpLogins(ending, parked, 'park'));
      expect(merged.claudeAiOauth).toEqual(claude(2));
      expect(merged.mcpOAuth).toEqual(refreshed);
    });

    it('is the source as it is when its sign-in expires later than the target', () => {
      const ending = text({ claudeAiOauth: claude(2), mcpOAuth: refreshed });
      expect(mergeMcpLogins(ending, text({ mcpOAuth: untouched }), 'park')).toBe(ending);
    });

    it('keeps the newer of each server, one from the source and one from the target', () => {
      const ending = text({ mcpOAuth: { ...untouched, ...datadog(5) } });
      const parked = text({ mcpOAuth: { ...refreshed, ...datadog(4) } });
      const merged = parse(mergeMcpLogins(ending, parked, 'park'));
      // Datadog's sign-ins carry no expiry, so the source's stands.
      expect(merged.mcpOAuth).toEqual({ ...refreshed, ...datadog(5) });
    });

    it.each([
      ['the same expiry', notionAt(T0, 'target'), notionAt(T0, 'source')],
      ['no expiry in the target', notionAt(undefined, 'target'), notionAt(T0, 'source')],
      ['no expiry in the source', notionAt(T1, 'target'), notionAt(undefined, 'source')],
      ['an expiry that is not a number', notionAt('later', 'target'), notionAt(T0, 'source')],
    ])('takes the source for %s', (_what, inTarget, inSource) => {
      const ending = text({ claudeAiOauth: claude(2), mcpOAuth: inSource });
      expect(mergeMcpLogins(ending, text({ mcpOAuth: inTarget }), 'park')).toBe(ending);
    });
  });

  describe('parked in a saved login', () => {
    it('leaves the saved login as the same string when it holds the sign-in that expires later', () => {
      const saved = text({ claudeAiOauth: claude(5), mcpOAuth: refreshed });
      expect(parkMcpLogins(saved, text({ mcpOAuth: untouched }))).toBe(saved);
    });

    it('replaces a sign-in that expires earlier, and keeps the Claude login', () => {
      const saved = text({ claudeAiOauth: claude(5), mcpOAuth: untouched });
      const parked = parse(parkMcpLogins(saved, text({ mcpOAuth: refreshed })));
      expect(parked.claudeAiOauth).toEqual(claude(5));
      expect(parked.mcpOAuth).toEqual(refreshed);
    });

    it('keeps the newer of each server, and the other servers it holds', () => {
      const saved = text({ mcpOAuth: { ...refreshed, ...datadog(1) } });
      const parked = parse(
        parkMcpLogins(saved, text({ mcpOAuth: { ...untouched, ...datadog(2) } })),
      );
      // Notion's saved sign-in expires later and stays, and Datadog's carry no expiry, so the ending store's stands.
      expect(parked.mcpOAuth).toEqual({ ...refreshed, ...datadog(2) });
    });

    it.each([
      ['the same expiry', notionAt(T0, 'saved'), notionAt(T0, 'ending')],
      ['no expiry in the saved login', notionAt(undefined, 'saved'), notionAt(T0, 'ending')],
      ['no expiry in the ending store', notionAt(T1, 'saved'), notionAt(undefined, 'ending')],
      ['an expiry that is not a number', notionAt('later', 'saved'), notionAt(T0, 'ending')],
    ])('takes the ending store for %s', (_what, inSaved, inEnding) => {
      const saved = text({ claudeAiOauth: claude(5), mcpOAuth: inSaved });
      expect(parse(parkMcpLogins(saved, text({ mcpOAuth: inEnding }))).mcpOAuth).toEqual(inEnding);
    });

    it('holds the sign-ins of another text when it has the same or a newer one of each', () => {
      expect(holdsMcpLoginsOf(text({ mcpOAuth: refreshed }), text({ mcpOAuth: untouched }))).toBe(
        true,
      );
      expect(holdsMcpLoginsOf(text({ mcpOAuth: untouched }), text({ mcpOAuth: refreshed }))).toBe(
        false,
      );
      expect(holdsMcpLoginsOf(text({ mcpOAuth: untouched }), text({ mcpOAuth: untouched }))).toBe(
        true,
      );
    });
  });

  describe('gathered from the stores of one folder', () => {
    it('is the one that expires latest, whichever store holds it', () => {
      const gathered = gatherMcpLogins([
        text({ mcpOAuth: notionAt(T0, 'first') }),
        text({ mcpOAuth: refreshed }),
        text({ mcpOAuth: notionAt(T0 + 1, 'third') }),
      ]);
      expect(gathered).toEqual(refreshed);
    });

    it('is the one of the first store that holds the server when the expiry is the same or unknown', () => {
      expect(
        gatherMcpLogins([
          text({ mcpOAuth: notionAt(T0, 'first') }),
          text({ mcpOAuth: notionAt(T0, 'second') }),
        ]),
      ).toEqual(notionAt(T0, 'first'));
      expect(
        gatherMcpLogins([
          text({ mcpOAuth: notionAt(undefined, 'first') }),
          text({ mcpOAuth: notionAt(T1, 'second') }),
        ]),
      ).toEqual(notionAt(undefined, 'first'));
    });

    it('is carried by a text whose own sign-in expires earlier', () => {
      const carried = parse(
        withMcpLogins(text({ claudeAiOauth: claude(1), mcpOAuth: untouched }), refreshed),
      );
      expect(carried.claudeAiOauth).toEqual(claude(1));
      expect(carried.mcpOAuth).toEqual(refreshed);
    });
  });
});
