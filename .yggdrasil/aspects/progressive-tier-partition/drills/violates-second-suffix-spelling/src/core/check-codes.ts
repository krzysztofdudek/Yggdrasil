// Drill fixture: the '-outside' suffix is spelled a second time outside
// outsideTwin() — the check must refuse this.
export function outsideTwin(code: string): string {
  return `${code}-outside`;
}

export const REDUNDANT_SUFFIX = '-outside';
