import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  installCredential,
  rollbackCredential,
  isUsableCredential,
  identityKey,
  credentialPath,
  previousCredentialPath,
  clearCredential,
  keepForRollback,
  nudgeLoginReread,
  REREAD_PLACEHOLDER,
  usableLoginText,
  installCredentialSteps,
} from './credential-vault.js';
import type { KeychainIo } from './keychain-view.js';
import { runBlocking } from '../util/steps.js';

function dir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cas-vault-'));
}

function writeCred(file: string, account: string): void {
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: `tok-${account}` } }), 'utf8');
}

describe('isUsableCredential', () => {
  it('accepts a non-empty JSON object and rejects empty, garbage, or missing', () => {
    const d = dir();
    const good = path.join(d, 'good.json');
    writeCred(good, 'a');
    expect(isUsableCredential(good)).toBe(true);

    const empty = path.join(d, 'empty.json');
    writeFileSync(empty, '   ', 'utf8');
    expect(isUsableCredential(empty)).toBe(false);

    const partial = path.join(d, 'partial.json');
    writeFileSync(partial, '{"claudeAiOauth":', 'utf8'); // killed mid-write
    expect(isUsableCredential(partial)).toBe(false);

    const blank = path.join(d, 'blank.json');
    writeFileSync(blank, '{}', 'utf8');
    expect(isUsableCredential(blank)).toBe(false);

    expect(isUsableCredential(path.join(d, 'nope.json'))).toBe(false);
  });

  it('REJECTS a logged-out credential: right shape, empty tokens', () => {
    // Claude leaves exactly this behind when a session is logged out. Saving it
    // back over a stored account is what destroys a login.
    const d = dir();
    const loggedOut = path.join(d, 'out.json');
    writeFileSync(
      loggedOut,
      JSON.stringify({
        claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, scopes: [], subscriptionType: 'max' },
      }),
      'utf8',
    );
    expect(isUsableCredential(loggedOut)).toBe(false);
  });

  it('accepts an API-key credential and an unfamiliar shape that carries content', () => {
    const d = dir();
    const apiKey = path.join(d, 'api.json');
    writeFileSync(apiKey, JSON.stringify({ primaryApiKey: 'sk-ant-abc123' }), 'utf8');
    expect(isUsableCredential(apiKey)).toBe(true);

    // Forward compatibility: a future format must not be refused wholesale.
    const future = path.join(d, 'future.json');
    writeFileSync(future, JSON.stringify({ somethingNew: { token: 'abc' } }), 'utf8');
    expect(isUsableCredential(future)).toBe(true);
  });
});

describe('installCredential (logged-out protection)', () => {
  it('refuses to overwrite a good login with a logged-out credential', () => {
    const d = dir();
    writeCred(credentialPath(d), 'good');
    const loggedOut = path.join(dir(), 'out.json');
    writeFileSync(loggedOut, JSON.stringify({ claudeAiOauth: { accessToken: '' } }), 'utf8');

    expect(installCredential(d, loggedOut)).toBe(false);
    expect(readFileSync(credentialPath(d), 'utf8')).toContain('tok-good');
  });
});

describe('installCredential', () => {
  it('installs and keeps the previous generation as a rollback cushion', () => {
    const d = dir();
    writeCred(credentialPath(d), 'old');
    const incoming = path.join(dir(), 'new.json');
    writeCred(incoming, 'new');

    expect(installCredential(d, incoming)).toBe(true);
    expect(readFileSync(credentialPath(d), 'utf8')).toContain('tok-new');
    expect(readFileSync(previousCredentialPath(d), 'utf8')).toContain('tok-old');
  });

  it('REFUSES to overwrite a good login with a corrupt credential', () => {
    const d = dir();
    writeCred(credentialPath(d), 'good');
    const corrupt = path.join(dir(), 'corrupt.json');
    writeFileSync(corrupt, '', 'utf8'); // a killed refresh left nothing

    expect(installCredential(d, corrupt)).toBe(false);
    expect(readFileSync(credentialPath(d), 'utf8')).toContain('tok-good'); // untouched
  });

  it('installs into a fresh dir with no previous generation', () => {
    const d = dir();
    const incoming = path.join(dir(), 'new.json');
    writeCred(incoming, 'first');
    expect(installCredential(d, incoming)).toBe(true);
    expect(existsSync(previousCredentialPath(d))).toBe(false);
  });
});

