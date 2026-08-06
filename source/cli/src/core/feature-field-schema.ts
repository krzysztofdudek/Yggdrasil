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
 *  reader rejects any file whose `v` is not exactly this value.
 *
 *  Bumped 1 -> 2 when the `family` string widened from two segments
 *  (`${ownerNodeId}${FAMILY_SEP}${language}`) to three (`${owner.kind}
 *  ${FAMILY_SEP}${owner.id}${FAMILY_SEP}${language}`, see {@link FamilyOwner} /
 *  `familyKey`) so a type-covered file (no owning node) can be admitted to its
 *  own family without ever colliding with a node-owned one that happens to
 *  share the same id string. The index is local, gitignored, rebuildable state
 *  — a version bump costs an adopter nothing beyond one extra rebuild on the
 *  next `yg check`. */
export const FEATURE_FIELD_VERSION = 2;

/** Basename of the local, gitignored index file (under `.yggdrasil/`). */
export const FEATURE_FIELD_FILENAME = '.feature-field.json';

/** NUL separator inside the family key — never appears in a node id, a type id, or a
 *  language id. A family key is `${owner.kind}${FAMILY_SEP}${owner.id}${FAMILY_SEP}${language}`
 *  (see {@link FamilyOwner}). */
export const FAMILY_SEP = '\x00';

/**
 * The comparison-cohort owner a family key is built from: EITHER the file's owning
 * node, OR — for a file no node owns — its matched classifying type
 * (`computeTypeCoverage(...).covered`). A discriminated union so a node-owned and a
 * type-covered file can never collide on the same family key even when a node id and
 * a type id happen to be the identical string (a node `svc` and a type `svc` are two
 * different comparison cohorts).
 */
export type FamilyOwner = { kind: 'node'; id: string } | { kind: 'type'; id: string };

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
