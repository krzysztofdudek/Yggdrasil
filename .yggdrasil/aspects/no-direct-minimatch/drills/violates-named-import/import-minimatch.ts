// DRILL — expected verdict: REFUSED (1 violation).
// A named import straight from the 'minimatch' package. Every glob match must
// route through the canonical glob helper instead, so this must trip the rule.
import { minimatch } from 'minimatch';

export function isMatch(pattern: string, file: string): boolean {
  return minimatch(file, pattern);
}
