// Drill fixture: the '-outside' suffix is mentioned only inside a COMMENT,
// never a second time in code — the near-miss of
// violates-second-suffix-spelling. Must pass: comments are never scanned.
export function outsideTwin(code: string): string {
  return `${code}-outside`;
}

// This helper's suffix is spelled '-outside' only above — see outsideTwin.
export const NOTE = 'informational only';
