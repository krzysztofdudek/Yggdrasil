// DRILL — expected verdict: SATISFIED (No violations).
// The sanctioned pattern: glob matching goes through the single canonical glob
// engine (globMatch), never through a direct 'minimatch' import.
import { globMatch } from '../../../../../source/cli/src/utils/mapping-path.js';

export function isMatch(pattern: string, file: string): boolean {
  return globMatch(pattern, file);
}
