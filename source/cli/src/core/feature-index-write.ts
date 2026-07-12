/**
 * feature-index-write.ts — the SILENT feature-field deviation index (L3 attention).
 *
 * ## What this is
 *
 * `yg check` maintains a local, gitignored `.yggdrasil/.feature-field.json` that lists
 * source files which are STRUCTURALLY UNUSUAL among their node's OTHER same-language files.
 * "Structurally unusual" is measured on the ten raw feature dimensions the relation pass
 * already computed per file (see feature-vector.ts): `nodeCount`, the three nesting-depth
 * quartiles, and the six structural category counts. A file is flagged on a dimension when
 * it is a robust outlier within its FAMILY (owner node × extractor language).
 *
 * This is pure ATTENTION (L3). It is:
 *   - NEVER an issue, an exit code, or a `suggestedNext` — it does not gate `yg check`.
 *   - NEVER an input to any verdict hash — like the feature vectors it reads, it is
 *     instrumentation, so it can never invalidate a verdict or change what the gate decides.
 *   - BEST-EFFORT — a write failure is swallowed to the debug log; a check never fails
 *     because the index could not be written (the index is attention, not law).
 *   - SPARSE — only files with at least one admitted deviation are written.
 *   - TRACKED-ONLY — it considers only the repository's git-tracked, graph-governed files (the
 *     universe the coverage layer governs); a gitignored / scratch / nested-worktree file that
 *     merely falls under a mapped ancestor directory is never flagged. When no git file set is
 *     available, NO index is written (unknown scoping ≠ an empty or unfiltered one).
 *
 * ## Robust statistics only
 *
 * Outlier detection uses the MEDIAN and the median-absolute-deviation (MAD), never the
 * mean/σ: a single wild file must not drag the centre it is being measured against.
 * `robustZ(x, med, mad) = (x - med) / (1.4826 * mad)` — the constant rescales MAD so that,
 * for normally-distributed data, the statistic matches a standard z-score. A dimension is
 * admitted for a file when ALL THREE hold:
 *   1. the family has at least `MIN_N` files (below that we stay silent — small-sample honesty),
 *   2. the dimension has non-zero spread within the family (`mad > 0` — avoids divide-by-zero
 *      and spurious infinities on a constant dimension), and
 *   3. the file's robust score is at least `Z_ADMIT` in magnitude.
 *
 * ## Per-language non-comparability
 *
 * The six categories are a language-independent contract, but their per-language node-type
 * realizations differ per grammar and grammars carve source into wildly different node
 * counts (see feature-vector.ts). A Python file's shape is NOT comparable to a Java one.
 * That is why a FAMILY pins BOTH the owner node AND the extractor language — every
 * comparison is within a single language, never across.
 *
 * ## contentHash — the match key for the reader
 *
 * Each index entry carries the file's raw content hash, threaded from the relation pass
 * (`hashByPath`, i.e. the pass's `FileRecord.hash`, which is `hashString(fileBytes)`). This
 * is the SAME hash a later reader re-derives from the file bytes: an index entry is valid
 * exactly while the file's bytes are unchanged. Threading the pass's own hash (rather than
 * re-reading here) guarantees the hash pins the exact bytes the feature vectors were
 * computed from — no re-read, no time-of-check/time-of-use gap.
 */

import path from 'node:path';

import type { Graph } from '../model/graph.js';
import type { FileFacts } from '../relations/pass.js';
import { ALL_FEATURE_CATEGORIES, type FeatureVector } from '../relations/feature-vector.js';
import { buildOwnerIndex } from '../relations/owner-index.js';
import { getLanguageForExtension } from './graph/language-registry.js';
import { atomicWriteFile } from '../io/atomic-write.js';
import { readTextFile, writeTextFile } from '../io/graph-fs.js';
import { debugWrite } from '../utils/debug-log.js';

// ── Named admission constants (documented change policy — RZ-21) ─────────────

