import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicWriteFile } from '../io/atomic-write.js';
import type { DeclaredSymbol, DetectedDep } from './extractors/types.js';
import type { CsharpExtract } from './extractors/csharp.js';
import { isValidFeatureVector, type FeatureVector } from './feature-vector.js';

/**
 * Cache schema version. Bump whenever the on-disk shard format changes.
 *
 * v2: the shard now also carries a per-file structural `features` vector (see
 * feature-vector.ts). The `FEATURE_VOCAB` table is versioned WITH this number — any edit
 * to that table changes what a warm shard would carry, so it is a cache-format change and
 * requires bumping this constant. Bumping orphans older-version shards under `.ast-cache/`
 * (a one-time cold re-parse of a gitignored, rebuildable cache — benign), guaranteeing no
 * shard ever mixes two schema/vocab revisions.
 */
export const CACHE_SCHEMA_VERSION = 2;

/** Re-export so callers can `import { CsharpExtract } from facts-cache` if convenient. */
export type { CsharpExtract } from './extractors/csharp.js';

/** Extracted facts for one source file (declarations + detected dependencies). */
export interface FileFacts {
  declarations: DeclaredSymbol[];
  uses: DetectedDep[];
  /**
   * Per-file structural feature vector (see feature-vector.ts). Speed-only and OUTSIDE
   * every verdict hash — pure instrumentation for the anomaly layer. Always present for an
   * extractor-backed file: it is computed in the SAME parse-on-miss walk as declarations /
   * uses, and a shard whose `features` is missing or malformed is a whole-shard cache MISS
   * (`loadFacts` returns null → re-parse), never a silent zero-vector.
   */
  features: FeatureVector;
  /**
   * C#-specific pre-assembly extract (alias-UNRESOLVED). Present ONLY for C# files. Its
   * `scope.aliases` / `scope.globalAliases` are JavaScript `Map`s — see the serialization
   * note below: a plain `JSON.stringify(new Map())` is `"{}"` and SILENTLY drops every entry,
   * which would empty the alias map on a cache hit and false-green an alias-qualified edge.
   * `writeFacts`/`loadFacts` (de)serialize those two `Map`s as entry arrays at the boundary.
   */
  csharp?: CsharpExtract;
}

/**
 * On-disk mirror of a `CsharpExtract` with the two `UsingScope` `Map`s flattened to entry
 * arrays so they survive JSON. THIS is the heart of the false-green guard for C#: a `Map`
 * round-trips through `JSON.stringify` as `"{}"` (an empty object), so persisting a
 * `CsharpExtract` verbatim would reload an EMPTY alias map → alias-qualified references stop
 * resolving → a real cross-node dependency is silenced → the gate goes falsely GREEN. We
 * therefore convert `aliases` / `globalAliases` to `[key, value][]` on write and rebuild the
 * `Map`s on read. The rest of the extract (`prefixes`, `globalPrefixes`, `staticTargets`,
 * `refs`, `fileNs`) is already JSON-plain and copies through unchanged.
 */
interface SerializedCsharpExtract {
  fileNs: string;
  scope: {
    prefixes: string[];
    globalPrefixes: string[];
    aliases: Array<[string, string]>;
    globalAliases: Array<[string, string]>;
    staticTargets: Array<{ fqn: string; line: number }>;
  };
  refs: CsharpExtract['refs'];
}

/** Flatten a `CsharpExtract`'s `Map`s to entry arrays for safe JSON persistence. */
function serializeCsharp(c: CsharpExtract): SerializedCsharpExtract {
  return {
    fileNs: c.fileNs,
    scope: {
      prefixes: c.scope.prefixes,
      globalPrefixes: c.scope.globalPrefixes,
      aliases: [...c.scope.aliases],
      globalAliases: [...c.scope.globalAliases],
      staticTargets: c.scope.staticTargets,
    },
    refs: c.refs,
  };
}

/** Rebuild a `CsharpExtract` (with live `Map`s) from its persisted entry-array mirror. Returns
 *  `null` if the stored shape is malformed (any missing/ill-typed field → cache miss). */
function deserializeCsharp(raw: unknown): CsharpExtract | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<SerializedCsharpExtract>;
  if (typeof s.fileNs !== 'string') return null;
  if (!s.scope || typeof s.scope !== 'object') return null;
  const sc = s.scope as Partial<SerializedCsharpExtract['scope']>;
  if (
    !Array.isArray(sc.prefixes) ||
    !Array.isArray(sc.globalPrefixes) ||
    !Array.isArray(sc.aliases) ||
    !Array.isArray(sc.globalAliases) ||
    !Array.isArray(sc.staticTargets)
  ) {
    return null;
  }
  if (!Array.isArray(s.refs)) return null;
  return {
    fileNs: s.fileNs,
    scope: {
      prefixes: sc.prefixes,
      globalPrefixes: sc.globalPrefixes,
      aliases: new Map(sc.aliases),
      globalAliases: new Map(sc.globalAliases),
      staticTargets: sc.staticTargets,
    },
    refs: s.refs,
  };
}

/** Returns the root of the AST cache directory tree for a given graph root. */
export function astCacheDir(graphRoot: string): string {
  return path.join(graphRoot, '.ast-cache');
}

