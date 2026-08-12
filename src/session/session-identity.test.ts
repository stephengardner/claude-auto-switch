import { describe, it, expect } from 'vitest';
import { resolveSessionIdentity, type RegisteredAccount } from './session-identity.js';

function account(name: string, email?: string): RegisteredAccount {
  return { name, dir: `/profiles/${name}`, ...(email ? { email } : {}) };
}

const main = account('main', 'stephen@shopsheriff.com');
const contactss = account('contactss', 'contactshopsheriff@gmail.com');
const nameless = account('nameless');

function resolve(
  sessionEmail: string | null,
  believed: RegisteredAccount | null,
  accounts: RegisteredAccount[] = [main, contactss, nameless],
) {
  return resolveSessionIdentity(
    { sessionDir: '/sessions/123', believed, accounts },
    { readEmail: () => sessionEmail },
  );
}

describe('who a session actually is', () => {
  it('reports a mismatch when the session is signed in as somebody else', () => {
    // The production deadlock. The session ran as contactss while ccx believed
    // main; contactss's limit banner was on screen, main answered "not capped",
    // and the switch never happened. The mismatch has to be a first-class
    // answer, not something each call site rediscovers.
    const id = resolve('contactshopsheriff@gmail.com', main);
    expect(id.mismatch).toBe(true);
    expect(id.actual?.name).toBe('contactss');
    expect(id.believed?.name).toBe('main');
  });

  it('matches case-insensitively and ignores stray whitespace', () => {
    const id = resolve('Stephen@ShopSheriff.com', main);
    expect(id.mismatch).toBe(false);
    expect(id.actual?.name).toBe('main');
  });

  it('never accuses on an unrecorded session identity', () => {
    // Unknown is not evidence. Guessing a mismatch takes healthy accounts out
    // of rotation on someone else's limit, which is the expensive direction.
    const id = resolve(null, main);
    expect(id.mismatch).toBe(false);
    expect(id.actual).toBeNull();
  });

  it('never accuses when nothing is believed', () => {
    const id = resolve('contactshopsheriff@gmail.com', null);
    expect(id.mismatch).toBe(false);
    expect(id.actual?.name).toBe('contactss');
  });

  it('uses the resolved account when the believed one has no recorded address', () => {
    // The believed profile predates registration emails. The session resolving
    // to a DIFFERENT registered account is still positive evidence.
    const id = resolve('contactshopsheriff@gmail.com', nameless);
    expect(id.mismatch).toBe(true);
  });

  it('stays quiet when the believed account has no address and nothing resolves', () => {
    const id = resolve('personal@gmail.com', nameless);
    expect(id.mismatch).toBe(false);
    expect(id.actual).toBeNull();
  });

  it('reports an identity that resolves to NO registered account', () => {
    // A /login into a personal account nobody registered: the email is known,
    // the actual account is null, and the mismatch against a believed account
    // with a recorded address is real.
    const id = resolve('personal@gmail.com', main);
    expect(id.mismatch).toBe(true);
    expect(id.actual).toBeNull();
    expect(id.email).toBe('personal@gmail.com');
  });
});
