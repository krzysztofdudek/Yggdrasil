// Drill fixture: a STRUCTURAL_CODES member has its OWN named rationale
// bullet in the doc comment above SCOPED_CODES — the near-miss of
// violates-undocumented-structural-carveout. Must pass.
export const STRUCTURAL_CODES = new Set<string>(['carved-code']);

/**
 * Carve-outs from STRUCTURAL_CODES:
 *   - carved-code — documented, legitimate exception.
 */
export const SCOPED_CODES = new Set<string>(['plain-code', 'carved-code']);
