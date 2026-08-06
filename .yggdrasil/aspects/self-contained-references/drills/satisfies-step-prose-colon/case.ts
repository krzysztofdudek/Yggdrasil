// Drill case: a colon-explained, UNPARENTHESIZED "Step N: ..." prefix in a
// describe name — the real shape this repository's advise.test.ts already
// uses ('yg advise — Step 1: sections, precedence, provenance (spawned)').
// The check's step pattern only matches the parenthetical "(Step N)" form,
// so a colon-explained prose prefix like this was never in scope and must
// not be refused. Expected verdict: satisfied.
import { describe, it, expect } from 'vitest';

describe('widget count — Step 1: totals items in the input list (spawned)', () => {
  it('counts items even when the input list is empty', () => {
    expect(1).toBe(1);
  });
});