/**
 * Robust |z| admission threshold. A file must be at least this many robust-z units from
 * its family's median on a dimension to be flagged. Raised ONLY by a deliberate
 * re-calibration (informed by `--attention-dump`) and recorded in the changelog — never
 * tuned silently.
 */
export const Z_ADMIT = 3.5;

/**
 * Minimum family size. A family with fewer than this many same-language files contributes
 * NO deviations: too few neighbours to say anything is "unusual" (small-sample honesty).
 */
export const MIN_N = 5;

/** On-disk index schema version. */
export const FEATURE_FIELD_VERSION = 1;

/** Basename of the local, gitignored index file (under `.yggdrasil/`). */
export const FEATURE_FIELD_FILENAME = '.feature-field.json';

/** NUL separator inside the family key — never appears in a node id or a language id. */
const FAMILY_SEP = '\x00';

// ── Types ────────────────────────────────────────────────────────────────────

/** One admitted deviation: the dimension name and the file's robust score on it. */
export interface Deviation {
  /** One of the ten dimension names (see {@link DIMS}). */
  dim: string;
  /** The file's robust score on this dimension (rounded for storage; admission used full precision). */
  z: number;
}

/** Per-file deviation record produced by {@link computeFamilyDeviations}. */
export interface FileDeviations {
  /** `${ownerNodeId}\x00${language}` — the comparison cohort this file belongs to. */
  family: string;
  /** The file's raw content hash (the pass's hash — the reader's match key). */
  contentHash: string;
  /** Every dimension on which this file is a robust outlier within its family. */
  deviations: Deviation[];
}

/** The on-disk index shape (§5.3). */
export interface FeatureFieldIndex {
  v: number;
  generatedAt: string;
  files: Record<string, { contentHash: string; family: string; deviations: Deviation[] }>;
}

// ── Robust statistics (pure; exported for direct unit testing) ───────────────

/**
 * Median of a NON-EMPTY numeric array. Odd length → the middle element; even length → the
 * mean of the two middle elements. Callers here only ever pass a family of `>= MIN_N`
 * values, so the array is never empty.
 */
export function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation about a supplied centre: `median(|x - med|)`. Zero on a
 *  constant dimension (which callers treat as "no spread" → never a deviation). */
export function mad(nums: number[], med: number): number {
  return median(nums.map((x) => Math.abs(x - med)));
}

/** Robust z score. Caller guarantees `madValue > 0` (a zero-spread dimension is skipped
 *  before this is reached, so there is never a divide-by-zero here). */
export function robustZ(x: number, med: number, madValue: number): number {
  return (x - med) / (1.4826 * madValue);
}

// ── The ten deviation dimensions ─────────────────────────────────────────────

interface DimSpec {
  dim: string;
  get: (fv: FeatureVector) => number;
}

/**
 * The ten dimensions, in a FIXED order (used for both the index and the calibration dump):
 * `nodeCount`, the three nesting-depth quartiles, then the six structural categories in
 * their canonical order. A file's `deviations` array follows this order.
 */
export const DIMS: readonly DimSpec[] = [
  { dim: 'nodeCount', get: (fv) => fv.nodeCount },
  { dim: 'depthQ25', get: (fv) => fv.depthQuartiles[0] },
  { dim: 'depthQ50', get: (fv) => fv.depthQuartiles[1] },
  { dim: 'depthQ75', get: (fv) => fv.depthQuartiles[2] },
  ...ALL_FEATURE_CATEGORIES.map((cat) => ({ dim: cat, get: (fv: FeatureVector) => fv.categories[cat] })),
];

// ── Family key (single source of truth for the on-disk `family` string) ──────

/** Build the family key: owner node id and extractor language, NUL-joined. */
export function familyKey(ownerNodeId: string, language: string): string {
  return `${ownerNodeId}${FAMILY_SEP}${language}`;
}

/** Round a robust score to 2 decimals for stable, readable storage (admission itself uses
 *  the full-precision score, so rounding never changes what is flagged). */
