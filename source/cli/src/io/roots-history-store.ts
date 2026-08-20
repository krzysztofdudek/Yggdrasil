/**
 * source/cli/src/io/roots-history-store.ts — the D1 replay-state store, under
 * a caller-supplied directory (`rootsHistoryStateDir`, `roots/stores.ts`:
 * `.yggdrasil/roots/.cache/history/`). Six files, read and written as ONE SET
 * (D15): `lifecycle.jsonl`, `events.jsonl`, `aliases.jsonl`,
 * `cochange-raw.jsonl`, `cochange.jsonl` — the replay's raw, unresolved
 * ACCUMULATORS (D1) — and `meta.json`, which carries the state schema
 * version, the write run's derived `stateEpoch` (D15), and every other
 * quantity the engine layer accumulates (`lastIndexedSha`, `inputsHash`, the
 * two blob/key rosters, the running `historyStats` sums, the per-file
 * appearance counters). GENERIC over every record shape, exactly like
 * `roots-blob-cache.ts` and `roots/stores.ts`'s `RootsModel<TBody>`: this
 * file knows only the epoch envelope every one of the six carries, never the
 * concrete lifecycle/event/alias/co-change row shapes (a later roots module's
 * concern).
 *
 * ALL-OR-NOTHING ON DAMAGE — the deliberately OPPOSITE tolerance from
 * `roots-blob-cache.ts`'s per-record miss. The blob cache's records are each
 * independently re-derivable from a blob sha the walk can re-fetch; this
 * state's six files are a DAG'd, mutually-dependent replay position — a
 * lifecycle row without its matching `meta.json` `lastIndexedSha` is not a
 * smaller correct answer, it is a wrong one (silently doubled `modifications`,
 * `support`, `historyStats` sums — D15's whole motivation). So any one of:
 * the directory being entirely absent; any one of the six files missing while
 * the directory exists; a malformed line anywhere in any of the six; or a
 * `stateEpoch`/schema-version disagreement across the six stored copies
 * (compared, NEVER re-derived — D15's own reasoning: a reader that
 * recomputed the epoch from `meta.json`'s own fields would validate a
 * hand-edited `meta.json` against itself and could never catch the torn-write
 * shape this store exists to catch) — makes `readHistoryState` report NO
 * USABLE STATE FOR THE WHOLE DIRECTORY, `undefined`, never a partial load.
 * `readSeeds`/`readDecisions`'s per-line skip (`roots/stores.ts:211-227`) is
 * the wrong precedent here on purpose: those are hand-editable COMMITTED
 * stores where one bad line must not erase everyone else's; this state is
 * machine-written, gitignored, and internally coupled, so a silently skipped
 * line would fail R4-I2's byte-identity invisibly instead of loudly.
 *
 * WRITE ORDER is fixed and load-bearing (D15): the five accumulators land
 * first, `meta.json` last. A process killed between them leaves the
 * accumulators carrying the NEW epoch and `meta.json` still carrying the OLD
 * one — caught by the epoch comparison above, not by a missing-file check,
 * which is exactly why the epoch check exists independently of the
 * missing-file check.
 *
 * SORT ORDERS are the caller's responsibility, stated here because R4-I2's
 * byte-identity claim covers all six files and nothing else in this codebase
 * fixes them (T5's own sort-order comments cover `finishReplay`'s DERIVED
 * output only, which D1 says is never persisted): `lifecycle.jsonl` by `key`
 * then `level` (`'file'` before `'scope'`); `events.jsonl` by
 * `(ts, key, kind, sha)`; `aliases.jsonl` by `(ts, sha, from)`;
 * `cochange-raw.jsonl` in two blocks — every pair row by `(a, b)`, then every
 * per-file commit-count row by path; `cochange.jsonl` in the emitted cut's
 * own order (descending support, ties by `a` then `b`). This module writes
 * each array's elements in EXACTLY the order the caller supplies (arrays keep
 * their element order, matching `roots/stores.ts`'s own `sortKeysDeep`
 * precedent, which sorts object keys but never reorders an array) — it never
 * re-sorts, so a caller that violates one of these orders produces a
 * non-byte-identical state silently rather than being caught here.
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFile } from './atomic-write.js';
import { debugWrite } from '../utils/debug-log.js';

export const HISTORY_LIFECYCLE_FILENAME = 'lifecycle.jsonl';
export const HISTORY_EVENTS_FILENAME = 'events.jsonl';
export const HISTORY_ALIASES_FILENAME = 'aliases.jsonl';
export const HISTORY_COCHANGE_RAW_FILENAME = 'cochange-raw.jsonl';
export const HISTORY_COCHANGE_FILENAME = 'cochange.jsonl';
export const HISTORY_META_FILENAME = 'meta.json';

/**
 * `meta.json`'s shape, generic beyond the epoch envelope every reader needs
 * to validate the state as a set. `stateSchemaVersion` and `stateEpoch` sit
 * beside `lastIndexedSha`, `inputsHash`, the two rosters and the running
 * `historyStats` sums (D1) — all of those are the caller's concern (a later
 * roots module) and pass through this store untyped, the same way
 * `RootsModel<TBody>`'s body passes through `roots/stores.ts` untyped.
 */
