// Drill case: a lowercase "(step N ...)" citation in a test name — the real
// shape this repository's own allowedreads.test.ts uses, numbering the
// "step 1".."step 4" legend its own file-header doc comment defines and
// explains right there. Capital-"S" "Step" is this check's target
// specifically because it never collides with this established, already-
// self-contained lowercase convention. Expected verdict: satisfied.
import { describe, it, expect } from 'vitest';

describe('widget count', () => {
  it('tolerates a descendant child with no mapping (step 4 undefined branch)', () => {
    expect(1).toBe(1);
  });
});