/**
 * Returns the shard filename stem (the cache key) for a given set of
 * content-addressing inputs. Different inputs always produce different keys
 * so no two distinct `(contentHash, language, grammarHash, rev)` tuples can
 * collide inside the same shard directory.
 *
 * Width is 32 hex chars = 128 bits of the SHA-256 digest. This makes a birthday
 * collision (which would serve one file's shard for another and slip past the
 * `parsed.key !== key` identity assertion, since that compares the SAME truncation)
 * infeasible. 64 bits was a false-green CLASS: at 128 bits the collision probability
 * is negligible even across an astronomically large shard population.
 */
export function factsKey(args: {
  contentHash: string;
  language: string;
  grammarHash: string;
  rev: number;
}): string {
  const payload = `${args.contentHash}\0${args.language}\0${args.grammarHash}\0${args.rev}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/** Shard path for a given cache root, language, and key. */
function shardPath(dir: string, language: string, key: string): string {
  return path.join(dir, `v${CACHE_SCHEMA_VERSION}`, language, `${key}.json`);
}

/**
 * Shard body stored on disk. Includes cache-identity fields so `loadFacts`
 * can perform a defensive identity assertion even without re-hashing inputs.
 */
interface ShardBody {
  /** Cache schema version — validated FIRST on load (fail-closed). */
  v: number;
  /** The shard key (matches the filename stem) — defensive identity assertion. */
  key: string;
  declarations: DeclaredSymbol[];
  uses: DetectedDep[];
  /** Per-file structural feature vector. Optional on the RAW shape (a v1 or corrupt shard
   *  may lack it); `loadFacts` validates it strictly and misses the whole shard if absent. */
  features?: FeatureVector;
  /** The C# extract in its JSON-safe (Map-flattened) on-disk form. */
  csharp?: SerializedCsharpExtract;
}

/**
 * Load cached facts for a given language + key.
 *
 * Returns `null` on ANY of:
 *   - shard file absent
 *   - JSON parse error
 *   - `v` field absent or !== CACHE_SCHEMA_VERSION (checked FIRST)
 *   - missing/malformed required fields (`key`, `declarations`, `uses`, `features`)
 *   - inner `key` field does not match the requested `key` (identity mismatch)
 *
 * NEVER returns `{ declarations: [], uses: [] }` to paper over a corrupt shard —
 * that would let a caller read "no dependencies" from a broken entry and cause
 * the verification gate to go falsely green.
 */
export async function loadFacts(
  dir: string,
  language: string,
  key: string,
): Promise<FileFacts | null> {
  const p = shardPath(dir, language, key);
  if (!existsSync(p)) return null;

  let parsed: ShardBody;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf-8')) as ShardBody;
  } catch {
    return null;
  }

  // Validate schema version FIRST — if this doesn't match we can't trust anything else.
  if (!parsed || typeof parsed !== 'object' || parsed.v !== CACHE_SCHEMA_VERSION) return null;

  // Validate required fields.
  if (typeof parsed.key !== 'string') return null;
  if (!Array.isArray(parsed.declarations)) return null;
  if (!Array.isArray(parsed.uses)) return null;

  // v2: features are mandatory and all-or-nothing. A missing or malformed features field is
  // a whole-shard MISS (fail-closed-to-parse) — never a silent 0-vector, which would let a
  // corrupt shard feed a false "typical" reading into the anomaly layer. Validate shape
  // strictly: nodeCount + depthQuartiles(3 finite numbers) + all six category keys.
  if (!isValidFeatureVector(parsed.features)) return null;

  // Defensive identity assertion — stored key must match the requested key.
  if (parsed.key !== key) return null;

  // Return only the FileFacts fields (strip internal shard metadata).
  const facts: FileFacts = {
    declarations: parsed.declarations,
    uses: parsed.uses,
    features: parsed.features,
  };
  if (parsed.csharp !== undefined) {
    // Rebuild the C# extract's `Map`s from their entry-array mirror. A malformed mirror
    // (any missing field) is treated as a CACHE MISS for the whole shard — never a silent
    // empty alias map (which would false-green an alias-qualified edge).
    const csharp = deserializeCsharp(parsed.csharp);
    if (csharp === null) return null;
    facts.csharp = csharp;
  }
  return facts;
}

/**
 * Write facts to the shard cache.
 *
 * Create-only: skips entirely if the shard already exists — a content-addressed
 * shard is by construction identical, so re-writing is wasted IO.
 *
 * Otherwise writes atomically via `atomicWriteFile` (temp + rename, mkdir -p).
 */
export async function writeFacts(
  dir: string,
  language: string,
  key: string,
  facts: FileFacts,
): Promise<void> {
  const p = shardPath(dir, language, key);
  if (existsSync(p)) return; // create-only — shard is content-addressed, already identical

  const body: ShardBody = {
    v: CACHE_SCHEMA_VERSION,
    key,
    declarations: facts.declarations,
    uses: facts.uses,
    // v2: persist the structural feature vector (plain JSON — no Map trap). Mandatory on
    // FileFacts, so it is always present here; a shard reloaded without it is a MISS.
    features: facts.features,
    // Flatten the C# extract's `Map`s to entry arrays BEFORE JSON.stringify — a bare `Map`
    // stringifies to `"{}"` and would silently lose every alias entry (the false-green vector).
    ...(facts.csharp !== undefined ? { csharp: serializeCsharp(facts.csharp) } : {}),
  };
  await atomicWriteFile(p, JSON.stringify(body));
}
