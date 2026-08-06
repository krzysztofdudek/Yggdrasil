/**
 * feature-index-read.ts — the READER for the silent feature-field deviation index
 * (`.yggdrasil/.feature-field.json`, written by feature-index-write.ts).
 *
 * ## What this is
 *
 * Two pure, side-effect-free lookups over the same local index:
 *   - `readFeatureFieldEntry` — given a file's CURRENT content hash, return the
 *     file's recorded structural deviations IFF the index still describes exactly
 *     those bytes. It backs the advisory "structurally unusual" note in
 *     `yg context --file`.
 *   - `countLiveDeviationFiles` — the aggregate behind the `yg advise` attention
 *     line: how many listed files are STILL live deviations right now. It re-derives
 *     each file's current content hash with the SAME hashing the per-file lookup
 *     uses, so the count can never disagree with the per-file line's fire condition.
 *
 * ## Strict contentHash-match-or-omit
 *
 * The match key is the file's content hash — the SAME hash the relation pass
 * computes for its `FileRecord` (`hashString` of the file's UTF-8 text; see
 * relations/pass.ts). An entry is honoured only when its stored `contentHash`
 * equals the file's current hash, so a STALE index (the file changed since the
 * index was written) stays silent: attention never speaks about bytes the vectors
 * were not computed from. The per-file lookup takes the caller-computed hash; the
 * aggregate re-derives it here, reading each file's UTF-8 text and hashing it
 * exactly as `cli/build-context.ts` does — one shared rule, two callers.
 *
 * ## Tolerant of an absent or garbled index
 *
 * The index is local, rebuildable, gitignored instrumentation — never law. A
 * missing file, unreadable file, non-JSON content, an unexpected shape, an unknown
 * schema version, or a structurally-broken entry all resolve to `null` / a count of
 * 0, NEVER a throw. A corrupted entry — e.g. `deviations: [1, 2, 3]` — is rejected
 * whole (each deviation must be a `{ dim: string, z: number }` object; an entry left
 * with no well-formed deviation is treated as broken) so no garbage `dim`/`z` ever
 * reaches a consumer. Neither reader writes anything; each touches only the files it
 * reads.
 *
 * ## Import boundary (instrument-import fence, G2)
 *
 * Importable ONLY by `cli/build-context.ts` and `cli/advise.ts`. Keeping the
 * reader off every other path stops the read-only attention instrument from ever
 * reaching a verdict, an exit code, or a `suggestedNext`.
 */

import path from 'node:path';

import { readTextFileSyncOrNull } from '../io/graph-fs.js';
import { hashString } from '../io/hash.js';
import {
  FEATURE_FIELD_FILENAME,
  FEATURE_FIELD_VERSION,
  type FeatureFieldIndex,
} from './feature-field-schema.js';

/** One index entry as returned to a reader: the file's family and its deviations. */
export interface FeatureFieldEntry {
  /**
   * `${kind}\x00${ownerId}\x00${language}` — the comparison cohort the file
   * belongs to. `kind` is `'node'` when `ownerId` is an owning node's path, or
   * `'type'` when the file has no owning node and `ownerId` is its matched
   * architecture type instead (see `familyKey` in feature-index-write.ts). This
   * reader never parses the segments itself — it passes the whole string
   * through opaquely to its two callers, which do.
   */
  family: string;
  /** Every dimension on which the file is a robust outlier within its family. */
  deviations: { dim: string; z: number }[];
}

/** A validated + normalized on-disk entry (its content-hash kept for the match). */
interface NormalizedEntry extends FeatureFieldEntry {
  /** The stored content hash the file's current hash is compared against. */
  contentHash: string;
}

/**
 * Parse the on-disk index tolerantly and return its `files` map, or `null` on any
 * problem: missing / unreadable file, non-JSON content, top-level non-object,
 * unknown schema version, or a `files` field that is not an object. The single
 * shared parse for both the per-file lookup and the aggregate count — it never
 * throws and never writes, so a garbled index is uniformly silent on both surfaces.
 */
function readIndexFilesOrNull(yggRootPath: string): Record<string, unknown> | null {
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
  return index.files as Record<string, unknown>;
}

