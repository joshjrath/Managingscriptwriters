// Sign-in throttling (server/auth.ts). Its counters live in the module, so
// these run in their own file (vitest gives each file fresh modules).

import { describe, expect, it } from 'vitest';
import { checkThrottle, clearFailures, recordFailure } from '../server/auth';

const locked = (ip: string, account: string) => {
  try { checkThrottle(ip, account); return false; } catch { return true; }
};

describe('sign-in throttling', () => {
  it('locks an address after 8 wrong passwords for one account, and an account after 30 from anywhere', () => {
    for (let i = 0; i < 8; i++) recordFailure('10.0.0.1', 'a@x.test');
    expect(locked('10.0.0.1', 'a@x.test')).toBe(true);
    expect(locked('10.0.0.2', 'a@x.test')).toBe(false);

    // a forged address per guess dodges the per-address count, but not the account's
    for (let i = 0; i < 30; i++) recordFailure(`10.1.0.${i}`, 'b@x.test');
    expect(locked('10.9.9.9', 'b@x.test')).toBe(true);
    // signing in successfully forgives that address, not other people's guesses
    clearFailures('10.9.9.9', 'b@x.test');
    expect(locked('10.9.9.9', 'b@x.test')).toBe(true);
  });

  it('keeps a nearly locked account counted when a flood of other failures fills the table', () => {
    for (let i = 0; i < 29; i++) recordFailure(`10.2.0.${i % 200}`, 'admin@x.test');
    expect(locked('10.3.0.1', 'admin@x.test')).toBe(false);
    // thousands of one-off failures for made-up emails used to push the oldest counts out
    for (let i = 0; i < 6_000; i++) recordFailure(`10.4.${i >> 8}.${i & 255}`, `junk${i}@nowhere.test`);
    recordFailure('10.3.0.1', 'admin@x.test');
    expect(locked('10.3.0.2', 'admin@x.test')).toBe(true);
  });
});
