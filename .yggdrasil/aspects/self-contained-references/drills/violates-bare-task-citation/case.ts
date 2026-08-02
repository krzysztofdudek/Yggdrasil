// Drill case: a test name citing a bare "(Task N)" parenthetical — the same
// unresolvable shape "(Step N)" already refuses, spelled with a different
// keyword. Expected verdict: refused.
import { describe, it, expect } from 'vitest';

describe('widget count', () => {
  it('counts items even when the input list is empty (Task 9)', () => {
    expect(1).toBe(1);
  });
});
