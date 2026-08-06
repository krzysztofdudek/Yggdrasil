// Drill case: a test name citing a bare, trailing-letter reference code with
// no explanation a reader can resolve from this repository. Expected
// verdict: refused.
import { describe, it, expect } from 'vitest';

describe('widget count', () => {
  it('counts items even when the input list is empty (I9z)', () => {
    expect(1).toBe(1);
  });
});