export interface HistoryStateMeta {
  stateSchemaVersion: number;
  stateEpoch: string;
  [key: string]: unknown;
}

/** The six-file replay state (D1), read or written as one set (D15). */
export interface HistoryState {
  meta: HistoryStateMeta;
  lifecycle: unknown[];
  events: unknown[];
  aliases: unknown[];
  cochangeRaw: unknown[];
  cochange: unknown[];
}

/**
 * Serialize any JSON-representable value to canonical JSON: sorted keys,
 * `undefined` dropped, no inserted whitespace. A SEPARATE, self-contained
 * copy of `roots-blob-cache.ts`'s own — see that file's identical header
 * comment for why persistence-adapter cannot import a shared one.
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEpochHeader(value: unknown): value is { stateEpoch: string; stateSchemaVersion: number } {
  return isPlainRecord(value) && typeof value.stateEpoch === 'string' && typeof value.stateSchemaVersion === 'number';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Write one JSONL channel: an epoch-header line (`{stateEpoch,
 * stateSchemaVersion}`) followed by one canonical-JSON line per record, in
 * the caller's own order. Every line ends with `\n`; the whole content is one
 * `write` call so a reader never observes a torn individual file (per-file
 * atomicity — D15's point is that per-file atomicity alone is not enough for
 * the SET, which is why the epoch envelope exists).
 */
async function writeJsonlChannel(
  filePath: string,
  meta: HistoryStateMeta,
  records: readonly unknown[],
  write: (filePath: string, content: string) => Promise<void>,
): Promise<void> {
  const header = canonicalJson({ stateEpoch: meta.stateEpoch, stateSchemaVersion: meta.stateSchemaVersion });
  const lines = [header, ...records.map(canonicalJson)];
  await write(filePath, `${lines.join('\n')}\n`);
}

export interface WriteHistoryStateOptions {
  /**
   * Injectable atomic writer, applied to all six files (five channels plus
   * `meta.json`). Default `atomicWriteFile`. Exists for two killer tests
   * that have no portable, root-safe OS-level equivalent in this repo's
   * commit-gate container: R4-I10's write-failure degrade (a wrapper that
   * throws) and D15's fixed write order (a wrapper that records call order —
   * five accumulator paths, then `meta.json`, never the reverse). Same idiom
   * as `roots-build-lock-store.ts`'s injected `now`/`sleep`/`unlink`.
   */
  write?: (filePath: string, content: string) => Promise<void>;
}

/**
 * Write the six-file state as a set: the five accumulators first (order
 * among those five is immaterial — D15 only requires all five before
 * `meta.json`), `meta.json` last. Every write is independently best-effort
 * (R4-I10): a failure on any one file is one `debugWrite` and the others are
 * still attempted, since a torn write is exactly the shape `readHistoryState`
 * exists to detect on the next run — a state directory left holding some of
 * its six files and not others costs one full walk and can never produce a
 * wrong model.
 */
export async function writeHistoryState(dir: string, state: HistoryState, options: WriteHistoryStateOptions = {}): Promise<void> {
  const write = options.write ?? atomicWriteFile;
  const channels: Array<[string, unknown[]]> = [
    [path.join(dir, HISTORY_LIFECYCLE_FILENAME), state.lifecycle],
    [path.join(dir, HISTORY_EVENTS_FILENAME), state.events],
    [path.join(dir, HISTORY_ALIASES_FILENAME), state.aliases],
    [path.join(dir, HISTORY_COCHANGE_RAW_FILENAME), state.cochangeRaw],
    [path.join(dir, HISTORY_COCHANGE_FILENAME), state.cochange],
  ];
  for (const [filePath, records] of channels) {
    try {
      await writeJsonlChannel(filePath, state.meta, records, write);
    } catch (e) {
      debugWrite(`[roots-history-store] write failed for ${filePath}: ${errMsg(e)}`);
    }
  }
  const metaPath = path.join(dir, HISTORY_META_FILENAME);
  try {
    await write(metaPath, canonicalJson(state.meta));
  } catch (e) {
    debugWrite(`[roots-history-store] write failed for ${metaPath}: ${errMsg(e)}`);
  }
}

/** One channel's parsed result: the epoch header plus its data records, in file order. */
interface ParsedChannel {
  header: { stateEpoch: string; stateSchemaVersion: number };
  records: unknown[];
}

/**
 * Parse one JSONL channel. Returns `undefined` on ANY malformation — an
 * empty file, an invalid header line, or any unparseable data line — logging
 * exactly one `debugWrite` naming the file and the offending line number.
 */
