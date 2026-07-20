// Binding-specific: importing a DIFFERENT symbol from mapping-path (here the
// dual-use membership predicate) is legitimate and MUST pass.
import { mappingEntryMatchesFile } from '../utils/mapping-path.js';

export function covers(entry, file) {
  return mappingEntryMatchesFile(entry, file);
}
