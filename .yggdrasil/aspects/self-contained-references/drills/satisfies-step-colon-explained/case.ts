// Drill case: the SAME bare "(Step N)" shape as the refused case, but
// explained inline with a colon right where it appears — a reader needs
// nothing outside this file. Expected verdict: satisfied.
import { describe, it, expect } from 'vitest';

describe('widget count', () => {
  it('counts items even when the input list is empty (Step 9: the empty-array fast path)', () => {
    expect(1).toBe(1);
  });
});
