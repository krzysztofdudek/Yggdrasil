// Namespace laundering: a bare `import * as ns` is legitimate, but a reference to
// ns.isBetterMappingOwner resolves specifically to the fenced comparator. MUST refuse.
import * as mappingPath from '../utils/mapping-path.js';

export function choose(candidate, incumbent) {
  return mappingPath.isBetterMappingOwner(candidate, incumbent) ? candidate : incumbent;
}
