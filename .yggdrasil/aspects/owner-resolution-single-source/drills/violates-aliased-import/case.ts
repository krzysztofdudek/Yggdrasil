// Alias-proof: the comparator imported under a different local name still refuses,
// because the specifier is judged by its ORIGINAL name. MUST refuse.
import { isBetterMappingOwner as better } from '../utils/mapping-path.js';

export function choose(candidate, incumbent) {
  return better(candidate, incumbent) ? candidate : incumbent;
}
