/**
 * source/cli/src/roots/history-resume.ts — R4 Task 9: the resume/incremental
 * machinery `buildHistoryJoin` (`history.ts`) wires up — split into its own
 * sibling file purely to stay under the reviewer's per-file prompt-size
 * ceiling (`AGENTS.md`'s global-constraints note: "all other new behavior
 * goes in new files... split before crowding the ceiling"); nothing here
 * changes what module OWNS the resume decision, only where its code lives.
 *
 * FOUR THINGS: `computeInputsHash`/`computeCurrentInputsHash` (D2's own
 * ingredient fold — a state's schema version, the extractor version, every
 * REGISTERED grammar's own binding hash, and the canonical `history:` +
 * `include`/`exclude` config subtree); `decideWalkMode`/`resolveWalkMode`
 * (D2's own trigger list — `--full`, active windowing (D3), no usable
 * state, an inputsHash mismatch, or an unreachable `lastIndexedSha` ⇒
 * `'full'`; otherwise `'resume'`); the state ROUND-TRIP (`parseResumeState`
 * and its per-row helpers — deep-parsing a loaded, generically-typed
 * `HistoryState` back into the typed accumulator snapshots
 * `deserializeReplayState`/`deserializeCochangeState` need to resume onto,
 * with R4-I10's own degrade-never-abort rule: any malformed row anywhere
 * falls the whole state back to "unusable", never a partial resume); and
 * `deriveStateEpoch` (D15's own `sha256(stateSchemaVersion || inputsHash ||
 * lastIndexedSha)`).
 *
 * `history.ts` is this file's only production caller — `buildHistoryJoin`
 * calls `resolveWalkMode` once per run, deep-parses onto `parseResumeState`
 * when the verdict is `'resume'`, and calls `deriveStateEpoch` when
 * persisting the new state at the end of a successful walk. Every OTHER
 * export here (`computeInputsHash`, `decideWalkMode`, `isWindowingActive`,
 * `allRegisteredGrammarBindingHashes`, `historyConfigSubtree`) is also
 * called directly by `cli/roots.ts`'s D13 no-op short-circuit, which needs
 * the identical `inputsHash`/walk-mode derivation BEFORE mining ever runs —
 * one derivation, reused by both callers, so they can never silently
 * compute two different notions of "the same inputs".
 */

import { hashString } from '../io/hash.js';
import { readHistoryState, type HistoryState, type HistoryStateMeta } from '../io/roots-history-store.js';
import { isCommitReachable } from '../utils/git-history.js';
import { LANGUAGES } from '../utils/language-registry.js';
import { debugWrite } from '../utils/debug-log.js';
import type { RootsConfig } from '../model/graph.js';
import { assetNameOfWasmFile, bindingForAsset } from './binding.js';
import { EXTRACTOR_VERSION } from './extract.js';
import type { LifecycleRow, ValueEvent, AliasEdge, ReplayStateSnapshot } from './history-replay.js';
import type { CochangeRawPairRow, CochangeRawFileRow } from './history-cochange.js';

// -----------------------------------------------------------------------------
// Resume: inputsHash, decideWalkMode, and the state round-trip (R4 Task 9)
// -----------------------------------------------------------------------------

/**
 * The replay state's own schema version (D15) — a THIRD version notion,
 * independent of both `package.json`'s release version and `ROOTS_VERSION`
 * (D10; that file's own comment carries the identical warning). Folded into
 * `inputsHash` (D2) so a shape change to any of the six persisted files
 * forces a full walk on the next run rather than misreading old-shaped rows
 * under a new reader. Bump this, and only this, whenever a lifecycle field,
 * an alias-edge record, a co-change row, or a `meta.json` field this module
 * reads back changes shape — moving it IS the whole migration, because the
 * state is rebuildable (D15).
 */
export const HISTORY_STATE_SCHEMA_VERSION = 1;

/**
 * Canonical JSON — a SEPARATE, self-contained copy of the identical handful
 * of lines `roots-blob-cache.ts`/`roots-history-store.ts`/`binding.ts`/
 * `roots/config.ts`/`roots/stores.ts` each already keep privately, for the
 * same reason each of those files' own header comments give: `roots-engine`'s
 * `calls` allow-list has no edge to wherever a shared canonical-JSON helper
 * would legally live.
 */