function readJsonlChannel(filePath: string, label: string): ParsedChannel | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    debugWrite(`[roots-history-store] unreadable ${label}: ${errMsg(e)}`);
    return undefined;
  }

  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) {
    debugWrite(`[roots-history-store] ${label} has no epoch-header line`);
    return undefined;
  }

  let headerParsed: unknown;
  try {
    headerParsed = JSON.parse(lines[0]);
  } catch (e) {
    debugWrite(`[roots-history-store] ${label} line 1 (epoch header) is unparseable: ${errMsg(e)}`);
    return undefined;
  }
  if (!isEpochHeader(headerParsed)) {
    debugWrite(`[roots-history-store] ${label} line 1 is not a valid epoch header`);
    return undefined;
  }

  const records: unknown[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch (e) {
      debugWrite(`[roots-history-store] ${label} line ${i + 1} is malformed: ${errMsg(e)}`);
      return undefined;
    }
  }
  return { header: headerParsed, records };
}

/**
 * Read the six-file replay state as one set. Returns `undefined` — "no
 * usable state", never a partial one — on:
 *   - the state directory being absent entirely (the ordinary "never
 *     indexed" case; silent, matching `roots/stores.ts`'s `readModel`
 *     precedent for a fresh project — not a degradation, so no `debugWrite`);
 *   - any one of the six files missing while the directory exists (R4-I10's
 *     failed-write shape; one `debugWrite` naming which);
 *   - a malformed line anywhere in any of the six (each parse helper logs
 *     its own line);
 *   - a `stateEpoch` or schema-version disagreement across the six stored
 *     copies (D15) — compared across the six, never re-derived from
 *     `meta.json`'s own fields alone.
 */
export async function readHistoryState(dir: string): Promise<HistoryState | undefined> {
  if (!existsSync(dir)) return undefined;

  const paths = {
    lifecycle: path.join(dir, HISTORY_LIFECYCLE_FILENAME),
    events: path.join(dir, HISTORY_EVENTS_FILENAME),
    aliases: path.join(dir, HISTORY_ALIASES_FILENAME),
    cochangeRaw: path.join(dir, HISTORY_COCHANGE_RAW_FILENAME),
    cochange: path.join(dir, HISTORY_COCHANGE_FILENAME),
    meta: path.join(dir, HISTORY_META_FILENAME),
  };

  const missing = Object.entries(paths)
    .filter(([, p]) => !existsSync(p))
    .map(([name]) => name);
  if (missing.length > 0) {
    debugWrite(`[roots-history-store] ${dir} is missing state file(s): ${missing.join(', ')}`);
    return undefined;
  }

  const lifecycle = readJsonlChannel(paths.lifecycle, HISTORY_LIFECYCLE_FILENAME);
  const events = readJsonlChannel(paths.events, HISTORY_EVENTS_FILENAME);
  const aliases = readJsonlChannel(paths.aliases, HISTORY_ALIASES_FILENAME);
  const cochangeRaw = readJsonlChannel(paths.cochangeRaw, HISTORY_COCHANGE_RAW_FILENAME);
  const cochange = readJsonlChannel(paths.cochange, HISTORY_COCHANGE_FILENAME);
  if (!lifecycle || !events || !aliases || !cochangeRaw || !cochange) return undefined;

  let metaRaw: string;
  try {
    metaRaw = readFileSync(paths.meta, 'utf-8');
  } catch (e) {
    debugWrite(`[roots-history-store] unreadable ${HISTORY_META_FILENAME}: ${errMsg(e)}`);
    return undefined;
  }
  let metaParsed: unknown;
  try {
    metaParsed = JSON.parse(metaRaw);
  } catch (e) {
    debugWrite(`[roots-history-store] ${HISTORY_META_FILENAME} is unparseable: ${errMsg(e)}`);
    return undefined;
  }
  if (!isEpochHeader(metaParsed)) {
    debugWrite(`[roots-history-store] ${HISTORY_META_FILENAME} is not a valid state (missing epoch fields)`);
    return undefined;
  }

  const headers = [lifecycle.header, events.header, aliases.header, cochangeRaw.header, cochange.header, metaParsed];
  const [first, ...rest] = headers;
  const agree = rest.every((h) => h.stateEpoch === first.stateEpoch && h.stateSchemaVersion === first.stateSchemaVersion);
  if (!agree) {
    debugWrite(`[roots-history-store] ${dir} state epoch disagreement across the six stored files — torn or stale write`);
    return undefined;
  }

  return {
    meta: metaParsed as HistoryStateMeta,
    lifecycle: lifecycle.records,
    events: events.records,
    aliases: aliases.records,
    cochangeRaw: cochangeRaw.records,
    cochange: cochange.records,
  };
}