describe('rollbackCredential', () => {
  it('restores the previous generation after a bad swap', () => {
    const d = dir();
    writeCred(credentialPath(d), 'original');
    const incoming = path.join(dir(), 'new.json');
    writeCred(incoming, 'replacement');
    installCredential(d, incoming);
    expect(readFileSync(credentialPath(d), 'utf8')).toContain('tok-replacement');

    expect(rollbackCredential(d)).toBe(true);
    expect(readFileSync(credentialPath(d), 'utf8')).toContain('tok-original');
  });

  it('reports false when there is nothing to roll back to', () => {
    expect(rollbackCredential(dir())).toBe(false);
  });
});

describe('identityKey', () => {
  it('fingerprints the account identity and detects a different account', () => {
    const a = dir();
    const b = dir();
    writeFileSync(
      path.join(a, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'u1', emailAddress: 'one@x.com' } }),
      'utf8',
    );
    writeFileSync(
      path.join(b, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'u2', emailAddress: 'two@x.com' } }),
      'utf8',
    );
    expect(identityKey(a)).toBe('u1|one@x.com');
    expect(identityKey(a)).not.toBe(identityKey(b));
  });

  it('is null without an identity, and never throws on junk', () => {
    const d = dir();
    expect(identityKey(d)).toBeNull(); // no .claude.json
    writeFileSync(path.join(d, '.claude.json'), 'not json', 'utf8');
    expect(identityKey(d)).toBeNull();
  });
});

describe('clearCredential', () => {
  it('removes the live credential and tolerates it already being gone', () => {
    const d = dir();
    writeCred(credentialPath(d), 'x');
    clearCredential(d);
    expect(existsSync(credentialPath(d))).toBe(false);
    expect(() => clearCredential(d)).not.toThrow();
  });
});

describe('keepForRollback', () => {
  it('makes the login a sign-in is about to replace the one a refusal puts back', () => {
    // The backup otherwise holds whatever a renewal last retired, which the
    // server has invalidated: "putting it back" left a dead login.
    const d = dir();
    writeCred(credentialPath(d), 'working');
    writeCred(previousCredentialPath(d), 'spent-by-last-renewal');

    keepForRollback(d);
    writeCred(credentialPath(d), 'wrong-account'); // what the sign-in wrote
    expect(rollbackCredential(d)).toBe(true);

    expect(readFileSync(credentialPath(d), 'utf8')).toContain('tok-working');
  });

  it('leaves nothing to put back when there was no login before the sign-in', () => {
    const d = dir();
    writeCred(previousCredentialPath(d), 'spent-by-last-renewal');

    keepForRollback(d);
    writeCred(credentialPath(d), 'wrong-account');

    expect(rollbackCredential(d)).toBe(false);
    expect(existsSync(previousCredentialPath(d))).toBe(false);
  });
});