function canonicalJsonForHash(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForHash).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonForHash(v)}`).join(',')}}`;
}

/**
 * D2's four `inputsHash` ingredients, folded exactly as named: the replay
 * state's own schema version, the extractor version, the per-grammar binding
 * hash of every REGISTERED grammar (not only the ones a given repository
 * happens to use — a grammar this repository has never seen yet must still
 * be able to invalidate a stale state the moment it starts mattering), and
 * the canonical `history:` + `include`/`exclude` config subtree (D17:
 * `include`/`exclude` change the WALK's product, not merely the live tree's,
 * so they belong here and nothing else of `RootsConfig` does). A PURE
 * function of its own parameter object — no registry lookup, no disk read —
 * so a unit test can probe each ingredient's own contribution to the hash in
 * isolation (Step 1's composition test, MR-32's own killer) without a real
 * grammar registry or a real config object.
 */
export interface InputsHashIngredients {
  stateSchemaVersion: number;
  extractorVersion: string;
  grammarBindingHashes: Readonly<Record<string, string>>;
  historyConfigSubtree: unknown;
}

export function computeInputsHash(ingredients: InputsHashIngredients): string {
  return hashString(
    canonicalJsonForHash({
      stateSchemaVersion: ingredients.stateSchemaVersion,
      extractorVersion: ingredients.extractorVersion,
      grammarBindingHashes: ingredients.grammarBindingHashes,
      historyConfigSubtree: ingredients.historyConfigSubtree,
    }),
  );
}

/**
 * Every grammar the language registry declares, deduped by asset name (two
 * registry entries — e.g. `typescript`/`tsx` — can share a `wasmPackage` but
 * never a `wasmFile`, so deduping on `assetNameOfWasmFile`'s own result is
 * exact), mapped to its per-grammar `bindingForAsset(...).hash`. A LIVE
 * derivation — reads every grammar's own `node-types.json` once per process,
 * warming the SAME `bindingForAsset` cache every other caller in this file
 * already shares — never a read of only the grammars a particular BUILD
 * happened to use, which is `pipeline.ts`'s own `bindingSetHash` fold and a
 * different question (D13's own comment on why that fold cannot serve this
 * one: it would report `undefined` for every grammar a cold process has not
 * yet warmed).
 */
export function allRegisteredGrammarBindingHashes(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const def of Object.values(LANGUAGES)) {
    const assetName = assetNameOfWasmFile(def.wasmFile);
    if (assetName in result) continue;
    result[assetName] = bindingForAsset(assetName).hash;
  }
  return result;
}

/** D2's canonical `history:` + `include`/`exclude` config subtree — nothing else of `RootsConfig` belongs in `inputsHash` (`enumerate`/`weights`/`cochange`/`partition`/`ledger` never change what a WALK visits or resolves, only how the finished join is later mined). */
export function historyConfigSubtree(config: RootsConfig): unknown {
  return { include: config.include, exclude: config.exclude, history: config.history };
}

/**
 * The live wrapper around `computeInputsHash`: derives all four ingredients
 * from a real `RootsConfig` and the process's own grammar registry. This is
 * what `buildHistoryJoin` (below) and `cli/roots.ts`'s D13 no-op
 * short-circuit both call — one derivation, reused by both, so the two can
 * never silently compute two different notions of "the same inputs".
 */
export function computeCurrentInputsHash(config: RootsConfig): string {
  return computeInputsHash({
    stateSchemaVersion: HISTORY_STATE_SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    grammarBindingHashes: allRegisteredGrammarBindingHashes(),
    historyConfigSubtree: historyConfigSubtree(config),
  });
}

export type WalkMode = 'full' | 'resume';

/**
 * D2's own trigger list, mechanically: `--full`, active windowing (D3), NO
 * usable state (`state === undefined` — already collapses every one of T1's
 * own damage shapes: an absent directory, a missing file, a malformed line,
 * an epoch disagreement — `readHistoryState`'s all-or-nothing contract), an
 * `inputsHash` mismatch, or an unreachable `lastIndexedSha` ⇒ `'full'`;
 * otherwise `'resume'`. These triggers WIDEN, never narrow, the full-walk
 * set (D2) — none of them suppresses a resume the binding "resume from
 * `lastIndexedSha`, full walk only on `--full` or unreachable SHA" clause
 * requires. PURE — every input is a plain value or an injected predicate,
 * never a disk read or a git spawn of its own, so a unit test can flip
 * exactly one trigger per case (Step 1's own requirement) with no fixture
 * repository at all.
 */
