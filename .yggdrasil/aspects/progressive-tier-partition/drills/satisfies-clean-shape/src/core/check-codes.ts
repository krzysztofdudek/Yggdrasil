// Drill fixture: a synthetic but complete replica of the real file's shape —
// a documented carve-out, no gating overlap, a properly derived OUTSIDE_CODES,
// and no stray suffix spelling. The check must find nothing to refuse.
export const STRUCTURAL_CODES = new Set<string>(['carved-code', 'always-blocks']);

export const APPROVE_GATING_CODES = new Set<string>(['config-broken']);

export const SCOPED_CODES = new Set<string>([
  // Pair-verdict codes.
  'unverified',
  // Carve-outs from STRUCTURAL_CODES — documented exception.
  'carved-code',
]);

export function outsideTwin(code: string): string {
  return `${code}-outside`;
}

export const OUTSIDE_CODES = new Set<string>(Array.from(SCOPED_CODES, outsideTwin));
