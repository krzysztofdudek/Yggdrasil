// Drill fixture: a STRUCTURAL_CODES member enters SCOPED_CODES with no
// carve-out marker nearby — the check must refuse this.
export const STRUCTURAL_CODES = new Set<string>(['sneaky-code']);

export const SCOPED_CODES = new Set<string>([
  // Pair-verdict codes.
  'unverified',
  'sneaky-code',
]);