export interface DecideWalkModeInputs {
  full: boolean;
  windowingActive: boolean;
  state: HistoryState | undefined;
  currentInputsHash: string;
  isReachable: (sha: string) => boolean;
}

export function decideWalkMode(inputs: DecideWalkModeInputs): WalkMode {
  if (inputs.full) return 'full';
  if (inputs.windowingActive) return 'full';
  if (!inputs.state) return 'full';
  const meta = inputs.state.meta;
  const storedInputsHash = typeof meta.inputsHash === 'string' ? meta.inputsHash : undefined;
  if (storedInputsHash === undefined || storedInputsHash !== inputs.currentInputsHash) return 'full';
  const lastIndexedSha = typeof meta.lastIndexedSha === 'string' ? meta.lastIndexedSha : undefined;
  if (!lastIndexedSha) return 'full';
  if (!inputs.isReachable(lastIndexedSha)) return 'full';
  return 'resume';
}

/** D3: windowing (`history.full: false`, or `maxCommits > 0` even under a full walk) makes the walked set a function of *when you run it*, so it disables resume outright — a resumed walk under either setting would silently mix two windows. */
export function isWindowingActive(config: RootsConfig): boolean {
  return !config.history.full || config.history.maxCommits > 0;
}

/** The resolved walk mode plus everything a caller needed to compute it, so a caller that already paid for `resolveWalkMode` (the D13 short-circuit) never has to re-derive `currentInputsHash` a second, potentially-diverging way. */
export interface ResolvedWalkMode {
  mode: WalkMode;
  state: HistoryState | undefined;
  inputsHash: string;
}

/**
 * The live wrapper around `decideWalkMode`: reads the on-disk replay state
 * (`io/roots-history-store.ts`'s own all-or-nothing contract), derives the
 * current `inputsHash`, and probes reachability through a real git process
 * (`isCommitReachable`) only when every cheaper trigger has already passed —
 * `decideWalkMode`'s own short-circuiting `if` chain means a git spawn never
 * happens for a `--full` run, a windowed run, or a state that is missing,
 * mismatched, or carries no `lastIndexedSha` at all.
 */
export async function resolveWalkMode(repoRoot: string, config: RootsConfig, stateDir: string, full: boolean): Promise<ResolvedWalkMode> {
  const state = await readHistoryState(stateDir);
  const inputsHash = computeCurrentInputsHash(config);
  const mode = decideWalkMode({
    full,
    windowingActive: isWindowingActive(config),
    state,
    currentInputsHash: inputsHash,
    isReachable: (sha) => isCommitReachable(repoRoot, sha),
  });
  return { mode, state, inputsHash };
}

// -----------------------------------------------------------------------------
// The state round-trip: parsing a loaded HistoryState's generic `unknown[]`
// rows back into the typed shapes `replayCommit`/`accumulateCochange` need to
// resume onto, and assembling the state `buildHistoryJoin` persists at the
// end of a successful walk (D1's six files, D15's epoch envelope).
// -----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `LifecycleRow`'s own shape, read back from a persisted `lifecycle.jsonl`
 * line — every field this module ever wrote, nothing more. `undefined` on
 * the first field that fails, which the caller (`parseResumeState`) turns
 * into a whole-state fallback to a full walk (R4-I10: a resume that cannot
 * trust its own loaded rows must never guess at a partial one).
 */