function roundZ(z: number): number {
  return Math.round(z * 100) / 100;
}

// ── Family grouping (single source of truth, shared by writer + calibration dump) ──

/** One file's contribution to a family: its repo-rel POSIX path and structural vector. */
export interface FamilyMember {
  path: string;
  fv: FeatureVector;
}

/**
 * Partition the pass's per-file feature vectors into families — owner node × extractor
 * language. This is the SINGLE definition of the grouping rule, shared by the index writer
 * ({@link computeFamilyDeviations}) and the calibration dump (`runAttentionDump`) so the two
 * can never drift.
 *
 * `includedPaths` scopes the universe to the repository's TRACKED, graph-governed files (the
 * same set `yg check`'s coverage layer governs — tracked files minus nested-graph subtrees).
 * A file not in that set is skipped even if it has an owner: the relation pass parses every
 * node-mapped file, which can include gitignored scratch or a nested worktree copy that falls
 * under a mapped ancestor directory, and attention must never speak about files the repository
 * does not version. A file with no owner is skipped (uncovered files are a coverage matter, not
 * attention); a file whose extension has no extractor language is skipped (defensive — every
 * `factsByPath` entry has one).
 */
export function groupByFamily(
  factsByPath: Map<string, FileFacts>,
  ownerOf: (repoRelPosix: string) => string | undefined,
  includedPaths: ReadonlySet<string>,
): Map<string, FamilyMember[]> {
  const families = new Map<string, FamilyMember[]>();
  for (const [filePath, facts] of factsByPath) {
    if (!includedPaths.has(filePath)) continue; // only tracked, graph-governed files
    const owner = ownerOf(filePath);
    if (owner === undefined) continue; // uncovered → not attention
    const language = getLanguageForExtension(path.extname(filePath));
    if (language === null) continue; // no extractor language → cannot form a family (defensive)
    const key = familyKey(owner, language);
    let list = families.get(key);
    if (list === undefined) {
      list = [];
      families.set(key, list);
    }
    list.push({ path: filePath, fv: facts.features });
  }
  return families;
}

// ── Core computation (pure; no IO, no clock) ─────────────────────────────────

/**
 * Group the pass's per-file feature vectors into families (owner node × extractor language)
 * and return, for every file with at least one robust outlier dimension, its family, content
 * hash, and the admitted deviations. A file with no owner is skipped (uncovered files are a
 * coverage matter, not attention). A family below `MIN_N` contributes nothing. A dimension
 * with zero spread within a family is never a deviation.
 *
 * Pure and deterministic: no filesystem access, no clock. `includedPaths` scopes the universe
 * to the repository's tracked, graph-governed files (see {@link groupByFamily}). The
 * synthetic-family unit tests drive this directly.
 */
export function computeFamilyDeviations(
  factsByPath: Map<string, FileFacts>,
  ownerOf: (repoRelPosix: string) => string | undefined,
  hashByPath: Map<string, string>,
  includedPaths: ReadonlySet<string>,
): Map<string, FileDeviations> {
  const families = groupByFamily(factsByPath, ownerOf, includedPaths);

  // Per family, per dimension: robust outlier detection.
  const devsByPath = new Map<string, Deviation[]>();
  const familyOfPath = new Map<string, string>();
  for (const [family, members] of families) {
    for (const m of members) familyOfPath.set(m.path, family);
    if (members.length < MIN_N) continue; // small-sample honesty
    for (const { dim, get } of DIMS) {
      const values = members.map((m) => get(m.fv));
      const med = median(values);
      const madValue = mad(values, med);
      if (madValue <= 0) continue; // constant dimension → no spread, never a deviation
      for (const m of members) {
        const z = robustZ(get(m.fv), med, madValue);
        if (Math.abs(z) >= Z_ADMIT) {
          let arr = devsByPath.get(m.path);
          if (arr === undefined) {
            arr = [];
            devsByPath.set(m.path, arr);
          }
          arr.push({ dim, z: roundZ(z) });
        }
      }
    }
  }

  // 3. Assemble the sparse result — only files with >= 1 deviation.
  const result = new Map<string, FileDeviations>();
  for (const [filePath, deviations] of devsByPath) {
    const contentHash = hashByPath.get(filePath);
    if (contentHash === undefined) continue; // no hash to pin the entry (defensive; never happens for a mapped file)
    result.set(filePath, { family: familyOfPath.get(filePath)!, contentHash, deviations });
  }
  return result;
}

