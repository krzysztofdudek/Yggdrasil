/**
 * feature-field-schema.ts — the on-disk contract of the silent feature-field
 * deviation index (`.yggdrasil/.feature-field.json`), shared by its writer and
 * its reader so the two can never drift on filename, version, family format, or
 * record shape.
 *
 * Pure data: constants and type declarations only, no IO and no logic. The WRITER
 * (`feature-index-write.ts`) and the READER (`feature-index-read.ts`) both key on
 * these; neither may value-import the other (the instrument-import fence forbids
 * it), so the shared pieces live here — the one place both are allowed to import.
 */

/** On-disk index schema version. Bumped only when the record shape changes; a
 *  reader rejects any file whose `v` is not exactly this value. */
export const FEATURE_FIELD_VERSION = 1;

/** Basename of the local, gitignored index file (under `.yggdrasil/`). */
export const FEATURE_FIELD_FILENAME = '.feature-field.json';

/** NUL separator inside the family key — never appears in a node id or a language id.
 *  A family key is `${ownerNodeId}${FAMILY_SEP}${language}`. */
export const FAMILY_SEP = '\x00';

/** One admitted deviation: the dimension name and the file's robust score on it. */
export interface Deviation {
  /** One of the ten fixed dimension names. */
  dim: string;
  /** The file's robust score on this dimension (rounded for storage). */
  z: number;
}

/** The on-disk index shape. Only files with at least one admitted deviation are
 *  written (sparse), keyed by repo-relative POSIX path. */
export interface FeatureFieldIndex {
  v: number;
  generatedAt: string;
  files: Record<string, { contentHash: string; family: string; deviations: Deviation[] }>;
}
