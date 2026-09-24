/**
 * source/cli/src/utils/mapping-index.ts — answer "which mapping entries match
 * this file?" without testing every entry against every file.
 *
 * `mappingEntryMatchesFile` (utils/mapping-path.ts) is the one definition of a
 * match: a plain entry matches the file equal to it or any file below it; a
 * glob entry matches by `globMatch`. Checking a repository's files against a
 * graph's mappings by calling it for every (file, entry) pair costs files ×
 * entries — at 18k files and 600 components that dominated a plain `yg check`.
 *
 * The index gives the same answers by construction: plain entries go into a set
 * and a file is looked up by itself and by each of its ancestor directories (a
 * plain entry matches a file exactly when it is one of those), and glob entries
 * — few in practice — are still tested one by one with `mappingEntryMatchesFile`.
 * Hits come back in the order the entries were given, so a caller that breaks
 * ties by position sees exactly what a linear scan would have shown it.
 */

import { isGlobPattern, mappingEntryMatchesFile, normalizeMappingPath } from './mapping-path.js';

export interface MappingHit<T> {
  /** The normalized mapping entry that matched. */
  entry: string;
  value: T;
  /** Position of the entry in the list the index was built from. */
  index: number;
}

export class MappingIndex<T> {
  private readonly plain = new Map<string, Array<MappingHit<T>>>();
  // Glob entries keep their raw spelling: mappingEntryMatchesFile normalizes
  // its arguments itself, and normalizing is not idempotent for every input
  // (' ./x' and './ x' differ once trimmed twice), so they are handed over raw,
  // exactly as a linear scan hands them over.
  private readonly globs: Array<MappingHit<T> & { raw: string }> = [];

  /** `entries`: raw mapping entries with a value each; normalized here, empty ones dropped. */
  constructor(entries: Iterable<readonly [string, T]>) {
    let index = 0;
    for (const [raw, value] of entries) {
      const entry = normalizeMappingPath(raw);
      const position = index++;
      if (entry === '') continue;
      const hit: MappingHit<T> = { entry, value, index: position };
      if (isGlobPattern(entry)) {
        this.globs.push({ ...hit, raw });
      } else {
        const bucket = this.plain.get(entry);
        if (bucket) bucket.push(hit);
        else this.plain.set(entry, [hit]);
      }
    }
  }

  /** Every entry matching `file`, in the order the entries were given. */
  matches(file: string): Array<MappingHit<T>> {
    const f = normalizeMappingPath(file);
    const hits: Array<MappingHit<T>> = [];
    if (f !== '') {
      let end = f.length;
      while (end > 0) {
        const bucket = this.plain.get(end === f.length ? f : f.slice(0, end));
        if (bucket) hits.push(...bucket);
        end = f.lastIndexOf('/', end - 1);
      }
    }
    for (const g of this.globs) {
      if (mappingEntryMatchesFile(g.raw, file)) hits.push({ entry: g.entry, value: g.value, index: g.index });
    }
    return hits.length > 1 ? hits.sort((a, b) => a.index - b.index) : hits;
  }

  /** Whether any entry matches `file`. */
  matchesAny(file: string): boolean {
    const f = normalizeMappingPath(file);
    if (f !== '') {
      let end = f.length;
      while (end > 0) {
        if (this.plain.has(end === f.length ? f : f.slice(0, end))) return true;
        end = f.lastIndexOf('/', end - 1);
      }
    }
    return this.globs.some((g) => mappingEntryMatchesFile(g.raw, file));
  }
}

/** A value-less index over plain entry strings — the common "is this file mapped at all?" case. */
export function mappingEntrySet(entries: Iterable<string>): MappingIndex<undefined> {
  const pairs: Array<readonly [string, undefined]> = [];
  for (const e of entries) pairs.push([e, undefined]);
  return new MappingIndex(pairs);
}
