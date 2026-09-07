// The contract behind the `charge` port: what a consumer of it may rely on.
// It sits outside the provider's own mapping on purpose — a contract test is
// usually owned by neither side of the port.
import { describe, it, expect } from 'vitest';
import { charge } from '../../src/services/payments.js';

describe('charge — the payments contract', () => {
  it('captures a positive amount', () => {
    expect(charge(100)).toBe(true);
  });

  it('refuses a non-positive amount', () => {
    expect(charge(0)).toBe(false);
  });
});
