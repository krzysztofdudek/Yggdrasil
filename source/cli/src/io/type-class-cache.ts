import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicWriteFile } from './atomic-write.js';
import type { Graph } from '../model/graph.js';
import type { ClassificationResult } from '../core/type-classifier.js'; // type-only — no relation implication, mirrors the FileContentCache precedent's own type-only cross-reference

/**
 * Cache schema version. Bump whenever the on-disk shard format changes —
 * orphans older-version shards under `.type-class-cache/` (a one-time cold
 * re-classify of a gitignored, rebuildable cache — benign).
 *
 * v2: the key now folds in the file's own repo-relative path (see `classKey`).
 * A v1 shard was addressed by `(contentHash, archHash)` ALONE, so two
 * byte-identical files at different paths shared one shard and the second
 * silently inherited the first's classification — a same-run aliasing bug,
 * not a staleness one (it fired on a cold cache). Bumping orphans every v1
 * shard rather than risk one being misread under the new key scheme.
 */
export const TYPE_CLASS_CACHE_SCHEMA_VERSION = 2;

/** Returns the root of the classification cache directory tree for a given graph root. */
export function typeClassCacheDir(graphRoot: string): string {
  return path.join(graphRoot, '.yggdrasil', '.type-class-cache');
}

export interface CachedClassification {
  /** Schema version — validated FIRST on load (fail-closed). */
  v: number;
  /** The shard key (matches the filename stem) — defensive identity assertion, mirrors ShardBody.key in facts-cache.ts. */
  key: string;
  matches: ClassificationResult['matches'];
  closest: ClassificationResult['closest'];
  unreadable: ClassificationResult['unreadable'];
}

/**
 * Serialize any JSON-representable value to a canonical JSON string where
 * object keys are sorted in code-point order and `undefined` values are
 * dropped. A SEPARATE, self-contained copy of core/pair-hash.ts's
 * codePointCanonicalJson — this file lives in the `persistence-adapter`
 * architecture type, whose `relations.calls` allow-list is `[persistence-
 * adapter, utility]` with `default: deny`; it may not `calls`/`uses` an
 * `engine` node (core/pair-hash.ts's own type), so the same handful of
 * lines are duplicated here rather than shared across that forbidden
 * boundary. Keep in sync only by intent, not by import — this is the
 * honest cost of the layering, not a shortcut.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Fold every classifying type's `(id, when, enforce)` triple into one hash,
 * computed ONCE per `TypeClassCache` instance and reused for every file in
 * the run (the same instance classifies every file against the same
 * architecture). Only types carrying a `when` predicate are folded — the
 * same set `classifyFile`'s own loop iterates (organizational types without
 * `when` are skipped there too, so they can never affect a cached verdict).
 *
 * `enforce` is folded alongside `when` deliberately: flipping a type from
 * non-strict to `enforce: strict` re-buckets its matching files (covered →
 * strictClaimed) even when the underlying boolean `when` result is
 * unchanged, so a hash keyed on `when` alone would wrongly keep serving the
 * pre-flip bucket.
 */
