// Drill fixture: OUTSIDE_CODES hand-listed as a literal array instead of
// derived from SCOPED_CODES via outsideTwin. The check must refuse this.
export const OUTSIDE_CODES = new Set<string>(['unverified-outside']);
