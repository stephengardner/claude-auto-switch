import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addAccount } from './registry.js';
import { setActive } from '../state/active.js';
import { setTarget } from '../daemon/junction.js';
import { purgeRefusal, removalStanding } from './removal.js';
import type { SessionLease } from '../session/lease.js';

function setup(names: string[] = ['work', 'spare']) {
  const home = mkdtempSync(path.join(tmpdir(), 'ccx-removal-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const dirOf = (name: string): string => path.join(home, 'profiles', name);
  for (const name of names) {
    mkdirSync(dirOf(name), { recursive: true });
    addAccount({ name, dir: dirOf(name) }, ctx);
  }
  const standing = (name: string, leases: SessionLease[] = []) =>
    removalStanding(name, {}, ctx, () => leases);
  return { home, ctx, dirOf, standing };
}

const lease = (pid: number, account: string, cwd: string, at = 1): SessionLease => ({
  pid,
  account,
  configDir: path.join('sessions', String(pid)),
  cwd,
  at,
});

describe('what removing an account would touch', () => {
  it('is nothing for an account that is not there', () => {
    expect(setup().standing('nobody')).toBeNull();
  });

  it('is its folder alone for an idle account nothing points at', () => {
    const { standing, dirOf } = setup();
    expect(standing('spare')).toEqual({
      name: 'spare',
      dir: dirOf('spare'),
      leases: [],
      active: false,
      last: false,
      editor: false,
      daemon: false,
      sharedWith: [],
      folderIsOurs: true,
    });
  });

  it('holds the sessions running on it, and none running elsewhere', () => {
    const { standing } = setup();
    const running = [
      lease(11, 'work', '/w/api'),
      lease(12, 'spare', '/w/web'),
      lease(13, 'work', '/w/cli'),
    ];
    expect(standing('work', running)?.leases.map((l) => l.pid)).toEqual([11, 13]);
  });

  it('still counts a session that is moving off it and has not let go yet', () => {
    // A moving session saves the old account's login back before it releases
    // that lease, so the folder is still in use until the lease is gone.
    const { standing } = setup();
    const moving = [lease(11, 'work', '/w/api', 1), lease(11, 'spare', '/w/api', 2)];
    expect(standing('work', moving)?.leases.map((l) => l.pid)).toEqual([11]);
  });

  it('knows the account new sessions start on', () => {
    const { standing, ctx } = setup();
    setActive('work', ctx);
    expect(standing('work')?.active).toBe(true);
    expect(standing('spare')?.active).toBe(false);
  });

  it('knows the last account', () => {
    expect(setup(['only']).standing('only')?.last).toBe(true);
    expect(setup().standing('work')?.last).toBe(false);
  });

  it('knows the account the editor points at', () => {
    const { standing, home, dirOf } = setup();
    setTarget(path.join(home, 'editor-active'), dirOf('work'));
    expect(standing('work')?.editor).toBe(true);
    expect(standing('spare')?.editor).toBe(false);
  });

  it("knows the account the daemon's link points at", () => {
    // `ccx daemon install` points every Claude outside ccx at this link.
    const { standing, home, dirOf } = setup();
    setTarget(path.join(home, 'active'), dirOf('work'));
    expect(standing('work')?.daemon).toBe(true);
    expect(standing('spare')?.daemon).toBe(false);
    expect(standing('work')?.editor).toBe(false);
  });

  it('knows the other accounts registered on the same folder', () => {
    // `ccx add <name> --dir` takes a folder another account already has.
    const { standing, ctx, dirOf } = setup();
    addAccount({ name: 'twin', dir: dirOf('work') }, ctx);
    expect(standing('twin')?.sharedWith).toEqual(['work']);
    expect(standing('work')?.sharedWith).toEqual(['twin']);
    expect(standing('spare')?.sharedWith).toEqual([]);
  });

  it('sees the editor on a shared folder from either account, since it is the folder that would go', () => {
    const { standing, ctx, home, dirOf } = setup();
    addAccount({ name: 'twin', dir: dirOf('work') }, ctx);
    setTarget(path.join(home, 'editor-active'), dirOf('work'));
    expect(standing('work')?.editor).toBe(true);
    expect(standing('twin')?.editor).toBe(true);
  });

  it('knows a folder outside the profiles tree is not one ccx deletes', () => {
    const { standing, home, ctx } = setup();
    const elsewhere = path.join(home, 'elsewhere');
    mkdirSync(elsewhere);
    addAccount({ name: 'custom', dir: elsewhere }, ctx);
    expect(standing('custom')?.folderIsOurs).toBe(false);
  });
});

describe('when an account folder may be deleted', () => {
  it('may be, with nothing using it', () => {
    expect(purgeRefusal(setup().standing('spare')!)).toBeNull();
  });

  it('may not be while a session is running on it, said by how many', () => {
    const { standing } = setup();
    expect(purgeRefusal(standing('work', [lease(11, 'work', '/w/api')])!)).toBe(
      'its folder cannot be deleted while 1 session is running on it',
    );
    expect(
      purgeRefusal(standing('work', [lease(11, 'work', '/w/api'), lease(12, 'work', '/w/web')])!),
    ).toBe('its folder cannot be deleted while 2 sessions are running on it');
  });

  it('counts a session once, however many leases it holds', () => {
    const { standing } = setup();
    const twice = [lease(11, 'work', '/w/api', 1), lease(11, 'work', '/w/api', 2)];
    expect(purgeRefusal(standing('work', twice)!)).toContain('1 session is running on it');
  });

  it('may not be while the editor is on it', () => {
    const { standing, home, dirOf } = setup();
    setTarget(path.join(home, 'editor-active'), dirOf('work'));
    expect(purgeRefusal(standing('work')!)).toBe(
      'its folder cannot be deleted while your editor is on it',
    );
  });

  it("may not be while the daemon's link is on it", () => {
    const { standing, home, dirOf } = setup();
    setTarget(path.join(home, 'active'), dirOf('work'));
    expect(purgeRefusal(standing('work')!)).toBe(
      "its folder cannot be deleted while the daemon's link is on it",
    );
  });

  it('may not be while another account is registered on it, whose login would go with it', () => {
    const { standing, ctx, dirOf } = setup();
    addAccount({ name: 'twin', dir: dirOf('work') }, ctx);
    expect(purgeRefusal(standing('twin')!)).toBe(
      'its folder cannot be deleted while "work" shares it',
    );
    addAccount({ name: 'triplet', dir: dirOf('work') }, ctx);
    expect(purgeRefusal(standing('work')!)).toBe(
      'its folder cannot be deleted while "twin" and "triplet" share it',
    );
  });

  it('names both when two are using it', () => {
    const { standing, home, dirOf } = setup();
    setTarget(path.join(home, 'editor-active'), dirOf('work'));
    expect(purgeRefusal(standing('work', [lease(11, 'work', '/w/api')])!)).toBe(
      'its folder cannot be deleted while 1 session is running on it and your editor is on it',
    );
  });

  it('names all three when all are using it', () => {
    const { standing, home, dirOf } = setup();
    setTarget(path.join(home, 'editor-active'), dirOf('work'));
    setTarget(path.join(home, 'active'), dirOf('work'));
    expect(purgeRefusal(standing('work', [lease(11, 'work', '/w/api')])!)).toBe(
      'its folder cannot be deleted while 1 session is running on it, your editor is on it ' +
        "and the daemon's link is on it",
    );
  });
});
