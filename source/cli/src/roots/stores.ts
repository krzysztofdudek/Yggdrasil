/**
 * source/cli/src/roots/stores.ts — persistence for the mined roots convention
 * model, under `.yggdrasil/roots/`: the committed `model.json` snapshot, the
 * committed append-only `seeds.jsonl`/`decisions.jsonl`/`ledger.jsonl` logs,
 * and the gitignored `.cache/`/`.state/` derived directories beside them
 * (design §4, `integration-design.md:122-165`). This file owns the whole
 * model-body I/O seam and the I2a header shape (`RootsModelHeader`) so no
 * later roots module reopens it: `writeModel`/`readModel` are GENERIC over
 * the body — the body's concrete shape (`MinedModel`) is declared where it is
 * produced, not here.
 *
 * `roots-engine` files never import this module — the roots-engine relation
 * allow-list has no `roots-store` edge. Store-shaped values (e.g. seeds) reach
 * engine code as explicit parameters instead; only the CLI command layer and
 * tests import this file directly.
 */

import path from 'node:path';
import type { SeedEntry, LedgerEntry } from '../model/graph.js';
import { readFileOrDefault } from '../io/read-or-default.js';
import { hashString } from '../io/hash.js';
import { atomicWriteFile } from '../io/atomic-write.js';

/** The roots store's on-disk schema version, folded into every committed `model.json`. */
export const ROOTS_VERSION = 1;

export const MODEL_FILENAME = 'model.json';
export const SEEDS_FILENAME = 'seeds.jsonl';
export const DECISIONS_FILENAME = 'decisions.jsonl';
export const LEDGER_FILENAME = 'ledger.jsonl';

/** The gitignored derived-cache directory name under `.yggdrasil/roots/` (design §4). */
export const CACHE_DIRNAME = '.cache';
/** The gitignored runtime-state directory name under `.yggdrasil/roots/` (design §4). */
export const STATE_DIRNAME = '.state';

/** Absolute path to the committed `.yggdrasil/roots/` directory for a given graph root. */
export function rootsStoreDir(yggRoot: string): string {
  return path.join(yggRoot, 'roots');
}

/** Absolute path to the gitignored `.yggdrasil/roots/.cache/` derived-cache root. */
export function rootsCacheDir(yggRoot: string): string {
  return path.join(rootsStoreDir(yggRoot), CACHE_DIRNAME);
}

/** Absolute path to the gitignored `.yggdrasil/roots/.state/` runtime-state root. */
export function rootsStateDir(yggRoot: string): string {
  return path.join(rootsStoreDir(yggRoot), STATE_DIRNAME);
}

/** Absolute path to the sharded, content-addressed historical-blob cache (D14), under `.cache/`. */
export function rootsBlobCacheDir(yggRoot: string): string {
  return path.join(rootsCacheDir(yggRoot), 'blobs');
}

/** Absolute path to the D1 replay-state directory (the six-file lifecycle/events/aliases/co-change/meta set), under `.cache/`. */
export function rootsHistoryStateDir(yggRoot: string): string {
  return path.join(rootsCacheDir(yggRoot), 'history');
}

/** Absolute path to the exclusive build lock every roots cache writer takes (spec §4.4), under `.cache/`. */
export function rootsBuildLockPath(yggRoot: string): string {
  return path.join(rootsCacheDir(yggRoot), '.build.lock');
}