describe('nudgeLoginReread', () => {
  it("changes the login file's time and nothing in it", () => {
    // Claude drops the login it holds early only when this file's time changes.
    const d = dir();
    const file = path.join(d, '.credentials.json');
    writeCred(file, 'a');
    const before = readFileSync(file);
    utimesSync(file, new Date(1_000_000), new Date(1_000_000));

    nudgeLoginReread(d, new Date(2_000_000));
    expect(statSync(file).mtimeMs).toBe(2_000_000);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('creates nothing when there is no login at all', () => {
    const d = dir();
    const none = { keychainHolds: () => false };
    expect(nudgeLoginReread(d, new Date(), none)).toBe(true);
    expect(existsSync(path.join(d, '.credentials.json'))).toBe(false);
    expect(nudgeLoginReread(path.join(d, 'no-such-folder'), new Date(), none)).toBe(true);
  });

  it('makes the file appear, holding no login, when the login is in the Keychain and the file is gone', () => {
    // Measured on macOS: once Claude saves the login to the Keychain the file goes,
    // and a session moved then goes on as the account it left.
    const d = dir();
    const file = path.join(d, '.credentials.json');
    expect(nudgeLoginReread(d, new Date(), { keychainHolds: () => true })).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(REREAD_PLACEHOLDER);
    expect(JSON.parse(REREAD_PLACEHOLDER)).toEqual({});
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('moves the time on every nudge after that, and never writes over the file', () => {
    const d = dir();
    const file = path.join(d, '.credentials.json');
    const keychain = { keychainHolds: () => true };
    nudgeLoginReread(d, new Date(1_000_000), keychain);
    nudgeLoginReread(d, new Date(5_000_000), keychain);
    expect(statSync(file).mtimeMs).toBe(5_000_000);
    nudgeLoginReread(d, new Date(9_000_000), keychain);
    expect(statSync(file).mtimeMs).toBe(9_000_000);
    expect(readFileSync(file, 'utf8')).toBe(REREAD_PLACEHOLDER);
  });

  it('says so, without throwing, when the time cannot be changed', () => {
    const d = dir();
    const blocked = path.join(d, 'a-file-not-a-folder');
    writeFileSync(blocked, 'x', 'utf8');
    expect(nudgeLoginReread(blocked, new Date(), { keychainHolds: () => true })).toBe(false);
    expect(
      nudgeLoginReread(d, new Date(), {
        keychainHolds: () => {
          throw new Error('locked');
        },
      }),
    ).toBe(false);
  });
});

/** A login with sign-ins to MCP servers beside it, as Claude keeps them in one text. */
const mcp = (n: number) => ({
  'notion|1': { accessToken: `mcp-access-fake-${n}`, refreshToken: `mcp-refresh-fake-${n}` },
});
/** Sign-ins to a second server, so a merge per server can be told from one that replaces the lot. */
const datadog = (n: number) => ({
  'datadog|2': { accessToken: `dd-access-fake-${n}`, refreshToken: `dd-refresh-fake-${n}` },
});
const loginText = (token: string, mcpOAuth?: unknown): string =>
  JSON.stringify({
    claudeAiOauth: { accessToken: `tok-${token}`, refreshToken: `ref-${token}`, expiresAt: 1 },
    ...(mcpOAuth === undefined ? {} : { mcpOAuth }),
  });

describe('whether a text is a login when it holds MCP logins', () => {
  it('is not one when MCP logins are all it holds', () => {
    expect(usableLoginText(JSON.stringify({ mcpOAuth: mcp(1) }))).toBe(false);
    expect(usableLoginText(JSON.stringify({ mcpOAuth: {} }))).toBe(false);
    const d = dir();
    const onlyMcp = path.join(d, 'only-mcp.json');
    writeFileSync(onlyMcp, JSON.stringify({ mcpOAuth: mcp(1) }), 'utf8');
    expect(isUsableCredential(onlyMcp)).toBe(false);
  });

  it('is one when it holds a login of any known or unfamiliar kind beside them', () => {
    expect(usableLoginText(loginText('a', mcp(1)))).toBe(true);
    expect(
      usableLoginText(JSON.stringify({ primaryApiKey: 'sk-ant-abc123', mcpOAuth: mcp(1) })),
    ).toBe(true);
    expect(
      usableLoginText(JSON.stringify({ somethingNew: { token: 'abc' }, mcpOAuth: mcp(1) })),
    ).toBe(true);
  });

  it('is not one when the Claude login in it is signed out, whatever MCP logins it holds', () => {
    expect(
      usableLoginText(JSON.stringify({ claudeAiOauth: { accessToken: '' }, mcpOAuth: mcp(1) })),
    ).toBe(false);
  });

  it("is never installed as an account's login, nor written over one", () => {
    const d = dir();
    writeFileSync(credentialPath(d), loginText('old', mcp(1)), 'utf8');
    const incoming = path.join(dir(), 'only-mcp.json');
    writeFileSync(incoming, JSON.stringify({ mcpOAuth: mcp(2) }), 'utf8');

    expect(installCredential(d, incoming)).toBe(false);

    expect(readFileSync(credentialPath(d), 'utf8')).toBe(loginText('old', mcp(1)));
  });
});

const mcpIn = (file: string): unknown =>
  (JSON.parse(readFileSync(file, 'utf8')) as { mcpOAuth?: unknown }).mcpOAuth;

describe('installCredential and the MCP logins in the stores', () => {
  function pair(target: string | null, source: string): { d: string; incoming: string } {
    const d = dir();
    if (target !== null) writeFileSync(credentialPath(d), target, 'utf8');
    const incoming = path.join(dir(), 'incoming.json');
    writeFileSync(incoming, source, 'utf8');
    return { d, incoming };
  }

  it("keeps the target's own MCP logins and copies none of the source's, as a live store's login is saved into an account", () => {
    const { d, incoming } = pair(loginText('old', mcp(1)), loginText('new', mcp(2)));

    expect(installCredential(d, incoming)).toBe(true);

    expect(readFileSync(credentialPath(d), 'utf8')).toBe(loginText('new', mcp(1)));
    // The cushion is the login as it was, MCP logins and all.
    expect(readFileSync(previousCredentialPath(d), 'utf8')).toBe(loginText('old', mcp(1)));
  });

  it('gives a target with none no MCP logins either', () => {
    const { d, incoming } = pair(loginText('old'), loginText('new', mcp(2)));

    expect(installCredential(d, incoming)).toBe(true);

    expect(readFileSync(credentialPath(d), 'utf8')).toBe(loginText('new'));
  });

  it('keeps the MCP logins of a target that holds no Claude login, such as one signed out', () => {
    const signedOut = JSON.stringify({
      claudeAiOauth: { accessToken: '', refreshToken: '' },
      mcpOAuth: mcp(1),
    });
    const { d, incoming } = pair(signedOut, loginText('new', mcp(2)));

    expect(installCredential(d, incoming)).toBe(true);

    expect(readFileSync(credentialPath(d), 'utf8')).toBe(loginText('new', mcp(1)));
  });

  it('writes the source exactly as it is when neither holds any', () => {
    const source = `${JSON.stringify(JSON.parse(loginText('new')), null, 2)}\n`;
    const { d, incoming } = pair(loginText('old'), source);

    expect(installCredential(d, incoming)).toBe(true);
    expect(readFileSync(credentialPath(d), 'utf8')).toBe(source);

    const fresh = pair(null, source);
    expect(installCredential(fresh.d, fresh.incoming)).toBe(true);
    expect(readFileSync(credentialPath(fresh.d), 'utf8')).toBe(source);
  });

  it("joins an ending store's MCP logins to the account's server by server, as it parks them", () => {
    const { d, incoming } = pair(loginText('old', mcp(1)), loginText('new', datadog(2)));

    expect(installCredential(d, incoming, { mcp: 'park' })).toBe(true);

    expect(mcpIn(credentialPath(d))).toEqual({ ...mcp(1), ...datadog(2) });
  });

  it("parks nothing for an empty set, and leaves the account's MCP logins as they are", () => {
    const { d, incoming } = pair(loginText('old', mcp(1)), loginText('new', {}));

    expect(installCredential(d, incoming, { mcp: 'park' })).toBe(true);

    expect(readFileSync(credentialPath(d), 'utf8')).toBe(loginText('new', mcp(1)));
  });

  it("leaves the account's MCP logins parked when the ending store holds none", () => {
    const { d, incoming } = pair(loginText('old', mcp(1)), loginText('new'));

    expect(installCredential(d, incoming, { mcp: 'park' })).toBe(true);

    expect(readFileSync(credentialPath(d), 'utf8')).toBe(loginText('new', mcp(1)));
  });

  it('merges with the login the target holds when it is written, not as it was when first looked at', () => {
    const d = dir();
    const held = loginText('old', mcp(1));
    const refreshed = loginText('old', mcp(2));
    const items = new Map<string, string>([[d, held]]);
    const io: KeychainIo = {
      read: (item) => {
        // The target's Claude saves a refreshed MCP sign-in once ccx has kept its cushion.
        if (existsSync(previousCredentialPath(d)) && items.get(item) === held)
          items.set(item, refreshed);
        return items.get(item) ?? null;
      },
      write: (item, text) => {
        items.set(item, text);
      },
      remove: (item) => {
        items.delete(item);
      },
    };
    const incoming = path.join(dir(), 'new.json');
    writeFileSync(incoming, loginText('new', mcp(9)), 'utf8');

    expect(runBlocking(installCredentialSteps(d, incoming, io, { mcp: 'folder' }))).toBe(true);

    expect(items.get(d)).toBe(loginText('new', mcp(2)));
  });

  it("writes the whole source over the account's, MCP logins and all, as a store that is ending parks them", () => {
    const { d, incoming } = pair(loginText('old', mcp(1)), loginText('new', mcp(2)));

    expect(installCredential(d, incoming, { mcp: 'park' })).toBe(true);

    expect(readFileSync(credentialPath(d), 'utf8')).toBe(loginText('new', mcp(2)));
  });

  it('starts a folder that holds no login from the source whole, and keeps the own MCP logins of one that has a login', () => {
    const fresh = pair(null, loginText('new', mcp(2)));
    expect(installCredential(fresh.d, fresh.incoming, { mcp: 'folder' })).toBe(true);
    expect(mcpIn(credentialPath(fresh.d))).toEqual(mcp(2));

    const placeholder = pair(REREAD_PLACEHOLDER, loginText('new', mcp(2)));
    expect(installCredential(placeholder.d, placeholder.incoming, { mcp: 'folder' })).toBe(true);
    expect(mcpIn(credentialPath(placeholder.d))).toEqual(mcp(2));

    const live = pair(loginText('old', mcp(1)), loginText('new', mcp(2)));
    expect(installCredential(live.d, live.incoming, { mcp: 'folder' })).toBe(true);
    expect(mcpIn(credentialPath(live.d))).toEqual(mcp(1));
  });
});