// ── Writer (best-effort, atomic, gitignore-self-ensuring) ────────────────────

export interface WriteFeatureIndexOptions {
  /** INJECTED clock stamped into `generatedAt`. Tests pin it; the CLI passes `() => new Date()`. */
  now: () => Date;
}

/**
 * Compute the sparse deviation index over the pass's per-file facts and write it to
 * `.yggdrasil/.feature-field.json`, atomically. BEST-EFFORT: any error (including a
 * gitignore or write failure) is swallowed to the debug log — a check never fails because
 * the index could not be written. Ensures the gitignore line before the first write so the
 * index is never committed even in a repo whose `init` predates this feature.
 */
export async function writeFeatureIndex(
  graph: Graph,
  factsByPath: Map<string, FileFacts>,
  hashByPath: Map<string, string>,
  includedPaths: ReadonlySet<string>,
  opts: WriteFeatureIndexOptions,
): Promise<void> {
  try {
    const ownerOf = buildOwnerIndex(graph.nodes).ownerOf;
    const deviations = computeFamilyDeviations(factsByPath, ownerOf, hashByPath, includedPaths);

    const files: FeatureFieldIndex['files'] = {};
    // Sort paths for a stable on-disk file (it is gitignored, but a stable serialization
    // keeps diffs and equality checks clean during development/testing).
    for (const filePath of [...deviations.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
      const d = deviations.get(filePath)!;
      files[filePath] = { contentHash: d.contentHash, family: d.family, deviations: d.deviations };
    }

    const index: FeatureFieldIndex = {
      v: FEATURE_FIELD_VERSION,
      generatedAt: opts.now().toISOString(),
      files,
    };

    // Self-ensure the gitignore line BEFORE the write (independent best-effort).
    await ensureFeatureFieldGitignored(graph.rootPath);
    const target = path.join(graph.rootPath, FEATURE_FIELD_FILENAME);
    await atomicWriteFile(target, `${JSON.stringify(index, null, 2)}\n`);
  } catch (err) {
    // The index is attention, not law — a write failure never fails a check.
    debugWrite(`[feature-field] writeFeatureIndex failed (best-effort, ignored): ${(err as Error).message}`);
  }
}

/**
 * Ensure `<yggRoot>/.gitignore` carries `.feature-field.json`. Independent best-effort: a
 * failure here is logged and never propagates (the caller is already best-effort, and
 * `init`/`--upgrade` scaffold the same line via YGGDRASIL_GITIGNORE_LINES — this is the
 * backstop for a repo that never re-ran init). Idempotent: creates the file when absent,
 * appends the line once when missing, no-ops when present.
 */
async function ensureFeatureFieldGitignored(yggRoot: string): Promise<void> {
  const giPath = path.join(yggRoot, '.gitignore');
  try {
    let existing: string;
    try {
      existing = await readTextFile(giPath);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await writeTextFile(giPath, `${FEATURE_FIELD_FILENAME}\n`);
      return;
    }
    const present = new Set(existing.split('\n').map((l) => l.trim()));
    if (present.has(FEATURE_FIELD_FILENAME)) return;
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await writeTextFile(giPath, `${existing}${sep}${FEATURE_FIELD_FILENAME}\n`);
  } catch (err) {
    debugWrite(`[feature-field] gitignore self-ensure failed (best-effort, ignored): ${(err as Error).message}`);
  }
}
