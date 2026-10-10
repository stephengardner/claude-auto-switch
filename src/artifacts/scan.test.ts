import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claimTurn, turnOf, writePlan } from './scan.js';

function scanDir(accounts: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-scan-'));
  writePlan(dir, accounts);
  return dir;
}

describe('giving each list call its account', () => {
  it('gives calls the accounts in order, and says when none is left', async () => {
    const dir = scanDir(['work', 'home']);
    expect(await claimTurn(dir, 'toolu_a')).toEqual({ index: 0, account: 'work' });
    expect(await claimTurn(dir, 'toolu_b')).toEqual({ index: 1, account: 'home' });
    expect(await claimTurn(dir, 'toolu_c')).toBe('none-left');
  });

  it('gives a call the turn it already has, however often its hook runs', async () => {
    const dir = scanDir(['work', 'home']);
    await claimTurn(dir, 'toolu_a');
    expect(await claimTurn(dir, 'toolu_a')).toEqual({ index: 0, account: 'work' });
    expect(await claimTurn(dir, 'toolu_b')).toEqual({ index: 1, account: 'home' });
  });

  it('waits for another run of the hook for the same call, rather than taking a second account for it', async () => {
    const dir = scanDir(['work', 'home']);
    // That other run holds the call's claim and has taken turn 0, and has not yet said so.
    writeFileSync(path.join(dir, 'claim-toolu_a'), '', 'utf8');
    writeFileSync(path.join(dir, 'turn-0'), 'toolu_a', 'utf8');
    setTimeout(() => {
      writeFileSync(path.join(dir, 'call-toolu_a.json'), JSON.stringify({ index: 0, account: 'work' }), 'utf8');
    }, 60);
    expect(await claimTurn(dir, 'toolu_a', { waitMs: 2_000, pollMs: 10 })).toEqual({ index: 0, account: 'work' });
    // The second account is still there for the next call.
    expect(await claimTurn(dir, 'toolu_b')).toEqual({ index: 1, account: 'home' });
  });

  it('says it got no answer when the other run never says which turn it took', async () => {
    const dir = scanDir(['work']);
    writeFileSync(path.join(dir, 'claim-toolu_a'), '', 'utf8');
    expect(await claimTurn(dir, 'toolu_a', { waitMs: 50, pollMs: 10 })).toBe('no-answer');
    expect(turnOf(dir, 'toolu_a')).toBeNull();
  });
});
