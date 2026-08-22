import { describe, it, expect } from 'vitest';
import { createCapOutcome } from './cap-outcome.js';

/**
 * One rule, stated once: a confirmation beats a hold, a hold never displaces a
 * confirmation. Five reviews of one pull request each found a different writer
 * that got this wrong on its own.
 */
describe('which limit answer wins', () => {
  it('reports nothing when no limit ended the session', () => {
    const outcome = createCapOutcome();
    expect(outcome.get()).toBeNull();
    expect(outcome.isSet()).toBe(false);
    expect(outcome.isConfirmed()).toBe(false);
  });

  it('lets a confirmation replace a hold that got there first', () => {
    // The production failure: the hold is raised while a probe is still in
    // flight, the probe then confirms, and the confirmed window is discarded.
    // The pairing returns to rotation minutes before its real window reopens.
    const outcome = createCapOutcome();
    outcome.hold({ reason: 'nothing explains this', resetAt: 1_000 });
    outcome.confirm({ reason: 'weekly window spent', resetAt: 999_000 });
    expect(outcome.get()).toEqual({ reason: 'weekly window spent', resetAt: 999_000 });
    expect(outcome.isConfirmed()).toBe(true);
  });

  it('never lets a hold displace a confirmation', () => {
    const outcome = createCapOutcome();
    outcome.confirm({ reason: 'weekly window spent', resetAt: 999_000 });
    outcome.hold({ reason: 'nothing explains this', resetAt: 1_000 });
    expect(outcome.get()).toEqual({ reason: 'weekly window spent', resetAt: 999_000 });
    expect(outcome.isConfirmed()).toBe(true);
  });

  it('keeps the FIRST hold, so one wall is not re-held on every render', () => {
    const outcome = createCapOutcome();
    outcome.hold({ reason: 'first', resetAt: 1 });
    outcome.hold({ reason: 'second', resetAt: 2 });
    expect(outcome.get()).toEqual({ reason: 'first', resetAt: 1 });
    expect(outcome.isConfirmed()).toBe(false);
  });

  it('takes the latest confirmation, since a later one measured more recently', () => {
    const outcome = createCapOutcome();
    outcome.confirm({ reason: 'five-hour spent', resetAt: 10 });
    outcome.confirm({ reason: 'weekly spent', resetAt: 20 });
    expect(outcome.get()).toEqual({ reason: 'weekly spent', resetAt: 20 });
  });

  it('distinguishes held from confirmed, which is what callers need to wait on', () => {
    const held = createCapOutcome();
    held.hold({ reason: 'nothing explains this' });
    expect(held.isSet()).toBe(true);
    expect(held.isConfirmed()).toBe(false);
  });
});