/**
 * The roots model's I2a header — every determinism input `model.json` records,
 * excluded from the snapshot's own content hash (design §4,
 * `integration-design.md:140-142`). Every field has exactly one producer
 * elsewhere in the roots engine or the (later) `yg roots` command; this file
 * only fixes the shape both sides write and read:
 *   - `rootsVersion` — this file's own `ROOTS_VERSION` constant.
 *   - `configHash` — `roots/config.ts`'s `rootsConfigHash`.
 *   - `seedsHash` / `decisionsHash` / `ledgerHash` — this file's own
 *     `hashStoreFile`, called once per store file.
 *   - `bindingHash` — the all-grammar fold of `roots/binding.ts`'s per-grammar
 *     `bindingHash` (a later roots module).
 *   - `candidateCountLog2` — the mining pipeline's candidate-count fold (a
 *     later roots module).
 *   - `headSha` / `clock` / `lastIndexedSha` — the HEAD commit sha, the HEAD
 *     committer timestamp, and the resume-state sha (always `null` in this
 *     increment — full re-induction only). All three fail SOFT to `null` in a
 *     non-git repository, matching `utils/git.ts`'s existing fail-soft
 *     precedent: a repo with no git history still mines, and a `null` git
 *     field in the header is a recorded fact, not an error.
 *   - `dirtyHash` — the command layer's working-tree dirty-file content hash,
 *     computed with every `.yggdrasil/roots/**` path excluded (this store's
 *     own writes must never make the header churn on every run).
 *   - `rolesStale` — `false` in this increment (every build fully re-induces
 *     roles, so staleness is always knowable and never claimed as unknown).
 */
export interface RootsModelHeader {
  rootsVersion: number;
  headSha: string | null;
  lastIndexedSha: string | null;
  clock: string | null;
  bindingHash: string;
  configHash: string;
  seedsHash: string;
  decisionsHash: string;
  ledgerHash: string;
  dirtyHash: string;
  candidateCountLog2: number;
  rolesStale: boolean;
}

/** The generic on-disk shape of `model.json`: header + a body of any concrete type. */
export interface RootsModel<TBody = unknown> {
  header: RootsModelHeader;
  body: TBody;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-sort every object's own keys in code-point order (code-point order
 * because plain `Array.prototype.sort()` on strings already compares by UTF-16
 * code unit, and every key here is ASCII, so no locale-aware comparator is
 * needed); arrays keep their element order (order is meaningful there — only
 * OBJECT key order is incidental). `undefined` values are dropped, matching
 * `JSON.stringify`'s own behavior for object properties. A self-contained
 * helper, not a shared import: `roots-store`'s relation allow-list has no
 * edge to wherever a shared canonical-JSON helper would legally live (the one
 * existing canonical-JSON serializer in this repository lives on the
 * `engine` type, off this type's `calls` list, and `roots/config.ts`'s own
 * copy lives on `roots-engine`, an equally unreachable type from here) — see
 * that file's own header comment for the identical reasoning. Kept in sync
 * only by intent across the two copies, the same honest cost.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isPlainRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    sorted[key] = sortKeysDeep(value[key]);
  }
  return sorted;
}

/** Canonical (deep-sorted-keys), pretty-printed, trailing-newline JSON — the
 *  committed `model.json`'s exact serialization, called from `writeModel` and
 *  reused nowhere else so the two stay byte-identical by construction. */
function canonicalModelJson(model: RootsModel): string {
  return `${JSON.stringify(sortKeysDeep(model), null, 2)}\n`;
}

/**
 * Write `model.json` atomically: canonical-JSON serialization (deep-sorted
 * keys, 2-space indent, trailing newline) via a temp-file-then-rename
 * (`atomicWriteFile`), so a reader never observes a partial write. `body` is
 * generic — this function serializes whatever concrete shape the caller
 * passes, unaware of `MinedModel` or any other body type.
 */
export async function writeModel(yggRoot: string, header: RootsModelHeader, body: unknown): Promise<void> {
  const filePath = path.join(rootsStoreDir(yggRoot), MODEL_FILENAME);
  await atomicWriteFile(filePath, canonicalModelJson({ header, body }));
}

/**
 * Read `model.json`. Absent file (a fresh repo, or one that has never run
 * `index`) is valid empty state — returns `undefined`, never throws. A present
 * file must be a JSON object with a `header` mapping and a `body` key of any
 * shape; the header is returned typed (`RootsModelHeader`), the body
 * `unknown` for the caller to narrow into its own concrete type (`MinedModel`,
 * declared where it is produced).
 */
