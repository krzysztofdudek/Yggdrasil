/**
 * Which node owns a file: the query surface of the owner index. Pure types, in the
 * model layer so a layer that may not depend on the relations adapter (the structure
 * runner's allowed-reads computation) can take an index as a parameter.
 * `relations/owner-index.ts` builds the index and re-exports these names.
 */

/**
 * How the winning mapping entry matched the file:
 *   - 'exact'     — a non-glob entry equal to the file path.
 *   - 'directory' — a non-glob entry that is a directory prefix of the file
 *                   (`file.startsWith(entry + '/')`).
 *   - 'glob'      — a glob entry (`isGlobPattern`) that matched the file.
 */
export interface OwnerEntry {
  nodePath: string;
  mapping: string;
  kind: 'exact' | 'directory' | 'glob';
}

export interface OwnerIndex {
  ownerOf(repoRelPosix: string): string | undefined;
  ownerEntryOf(repoRelPosix: string): OwnerEntry | undefined;
}