function parseLifecycleRow(raw: unknown): LifecycleRow | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.key !== 'string') return undefined;
  if (raw.level !== 'scope' && raw.level !== 'file') return undefined;
  if (typeof raw.firstSeenTs !== 'number') return undefined;
  if (raw.firstModifiedTs !== null && typeof raw.firstModifiedTs !== 'number') return undefined;
  if (typeof raw.lastModifiedTs !== 'number') return undefined;
  if (typeof raw.modifications !== 'number') return undefined;
  if (typeof raw.churnedEarly !== 'boolean') return undefined;
  if (typeof raw.fixTouches !== 'number') return undefined;
  if (raw.authorKind !== 'human' && raw.authorKind !== 'agent') return undefined;
  if (typeof raw.lastTouchSha !== 'string') return undefined;
  if (raw.lastHumanCommitTs !== null && typeof raw.lastHumanCommitTs !== 'number') return undefined;
  return {
    key: raw.key,
    level: raw.level,
    firstSeenTs: raw.firstSeenTs,
    firstModifiedTs: raw.firstModifiedTs as number | null,
    lastModifiedTs: raw.lastModifiedTs,
    modifications: raw.modifications,
    churnedEarly: raw.churnedEarly,
    fixTouches: raw.fixTouches,
    authorKind: raw.authorKind,
    lastTouchSha: raw.lastTouchSha,
    lastHumanCommitTs: raw.lastHumanCommitTs as number | null,
  };
}

function parseValueTuple(raw: unknown): ValueEvent['value'] | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.nameShape !== 'string') return undefined;
  if (raw.firstStatementType !== null && typeof raw.firstStatementType !== 'string') return undefined;
  if (raw.returnShape !== null && typeof raw.returnShape !== 'string') return undefined;
  const strArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (!strArray(raw.decorators) || !strArray(raw.supertypes) || !strArray(raw.nodeTypesSeen) || !strArray(raw.calleeTexts)) return undefined;
  return {
    nameShape: raw.nameShape,
    firstStatementType: raw.firstStatementType as string | null,
    returnShape: raw.returnShape as string | null,
    decorators: raw.decorators,
    supertypes: raw.supertypes,
    nodeTypesSeen: raw.nodeTypesSeen,
    calleeTexts: raw.calleeTexts,
  };
}

function parseValueEvent(raw: unknown): ValueEvent | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.key !== 'string') return undefined;
  if (typeof raw.ts !== 'number') return undefined;
  if (raw.kind !== 'introduction' && raw.kind !== 'change') return undefined;
  const value = parseValueTuple(raw.value);
  if (!value) return undefined;
  if (typeof raw.authorHash !== 'string') return undefined;
  if (raw.authorKind !== 'human' && raw.authorKind !== 'agent') return undefined;
  if (typeof raw.sha !== 'string') return undefined;
  return { key: raw.key, ts: raw.ts, kind: raw.kind, value, authorHash: raw.authorHash, authorKind: raw.authorKind, sha: raw.sha };
}

function parseAliasEdge(raw: unknown): AliasEdge | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.from !== 'string' || typeof raw.to !== 'string') return undefined;
  if (typeof raw.ts !== 'number' || typeof raw.sha !== 'string') return undefined;
  return { from: raw.from, to: raw.to, ts: raw.ts, sha: raw.sha };
}

/**
 * `cochange-raw.jsonl`'s two blocks (D1), disambiguated by which field each
 * row carries — `support` for a pair row, `commits` for a per-file row —
 * rather than by array position, so the split is robust to exactly how the
 * two blocks were concatenated on disk.
 */
function parseCochangeRawRows(rows: readonly unknown[]): { pairs: CochangeRawPairRow[]; fileCommits: CochangeRawFileRow[] } | undefined {
  const pairs: CochangeRawPairRow[] = [];
  const fileCommits: CochangeRawFileRow[] = [];
  for (const raw of rows) {
    if (!isRecord(raw)) return undefined;
    if (typeof raw.support === 'number') {
      if (typeof raw.a !== 'string' || typeof raw.b !== 'string') return undefined;
      pairs.push({ a: raw.a, b: raw.b, support: raw.support });
    } else if (typeof raw.commits === 'number') {
      if (typeof raw.path !== 'string') return undefined;
      fileCommits.push({ path: raw.path, commits: raw.commits });
    } else {
      return undefined;
    }
  }
  return { pairs, fileCommits };
}

/** `meta.json`'s two rosters (D1: "the persisted form of the two `buildHistoryJoin` already returns" — `blobShas`/`parsedKeys`) plus the running commit total `historyStats.commits` needs (D4) — the ONE quantity no persisted roster derives, since no file records which commit shas were ever walked. */
interface ParsedMetaRosters {
  blobShas: Set<string>;
  parsedKeys: Map<string, number>;
  commitsAccumulated: number;
}

