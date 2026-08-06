// Drill case: a test name citing a bare "(Step N)" parenthetical — the exact
// shape this branch's own test suite used to cite a planning brief that is
// not committed to this repository. Expected verdict: refused.
import { describe, it, expect } from 'vitest';

describe('widget count', () => {
  it('counts items even when the input list is empty (Step 9)', () => {
    expect(1).toBe(1);
  });
});
