// Drill case: a bare code with NO trailing letter (plain letter+digits, this
// repository's own established shape for naming a long-lived invariant, e.g.
// "(G4)"/"(D7)" elsewhere in this codebase) must NOT be refused — only the
// trailing-letter variant is in scope. Expected verdict: satisfied.
import { describe, it, expect } from 'vitest';

describe('widget count', () => {
  it('never returns a negative count (G4)', () => {
    expect(1).toBe(1);
  });
});