function architecturePredicateHash(architecture: Graph['architecture']): string {
  const classifying = Object.entries(architecture.node_types)
    .filter(([, def]) => def.when !== undefined)
    .map(([id, def]) => ({ id, when: def.when, enforce: def.enforce ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash('sha256').update(canonicalJson(classifying)).digest('hex');
}

/**
 * Shard filename stem (the cache key) for a given content hash, repo-relative
 * path, and architecture-predicate hash. Different `(contentHash, repoRelPath,
 * architecturePredicateHash)` triples always produce different keys.
 *
 * `repoRelPath` is folded in deliberately: it is exactly what every `path:`
 * predicate is evaluated against (core/file-when-evaluator.ts's
 * `globMatch(ctx.repoRelPath, predicate.path)`), so two files with identical
 * bytes at different paths can classify completely differently — omitting the
 * path from the key was the bug (two such files shared one shard; whichever
 * was classified first in the scan decided the other's verdict too, with no
 * error or warning). Folding it back in also restores the invariant `set()`'s
 * create-only write depends on: a shard is now genuinely identical to any
 * prior write under the same key, because the key can no longer be shared by
 * two different files.
 *
 * Width mirrors facts-cache.ts's factsKey: 32 hex chars = 128 bits of the
 * SHA-256 digest, making a birthday collision (which would serve one file's
 * shard for another, only caught afterward by the `key !== requestedKey`
 * identity assertion) infeasible.
 */
function classKey(contentHash: string, repoRelPath: string, archHash: string): string {
  const payload = `${contentHash}\0${repoRelPath}\0${archHash}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function shardPath(dir: string, key: string): string {
  return path.join(dir, `v${TYPE_CLASS_CACHE_SCHEMA_VERSION}`, `${key}.json`);
}

/**
 * Path-and-content-keyed classification cache, constructed once per
 * computeTypeCoverage run and injected into every classifyFile call —
 * exactly the FileContentCache injection shape. The architecture-predicate
 * hash is computed ONCE in the constructor (folds every classifying type's
 * (id, when, enforce) triple), so an edit to ANY type's `when` OR `enforce`
 * (not just the one that happened to match a given file last run)
 * invalidates every entry for every file in one stroke — a NEW type's when
 * could now match a file that previously matched nothing, and an
 * enforce-only flip changes which BUCKET a match lands in even when the
 * underlying boolean result is unchanged.
 *
 * Every `get`/`set` also takes the file's own repo-relative path, folded into
 * the key alongside its content hash (see `classKey`) — two files can never
 * share an entry, no matter how their bytes compare, because `path:`
 * predicates are evaluated against exactly that path.
 *
 * Modeled directly on relations/facts-cache.ts's shard contract (schema
 * version validated first, then required-field shape, then an inner
 * identity-key defensive check — never paper over a corrupt or stale
 * entry), but lives in `io/` (persistence-adapter), not `core/` (engine):
 * `core/**` carries the `no-direct-fs` aspect, so the filesystem-touching
 * half of this cache cannot live there. `core/` callers construct this
 * class as a VALUE and inject the instance, the same way `FileContentCache`
 * is already injected today.
 */
export class TypeClassCache {
  private readonly dir: string;
  private readonly archHash: string;

  constructor(graphRoot: string, architecture: Graph['architecture']) {
    this.dir = typeClassCacheDir(graphRoot);
    this.archHash = architecturePredicateHash(architecture);
  }

  /**
   * Returns null on ANY validation failure — same fail-closed contract as
   * facts-cache.ts's loadFacts (never paper over a corrupt/stale entry).
   * Existence is checked before reading (never an inline ENOENT-swallow
   * around a read, per read-or-default-via-helper — mirrors facts-cache.ts's
   * own existsSync-then-readFileSync order).
   */
  get(contentHash: string, repoRelPath: string): CachedClassification | null {
    const key = classKey(contentHash, repoRelPath, this.archHash);
    const p = shardPath(this.dir, key);
    if (!existsSync(p)) return null;

    let parsed: Partial<CachedClassification>;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<CachedClassification>;
    } catch {
      return null;
    }

    // Validate schema version FIRST — if this doesn't match we can't trust anything else.
    if (!parsed || typeof parsed !== 'object' || parsed.v !== TYPE_CLASS_CACHE_SCHEMA_VERSION) return null;

    // Validate required fields.
    if (typeof parsed.key !== 'string') return null;
    if (!Array.isArray(parsed.matches)) return null;
    if (!Array.isArray(parsed.closest)) return null;
    if (!Array.isArray(parsed.unreadable)) return null;

    // Defensive identity assertion — stored key must match the requested key.
    if (parsed.key !== key) return null;

    return {
      v: parsed.v,
      key: parsed.key,
      matches: parsed.matches,
      closest: parsed.closest,
      unreadable: parsed.unreadable,
    };
  }

  /**
   * Best-effort — a write failure never fails classification (mirrors the
   * AST cache and FileContentCache's own read-failure handling). Create-only,
   * mirroring facts-cache.ts's writeFacts: a content-addressed shard is by
   * construction identical to any prior write under the same key (the key now
   * folds in the writing file's own path, so no two different files can ever
   * share one), so re-writing is wasted IO, and skipping it also means a
   * fresh write can never race a concurrent reader into observing a torn file
   * (atomicWriteFile already guarantees that too, via temp + rename).
   */
  async set(contentHash: string, repoRelPath: string, result: ClassificationResult): Promise<void> {
    const key = classKey(contentHash, repoRelPath, this.archHash);
    const p = shardPath(this.dir, key);
    if (existsSync(p)) return;

    const body: CachedClassification = {
      v: TYPE_CLASS_CACHE_SCHEMA_VERSION,
      key,
      matches: result.matches,
      closest: result.closest,
      unreadable: result.unreadable,
    };
    try {
      await atomicWriteFile(p, JSON.stringify(body));
    } catch {
      // Best-effort: a write failure (disk full, permissions, …) never fails
      // classification — the caller already has its live result either way.
    }
  }
}
