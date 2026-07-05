// DRILL — expected verdict: REFUSED (1 violation).
// A namespace import from 'minimatch'. The source module is what the rule keys
// on, so a `* as` form is just as forbidden as a named import.
import * as mm from 'minimatch';

export function isMatch(pattern: string, file: string): boolean {
  return mm.minimatch(file, pattern);
}
