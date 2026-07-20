// A non-owner-index module that imports the comparator by name and calls it.
// MUST refuse — hierarchy-first ownership belongs only in relations/owner-index.
import { isBetterMappingOwner } from '../utils/mapping-path.js';

export function pickOwner(candidate, incumbent) {
  return isBetterMappingOwner(candidate, incumbent) ? candidate : incumbent;
}
