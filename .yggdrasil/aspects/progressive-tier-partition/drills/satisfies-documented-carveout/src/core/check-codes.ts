// Drill fixture: a STRUCTURAL_CODES member IS documented as a carve-out —
// the near-miss of violates-undocumented-structural-carveout. Must pass.
export const STRUCTURAL_CODES = new Set<string>(['carved-code']);

export const SCOPED_CODES = new Set<string>([
  'plain-code',
  // Carve-out from STRUCTURAL_CODES — documented exception.
  'carved-code',
]);
