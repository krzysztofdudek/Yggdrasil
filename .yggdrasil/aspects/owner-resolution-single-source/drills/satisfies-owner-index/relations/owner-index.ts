// The single canonical home. Its path ends in relations/owner-index.ts, so it is
// exempt: it may import AND call the comparator. MUST pass (replicates the real
// owner-index import shape).
import { mappingEntryMatchesFile, isGlobPattern, isBetterMappingOwner } from '../utils/mapping-path.js';

export function ownerEntryOf(entries, file, seed) {
  let best = seed;
  for (const e of entries) {
    const hit = isGlobPattern(e.mapping) ? mappingEntryMatchesFile(e.mapping, file) : file === e.mapping;
    if (!hit) continue;
    if (!best || isBetterMappingOwner({ mappingLen: e.mapping.length }, { mappingLen: best.mapping.length })) {
      best = e;
    }
  }
  return best;
}
