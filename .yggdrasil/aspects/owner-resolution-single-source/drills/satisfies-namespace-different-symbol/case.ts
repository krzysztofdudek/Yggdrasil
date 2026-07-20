// A namespace import that only ever references a DIFFERENT symbol must pass — the
// bare `import * as ns` is not itself a hit; only ns.isBetterMappingOwner would be.
import * as mappingPath from '../utils/mapping-path.js';

export function covers(entry, file) {
  return mappingPath.mappingEntryMatchesFile(entry, file);
}
