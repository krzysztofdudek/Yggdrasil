// DRILL — expected verdict: SATISFIED (No violations).
// A file that does ordinary path work and never touches glob matching at all —
// no 'minimatch' import, so nothing for the rule to flag.
import path from 'node:path';

export function joinPaths(a: string, b: string): string {
  return path.join(a, b);
}
