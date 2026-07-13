/**
 * feature-index-read.ts — the READER for the silent feature-field deviation index
 * (`.yggdrasil/.feature-field.json`, written by feature-index-write.ts).
 *
 * ## What this is
 *
 * A single, pure, side-effect-free lookup: given a file's CURRENT content hash,
 * return the file's recorded structural deviations IFF the index still describes
 * exactly those bytes. It backs the advisory "structurally unusual" note in
 * `yg context --file` and the attention layer's counts (`yg advise`).
 *
 * ## Strict contentHash-match-or-omit
 *
 * The caller passes the file's current content hash — the SAME hash the relation
 * pass computes for its `FileRecord` (`hashString` of the UTF-8 file text; see
 * relations/pass.ts). An entry is returned only when its stored `contentHash`
 * equals that value, so a STALE index (the file changed since the index was
 * written) stays silent: attention never speaks about bytes the vectors were not
 * computed from. Computing the hash is the caller's job (it already has, or can
 * cheaply read, the file text); this reader only compares.
 *
 * ## Tolerant of an absent or garbled index
 *
 * The index is local, rebuildable, gitignored instrumentation — never law. A
 * missing file, unreadable file, non-JSON content, an unexpected shape, or an
 * unknown schema version all resolve to `null`, NEVER a throw. The reader makes
 * no writes and touches nothing but the one file it reads.
 *
 * ## Import boundary (instrument-import fence, G2)
 *
 * Importable ONLY by `cli/build-context.ts` and `cli/advise.ts`. Keeping the
 * reader off every other path stops the read-only attention instrument from ever
 * reaching a verdict, an exit code, or a `suggestedNext`.
 */

import path from 'node:path';

import { readTextFileSyncOrNull } from '../io/graph-fs.js';
import {
  FEATURE_FIELD_FILENAME,
  FEATURE_FIELD_VERSION,
  type FeatureFieldIndex,
} from './feature-field-schema.js';

/** One index entry as returned to a reader: the file's family and its deviations. */
export interface FeatureFieldEntry {
  /** `${ownerNodeId}\x00${language}` — the comparison cohort the file belongs to. */
  family: string;
  /** Every dimension on which the file is a robust outlier within its family. */
  deviations: { dim: string; z: number }[];
}

/**
 * Look up one file's deviation entry in `<yggRootPath>/.feature-field.json`.
 *
 * Returns the entry ONLY when the index exists, parses, is the current schema
 * version, has an entry for `repoRelPosixPath`, AND that entry's stored
 * `contentHash` equals `currentContentHash` (byte-accurate freshness). Returns
 * `null` on every other case — no index, garbled index, unknown version, no
 * entry, or a hash mismatch (a stale index never speaks). Never throws; no writes.
 *
 * @param yggRootPath        Absolute path to the `.yggdrasil/` directory (graph.rootPath).
 * @param repoRelPosixPath   Repo-relative POSIX path — the index's key for the file.
 * @param currentContentHash The file's current content hash (same hashing as the relation pass).
 */
export function readFeatureFieldEntry(
  yggRootPath: string,
  repoRelPosixPath: string,
  currentContentHash: string,
): FeatureFieldEntry | null {
  const text = readTextFileSyncOrNull(path.join(yggRootPath, FEATURE_FIELD_FILENAME));
  if (text === null) return null; // no index / unreadable → silent

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // garbled JSON → silent
  }

  if (parsed === null || typeof parsed !== 'object') return null;
  const index = parsed as Partial<FeatureFieldIndex>;
  if (index.v !== FEATURE_FIELD_VERSION) return null; // unknown schema version → silent
  if (index.files === null || typeof index.files !== 'object') return null;

  const entry = index.files[repoRelPosixPath];
  if (entry === null || typeof entry !== 'object') return null; // no entry for this path
  if (entry.contentHash !== currentContentHash) return null; // STALE — bytes changed → silent
  if (typeof entry.family !== 'string' || !Array.isArray(entry.deviations)) return null; // defensive

  return { family: entry.family, deviations: entry.deviations };
}
