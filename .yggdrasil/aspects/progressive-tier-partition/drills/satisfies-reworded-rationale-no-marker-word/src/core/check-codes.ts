// Drill fixture: the rationale prose is reworded to avoid the literal words
// "carve-out"/"carveout" entirely, while still giving the code its own named
// bullet ("- carved-code — ..."). A copyedit that preserves the bullet shape
// must never flip an already-documented exception into a refusal — the check
// must pass.
export const STRUCTURAL_CODES = new Set<string>(['carved-code']);

/**
 * Admitted exceptions to the general blocking rule, one at a time:
 *   - carved-code — this specific finding is a code-versus-graph drift, not
 *     a graph-authoring mistake, so it stays eligible for downgrade despite
 *     also being a hard block today.
 */
export const SCOPED_CODES = new Set<string>(['plain-code', 'carved-code']);
