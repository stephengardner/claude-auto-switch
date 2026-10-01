import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { desktopAccount, desktopAccountId, desktopConfigPath, accountIdOf } from './desktop-app.js';

const STEPHEN = '1b0125dc-730c-4d80-90da-af791d8f2b05';

function account(root: string, name: string, accountUuid?: string): { name: string; dir: string } {
  const dir = path.join(root, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  if (accountUuid)
    writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid } }),
    );
  return { name, dir };
}

describe('which account Claude Desktop is signed into', () => {
  it('finds Desktop settings where each platform keeps them', () => {
    expect(
      desktopConfigPath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } }),
    ).toBe(path.join('C:\\Users\\me\\AppData\\Roaming', 'Claude', 'config.json'));
    expect(desktopConfigPath({ platform: 'darwin', env: { HOME: '/Users/me' } })).toBe(
      path.join('/Users/me', 'Library', 'Application Support', 'Claude', 'config.json'),
    );
    expect(desktopConfigPath({ platform: 'linux', env: { HOME: '/home/me' } })).toBe(
      path.join('/home/me', '.config', 'Claude', 'config.json'),
    );
  });

  it('matches the account Desktop notes against each ccx account folder', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cas-desk-app-'));
    const appData = path.join(root, 'AppData');
    mkdirSync(path.join(appData, 'Claude'), { recursive: true });
    // The shape Desktop writes, trimmed: the id sits beside plenty else.
    writeFileSync(
      path.join(appData, 'Claude', 'config.json'),
      JSON.stringify({
        locale: 'en-US',
        lastKnownAccountUuid: STEPHEN,
        'oauth:tokenCacheV2': 'opaque',
      }),
    );
    const ctx = { platform: 'win32' as const, env: { APPDATA: appData, USERPROFILE: root } };
    const accounts = [
      account(root, 'osa', '029d0136-3523-49fc-a8b9-d4b399f342fb'),
      account(root, 'stephen', STEPHEN),
    ];
    expect(desktopAccountId(ctx)).toBe(STEPHEN);
    expect(desktopAccount(accounts, ctx)).toBe('stephen');
    expect(accountIdOf(accounts[0]!.dir)).toBe('029d0136-3523-49fc-a8b9-d4b399f342fb');
  });

  it('is nobody when Desktop is not installed, or signed in as an account ccx does not have', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cas-desk-app-none-'));
    const ctx = {
      platform: 'win32' as const,
      env: { APPDATA: path.join(root, 'nope'), USERPROFILE: root },
    };
    expect(desktopAccount([account(root, 'osa', 'x')], ctx)).toBeNull();
    expect(desktopAccount([account(root, 'osa', 'x')], ctx, STEPHEN)).toBeNull();
  });
});