export async function readModel(yggRoot: string): Promise<RootsModel | undefined> {
  const filePath = path.join(rootsStoreDir(yggRoot), MODEL_FILENAME);
  const raw = await readFileOrDefault(filePath, undefined);
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${MODEL_FILENAME} contains unparseable JSON: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.header) || !('body' in parsed)) {
    throw new Error(`${MODEL_FILENAME} does not have the expected { header, body } shape`);
  }
  // Schema version FIRST — a header from another rootsVersion cannot be
  // trusted field-by-field, and this store is committed data, not a
  // rebuildable cache, so a mismatch is loud (an error naming both versions),
  // never a silent misread.
  if (parsed.header.rootsVersion !== ROOTS_VERSION) {
    throw new Error(
      `${MODEL_FILENAME} was written by roots schema version ${String(parsed.header.rootsVersion)}, ` +
        `but this CLI reads version ${ROOTS_VERSION}`,
    );
  }

  return { header: parsed.header as unknown as RootsModelHeader, body: parsed.body };
}

/** Type guard for one committed `seeds.jsonl` line, per spec §17.2's record shape. */
function isSeedEntry(value: unknown): value is SeedEntry {
  if (!isPlainRecord(value)) return false;
  const scopeRef = value.scopeRef;
  return (
    typeof value.seedId === 'string' &&
    isPlainRecord(scopeRef) &&
    typeof scopeRef.path === 'string' &&
    typeof scopeRef.qualifiedName === 'string' &&
    Array.isArray(value.surfaces) &&
    value.surfaces.every((s) => typeof s === 'string') &&
    typeof value.weight === 'number' &&
    typeof value.arch === 'boolean' &&
    (value.note === undefined || typeof value.note === 'string') &&
    typeof value.author === 'string' &&
    typeof value.createdAt === 'string'
  );
}

/**
 * Read the committed `seeds.jsonl` store, typed. Tolerant and fail-open, like
 * every other JSONL sidecar reader in this codebase (e.g.
 * `io/advise-decisions-store.ts`'s `readDecisions`): a missing file yields an
 * empty array, and a non-JSON or mis-shaped line is silently skipped rather
 * than aborting the whole read — a single hand-edited or corrupted line must
 * never make every other maintainer's seed disappear.
 */
export async function readSeeds(yggRoot: string): Promise<SeedEntry[]> {
  const filePath = path.join(rootsStoreDir(yggRoot), SEEDS_FILENAME);
  const raw = await readFileOrDefault(filePath, '');
  const seeds: SeedEntry[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isSeedEntry(parsed)) seeds.push(parsed);
  }
  return seeds;
}

/** Type guard for one committed `ledger.jsonl` line, per spec §18.3's record shape. */
function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!isPlainRecord(value)) return false;
  return typeof value.stableId === 'string' && typeof value.surface === 'string' && typeof value.date === 'string';
}

/**
 * Read the committed `ledger.jsonl` store, typed. Mirrors `readSeeds`'s
 * tolerance exactly (missing file ⇒ empty array; a non-JSON or mis-shaped
 * line is silently skipped rather than aborting the whole read) — this is a
 * hand-editable, committed, merge=union store, the opposite tolerance from
 * `io/roots-history-store.ts`'s machine-written, all-or-nothing replay state.
 */
export async function readLedger(yggRoot: string): Promise<LedgerEntry[]> {
  const filePath = path.join(rootsStoreDir(yggRoot), LEDGER_FILENAME);
  const raw = await readFileOrDefault(filePath, '');
  const entries: LedgerEntry[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isLedgerEntry(parsed)) entries.push(parsed);
  }
  return entries;
}

/**
 * sha256 of a roots store file's raw content (`filename`, relative to
 * `.yggdrasil/roots/`) — an absent file hashes as the empty string, never
 * throws. This is how the model header's `seedsHash` / `decisionsHash` /
 * `ledgerHash` fields are computed: each JSONL store is already
 * canonical-on-write (one complete, self-contained JSON object per appended
 * line), so hashing the file's raw bytes is hashing its canonical content —
 * no parse-then-reserialize step is needed the way `writeModel`'s
 * deep-key-sort is needed for the freeform `model.json` body.
 */
export async function hashStoreFile(yggRoot: string, filename: string): Promise<string> {
  const filePath = path.join(rootsStoreDir(yggRoot), filename);
  const content = await readFileOrDefault(filePath, '');
  return hashString(content);
}
