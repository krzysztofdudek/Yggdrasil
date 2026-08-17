// Drill fixture: SCOPED_CODES overlaps APPROVE_GATING_CODES — a fill-abort
// reason can never be a downgrade candidate. The check must refuse this.
export const SCOPED_CODES = new Set<string>(['overlap-code']);

export const APPROVE_GATING_CODES = new Set<string>(['overlap-code']);
