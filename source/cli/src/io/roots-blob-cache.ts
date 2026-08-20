/**
 * source/cli/src/io/roots-blob-cache.ts — the sharded, content-addressed
 * historical-blob cache under `.yggdrasil/roots/.cache/blobs/` (D14, spec
 * §13.2 `v6-spec.md:604-607`; program plan `plugin-marketplace-plan.md:75-76`).
 *
 * A record for key `k` lands at `<cacheDir>/<k.slice(0, 2)>/<k>.json` — one
 * directory per 2-hex prefix, one file per key, never an aggregate
 * `<cacheDir>/<prefix>.json` (D14's binding-paragraph-and-design reading of
 * §13.2, over that section's own "one aggregate file per shard" prototype
 * simplification, recorded SIMPLIFIED at `v6-spec.md` Appendix F `:972`).
 *
 * GENERIC over the record (`unknown` in, `unknown` out), exactly as
 * `roots/stores.ts` is generic over the model body (`stores.ts:143-182`):
 * `persistence-adapter` may not import a `roots-engine` type (the relation
 * allow-list has no such edge), so the concrete blob-record shape
 * (`BlobRecord`, a later roots module) narrows what it reads here instead of
 * this file importing it.
 *
 * Per-record tolerant (R4-I10, R4-I15/MR-1's sibling): one corrupt or
 * unreadable shard is one miss, re-extracted for free by the caller — never a
 * thrown error, and never poisoning any other key's shard. Contrast
 * `roots-history-store.ts`'s all-or-nothing contract, which this file's own
 * header comment there explains is the deliberately OPPOSITE tolerance for a
 * different kind of state.
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFile } from './atomic-write.js';
import { debugWrite } from '../utils/debug-log.js';

/**
 * Serialize any JSON-representable value to canonical JSON: object keys
 * sorted in code-point order, `undefined` values dropped, no inserted
 * whitespace (one JSON value per file, matching every other content-addressed
 * shard in this codebase). A SEPARATE, self-contained copy — this file lives
 * in the `persistence-adapter` architecture type, whose `relations.calls`
 * allow-list is `[persistence-adapter, utility]` with `default: deny`, so it
 * may not `calls`/`uses` an `engine`- or `roots-store`-typed module to reach a
 * shared canonical-JSON helper (every existing one in this repository is
 * unexported besides): `roots/stores.ts`'s `sortKeysDeep`/`canonicalModelJson`,
 * `io/type-class-cache.ts`'s `canonicalJson`, `roots/binding.ts`'s and
 * `roots/config.ts`'s own copies, and the `engine`-type copy at
 * `core/advise-nominations.ts:337`. Kept in sync only by intent across the
 * copies, the same honest cost `stores.ts:103-117` documents for itself.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  // `a === b` is unreachable here: `Object.entries` never yields two entries sharing a key, so
  // the comparator only ever needs the two-way `<`/`>` outcome, never a tie — a three-way
  // comparator would carry a branch no input can ever take.
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** `<cacheDir>/<key.slice(0,2)>/<key>.json` — D14's literal shard layout. */
function shardPath(cacheDir: string, key: string): string {
  return path.join(cacheDir, key.slice(0, 2), `${key}.json`);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface WriteBlobRecordOptions {
  /**
   * Injectable atomic writer. Default `atomicWriteFile`. Exists so a test
   * can drive `writeBlobRecord`'s write-failure degrade branch (R4-I10 —
   * "a write that fails on a cache or state file is one `debugWrite` and the
   * run continues") deterministically: there is no portable, root-safe
   * OS-level way to make a real write fail on demand in this repo's
   * commit-gate container. Same idiom as `now`/`sleep`/`unlink` on
   * `roots-build-lock-store.ts`'s options.
   */
  write?: (filePath: string, content: string) => Promise<void>;
}

/**
 * Write a blob-cache record. Best-effort: a write failure (disk full,
 * permissions, a read-only volume) is one `debugWrite` and the caller's run
 * continues — a cache write is derived state, never the product, and R4-I10
 * is explicit that a failed write here must not abort anything (`model.json`
 * still lands; the next run simply finds this key unmirrored and re-extracts
 * it). Mirrors `io/type-class-cache.ts`'s `set()` swallow precedent.
 *
 * Content-addressed by `key` (the caller's `blobCacheKey`, a later roots
 * module): re-writing the same key with the same record is a no-op in
 * substance (same bytes), so this function does not special-case an existing
 * shard the way `TypeClassCache.set` skips one — the caller decides whether a
 * write is worth attempting at all (a read-through cache wrapper, T4).
 */
export async function writeBlobRecord(
  cacheDir: string,
  key: string,
  record: unknown,
  options: WriteBlobRecordOptions = {},
): Promise<void> {
  const write = options.write ?? atomicWriteFile;
  const p = shardPath(cacheDir, key);
  try {
    await write(p, canonicalJson(record));
  } catch (e) {
    debugWrite(`[roots-blob-cache] write failed for ${p}: ${errMsg(e)}`);
  }
}

/**
 * Read a blob-cache record. Returns `undefined` — a MISS, never a thrown
 * error — when the shard is absent, unreadable, or contains unparseable JSON
 * (R4-I10: a corrupt cache entry is a miss and is rebuilt). Every miss caused
 * by an actually-existing-but-broken file logs one `debugWrite` line naming
 * the shard; a simply-absent shard (the ordinary cache-miss path, expected on
 * every cold key) is silent — logging it would spam one line per never-seen
 * blob on every cold run.
 */
export async function readBlobRecord(cacheDir: string, key: string): Promise<unknown | undefined> {
  const p = shardPath(cacheDir, key);
  if (!existsSync(p)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(p, 'utf-8');
  } catch (e) {
    debugWrite(`[roots-blob-cache] unreadable shard ${p}: ${errMsg(e)}`);
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (e) {
    debugWrite(`[roots-blob-cache] corrupt shard ${p}: ${errMsg(e)}`);
    return undefined;
  }
}
