// Drill fixture: a STRUCTURAL_CODES member enters SCOPED_CODES with no
// rationale bullet documenting it anywhere — the check must refuse this.
export const STRUCTURAL_CODES = new Set<string>(['sneaky-code']);

export const SCOPED_CODES = new Set<string>(['unverified', 'sneaky-code']);