/**
 * Validate and normalize one raw index entry, or `null` when it is structurally
 * broken. `contentHash` and `family` must be strings and `deviations` an array;
 * each deviation element must be a `{ dim: string, z: number }` object — a
 * malformed element is DROPPED, so a corrupted `deviations: [1, 2, 3]` can never
 * feed a garbage `dim`/`z` to a consumer. An entry left with no well-formed
 * deviation after filtering is treated as broken (→ `null`): the writer is sparse
 * and only ever records a file that has at least one real deviation, so an empty
 * result is corruption, not a legitimate "outlier with no dimensions".
 */
function normalizeEntry(raw: unknown): NormalizedEntry | null {
  if (raw === null || typeof raw !== 'object') return null; // no entry / not an object
  const entry = raw as { contentHash?: unknown; family?: unknown; deviations?: unknown };
  if (typeof entry.contentHash !== 'string') return null;
  if (typeof entry.family !== 'string') return null;
  if (!Array.isArray(entry.deviations)) return null;

  const deviations: { dim: string; z: number }[] = [];
  for (const d of entry.deviations) {
    if (
      d !== null &&
      typeof d === 'object' &&
      typeof (d as { dim?: unknown }).dim === 'string' &&
      typeof (d as { z?: unknown }).z === 'number'
    ) {
      deviations.push({ dim: (d as { dim: string }).dim, z: (d as { z: number }).z });
    }
    // else: drop the malformed element
  }
  if (deviations.length === 0) return null; // no salvageable deviation → treat as broken

  return { contentHash: entry.contentHash, family: entry.family, deviations };
}

/**
 * Look up one file's deviation entry in `<yggRootPath>/.feature-field.json`.
 *
 * Returns the entry ONLY when the index exists, parses, is the current schema
 * version, has a well-formed entry for `repoRelPosixPath`, AND that entry's stored
 * `contentHash` equals `currentContentHash` (byte-accurate freshness). Returns
 * `null` on every other case — no index, garbled index, unknown version, no entry,
 * a structurally-broken entry, or a hash mismatch (a stale index never speaks).
 * Never throws; no writes.
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
  const files = readIndexFilesOrNull(yggRootPath);
  if (files === null) return null; // no / garbled / unknown-version index → silent

  const entry = normalizeEntry(files[repoRelPosixPath]);
  if (entry === null) return null; // no entry / structurally broken → silent
  if (entry.contentHash !== currentContentHash) return null; // STALE — bytes changed → silent

  return { family: entry.family, deviations: entry.deviations };
}

/**
 * Count how many files in `<yggRootPath>/.feature-field.json` are LIVE deviations
 * right now — the aggregate behind the `yg advise` attention line.
 *
 * A file counts IFF the index has a well-formed entry for it AND the file's CURRENT
 * content hash still equals the entry's stored `contentHash`. The current hash is
 * re-derived here exactly as the per-file lookup's caller derives it: read the
 * file's UTF-8 text and take `hashString` of it (NOT `hashBytes`) — so a file
 * counts here IFF `readFeatureFieldEntry` would return an entry for it, and the
 * count can never disagree with the per-file "structurally unusual" line's fire
 * condition. A file whose bytes changed since the index was written, that no longer
 * exists, or that is unreadable does NOT count (a stale index never speaks).
 *
 * Tolerant: a missing / garbled / unknown-version index yields 0, never a throw;
 * no writes. `projectRoot` is the repository root (the parent of `yggRootPath`),
 * against which the index's repo-relative POSIX keys resolve.
 */
export function countLiveDeviationFiles(yggRootPath: string, projectRoot: string): number {
  const files = readIndexFilesOrNull(yggRootPath);
  if (files === null) return 0; // no / garbled / unknown-version index → nothing live

  let live = 0;
  for (const [repoRelPosixPath, raw] of Object.entries(files)) {
    const entry = normalizeEntry(raw);
    if (entry === null) continue; // structurally-broken entry → not counted
    const text = readTextFileSyncOrNull(path.join(projectRoot, repoRelPosixPath));
    if (text === null) continue; // file vanished / unreadable → not live
    if (hashString(text) === entry.contentHash) live += 1; // exact-bytes match → live
  }
  return live;
}
