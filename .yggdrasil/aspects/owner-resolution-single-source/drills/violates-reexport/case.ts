// Re-exporting the comparator from a non-owner-index module republishes it and
// lets other modules pull it in through the back door. MUST refuse.
export { isBetterMappingOwner } from '../utils/mapping-path.js';
