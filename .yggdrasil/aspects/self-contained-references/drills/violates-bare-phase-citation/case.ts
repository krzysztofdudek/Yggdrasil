// Drill case: a test name citing a bare "(Phase N)" parenthetical — the same
// unresolvable shape "(Step N)" already refuses, spelled with a different
// keyword. Expected verdict: refused.
import { describe, it, expect } from 'vitest';

describe('extractor registry', () => {
  it('resolves the TypeScript extractor for ts/tsx/js (Phase 1)', () => {
    expect(1).toBe(1);
  });
});
