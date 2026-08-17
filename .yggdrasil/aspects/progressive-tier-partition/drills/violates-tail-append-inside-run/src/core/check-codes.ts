// Drill fixture: the tail-append bypass. A legitimately documented carve-out
// ('carved-code', with its own rationale bullet) sits in SCOPED_CODES right
// next to a SECOND structural code ('sneaky-tail-code') that was appended
// after it with no bullet of its own — only proximity to the in-array
// "Carve-outs..." comment and to carved-code's entry. Placement must not
// grant a free pass: the check must refuse 'sneaky-tail-code' even though it
// sits inside what looks like the same documented run.
export const STRUCTURAL_CODES = new Set<string>(['carved-code', 'sneaky-tail-code']);

/**
 * Carve-outs from STRUCTURAL_CODES:
 *   - carved-code — the one documented, legitimate exception.
 */
export const SCOPED_CODES = new Set<string>([
  'plain-code',
  // Carve-outs from STRUCTURAL_CODES — see rationale above.
  'carved-code',
  'sneaky-tail-code',
]);