function parseMetaRosters(meta: HistoryStateMeta): ParsedMetaRosters | undefined {
  const blobShasRaw = meta.blobShas;
  if (!Array.isArray(blobShasRaw) || !blobShasRaw.every((v) => typeof v === 'string')) return undefined;
  const parsedKeysRaw = meta.parsedKeys;
  if (!Array.isArray(parsedKeysRaw)) return undefined;
  const parsedKeys = new Map<string, number>();
  for (const entry of parsedKeysRaw) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'number') return undefined;
    parsedKeys.set(entry[0], entry[1]);
  }
  if (typeof meta.commitsAccumulated !== 'number') return undefined;
  return { blobShas: new Set(blobShasRaw as string[]), parsedKeys, commitsAccumulated: meta.commitsAccumulated };
}

/** Deep-parse a loaded `HistoryState` into everything a resume needs to reconstruct the replay/co-change accumulators and the two rosters — `undefined` on the FIRST malformed row anywhere, which the caller treats exactly like `decideWalkMode`'s own "no usable state" verdict. Unreachable in ordinary operation — `HISTORY_STATE_SCHEMA_VERSION` is folded into `inputsHash`, so a shape this parser cannot read already failed `decideWalkMode`'s own inputsHash comparison before this function is ever called — this is belt-and-suspenders against a hand-edited or otherwise corrupted state that happens to keep the same epoch and schema version. */
export interface ParsedResumeState {
  replaySnapshot: ReplayStateSnapshot;
  cochangeSnapshot: { pairs: CochangeRawPairRow[]; fileCommits: CochangeRawFileRow[] };
  rosters: ParsedMetaRosters;
  lastIndexedSha: string;
}

export function parseResumeState(state: HistoryState): ParsedResumeState | undefined {
  const lifecycle: LifecycleRow[] = [];
  for (const raw of state.lifecycle) {
    const row = parseLifecycleRow(raw);
    if (!row) {
      debugWrite('[roots-history] resume state: a lifecycle.jsonl row failed to parse — falling back to a full walk');
      return undefined;
    }
    lifecycle.push(row);
  }
  const events: ValueEvent[] = [];
  for (const raw of state.events) {
    const event = parseValueEvent(raw);
    if (!event) {
      debugWrite('[roots-history] resume state: an events.jsonl row failed to parse — falling back to a full walk');
      return undefined;
    }
    events.push(event);
  }
  const aliases: AliasEdge[] = [];
  for (const raw of state.aliases) {
    const edge = parseAliasEdge(raw);
    if (!edge) {
      debugWrite('[roots-history] resume state: an aliases.jsonl row failed to parse — falling back to a full walk');
      return undefined;
    }
    aliases.push(edge);
  }
  const cochangeSnapshot = parseCochangeRawRows(state.cochangeRaw);
  if (!cochangeSnapshot) {
    debugWrite('[roots-history] resume state: a cochange-raw.jsonl row failed to parse — falling back to a full walk');
    return undefined;
  }
  const rosters = parseMetaRosters(state.meta);
  if (!rosters) {
    debugWrite('[roots-history] resume state: meta.json is missing a roster or the commit total — falling back to a full walk');
    return undefined;
  }
  const lastIndexedSha = typeof state.meta.lastIndexedSha === 'string' ? state.meta.lastIndexedSha : undefined;
  if (!lastIndexedSha) {
    debugWrite('[roots-history] resume state: meta.json has no lastIndexedSha — falling back to a full walk');
    return undefined;
  }
  return { replaySnapshot: { lifecycle, events, aliases }, cochangeSnapshot, rosters, lastIndexedSha };
}

/** `sha256(stateSchemaVersion || inputsHash || lastIndexedSha)` — D15's own derived epoch, folded across all six files at write time so `readHistoryState` can catch a torn set on the next read. Pipe-separated (never a bare space) so the three fields can never run together ambiguously: a schema-version integer and a 64-hex-char sha never contain `|` themselves. */
export function deriveStateEpoch(stateSchemaVersion: number, inputsHash: string, lastIndexedSha: string): string {
  return hashString(`${stateSchemaVersion}|${inputsHash}|${lastIndexedSha}`);
}
