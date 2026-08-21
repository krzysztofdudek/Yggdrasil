/**
 * source/cli/src/roots/pipeline.ts — the async composition Task 6 dictates:
 * `parseAndExtractAll` (the walk + filter + parse + extract PREFIX, exported
 * on its own so Task 7's null control and any future incremental-mining
 * caller compose the REAL filters instead of re-implementing them) and
 * `runRootsIndex` (the full pure-stage chain, R1's defaults constructed
 * here, ending at `mine`). Neither function persists — `stores.ts` writes
 * nothing here; the (later) `yg roots index` command composes this module's
 * output with `stores.ts` itself (Task 1's seam: engine never imports the
 * store).
 */

import path from 'node:path';
import type { Tree } from '../ast/types.js';
import { withParsedFile } from '../ast/parser.js';
import { getGrammarForExtension } from '../utils/language-registry.js';
import { walkRepoFiles } from '../io/repo-scanner.js';
import { readTextFile } from '../io/graph-fs.js';
import type { RootsConfig, SeedEntry } from '../model/graph.js';
import { assetNameOfWasmFile, bindingForAsset, type RootsBinding } from './binding.js';
import { extractUnits, finalizeUnits, type RawScope, type ScopeUnit, type ExtractOptions } from './extract.js';
import { derivePartitions, makeRootsFileFilters, type PartitionMap } from './partitions.js';
import { buildVocabularies, enumerate, type FeatureBag, type DomainMap, type RootsVocabularies } from './enumerate.js';
import { induceRoles, type WeightFn } from './roles.js';
import { mine, type MinedModel, type AgeFn } from './mine.js';
import { hashString } from '../io/hash.js';
import { buildHistoryJoin, projectCouplingForPartition, type HistoryDeps, type HistoryJoin, type HistoryProgressInfo } from './history.js';
import { makeWeightFns, releasedMarks, markKey, type LifecycleIndex } from './weights.js';
import type { LifecycleRow } from './history-replay.js';

/**
 * §6.1's SECOND size gate (the first is `history.blobMaxBytes`, configurable):
 * a file over this many lines is excluded before parsing regardless of its
 * byte count, matching the prototype's own size guard
 * (`prototype-roots2.mjs:418`). Fixed, never config — exported so `history.ts`
 * (Task 4) applies the IDENTICAL threshold to a historical blob, which R4-I7
 * requires: the live and historical passes must admit the same file set, or a
 * blob the live pass would never parse could still acquire historical scopes
 * that join nothing (R4-I7 header note, `history.ts`).
 */
export const MAX_PARSE_LINES = 40000;

/** Minimal degenerate `RawScope` for the one file-level defense this pipeline takes beyond `extractUnits`' own §6.1 error tolerance — see `parseAndExtractAll`'s own comment for when this is reached (it very rarely is: tree-sitter's error recovery means `extractUnits` almost always still runs, and DOES already degrade a root-parse-error file to file granularity on its own). */
function minimalFileScope(relPath: string, binding: RootsBinding): RawScope {
  const name = path.posix.basename(relPath);
  return {
    kind: 'file',
    relPath,
    name,
    qualifiedName: name,
    ordinal: 0,
    arity: 0,
    hasParameterList: false,
    startRow: 0,
    supertypes: [],
    decorators: [],
    grammarHasDecoratorTypes: binding.decorators.length > 0,
    grammarHasHeritageCandidacy: false,
    grammarNodeTypeVocabulary: binding.nodeTypeVocabulary,
    fileImports: [],
    calleeTexts: [],
    nodeTypesSeen: [],
    statementShapes: [],
    localVarNames: [],
    firstStatementType: undefined,
    lastReturnExprType: undefined,
    hasReturnStatement: false,
    bodyStatementCount: 0,
  };
}

/**
 * The walk + filter + parse + extract PREFIX (spec §6.1's robustness rules,
 * `v6-spec.md:222`, read in full): lists the repo (persistence-adapter's
 * `walkRepoFiles`, gitignore-aware), applies the marker-scan filter
 * (`forMarkers` — merged built-in + config exclusions ONLY, spec §6.6 step 1)
 * to produce the listing `derivePartitions` consumes, then additionally
 * applies `forParsing` (`include` ∧ exclusions) AND a registered-grammar
 * check (registry lookup BEFORE parsing — `getParser` throwing on an unknown
 * extension is never the filter) to the PARSE set. Per file: oversize
 * (> `history.blobMaxBytes` bytes OR > 40000 lines) is EXCLUDED before
 * parsing — no scopes at all, not even the file scope, matching the
 * prototype's own size guard (`prototype-roots2.mjs:418`). Otherwise parses
 * via `withParsedFile` and calls `extractUnits`, which already tolerates
 * ERROR/MISSING nodes on its own (a root-level error degrades to the file
 * scope alone, per its own contract) — this function NEVER aborts on a file
 * (I1): the try/catch below is defense against a genuinely unexpected
 * exception (e.g. a WASM boundary failure), degrading THAT file to a
 * synthesized file-only scope rather than losing the whole index.
 */
export async function parseAndExtractAll(repoRoot: string, config: RootsConfig): Promise<{ files: string[]; rawScopes: RawScope[] }> {
  const allFiles = await walkRepoFiles(repoRoot);
  const filters = makeRootsFileFilters(config);
  const files = allFiles.filter(filters.forMarkers);

  const extractOptions: ExtractOptions = {
    shapeDepth: config.enumerate.shapeDepth,
    shapeMaxStatements: config.enumerate.shapeMaxStatements,
    localVarSampleMax: config.enumerate.localVarSampleMax,
  };
  const rawScopes: RawScope[] = [];
  for (const relPath of files) {
    if (!filters.forParsing(relPath)) continue;
    const grammarInfo = getGrammarForExtension(path.extname(relPath));
    if (!grammarInfo) continue; // no registered grammar — not a parse candidate (registry lookup, never a getParser throw, is the filter)

    const content = await readTextFile(path.join(repoRoot, relPath));
    if (Buffer.byteLength(content, 'utf8') > config.history.blobMaxBytes) continue; // §6.1 oversize — excluded before parsing
    if (content.split('\n').length > MAX_PARSE_LINES) continue;

    const { binding } = bindingForAsset(assetNameOfWasmFile(grammarInfo.wasmFile));
    try {
      const scopes = await withParsedFile(relPath, content, (tree: Tree) => extractUnits(relPath, content, tree, binding, extractOptions));
      rawScopes.push(...scopes);
    } catch {
      // Never abort the pipeline on one file (I1) — degrade to file granularity.
      rawScopes.push(minimalFileScope(relPath, binding));
    }
  }

  return { files, rawScopes };
}

/**
 * The all-grammar fold (spec `:137`/`:237`): sha256 over the sorted
 * `assetName -> per-grammar bindingHash` map of every grammar this build's
 * PARSE-CANDIDATE set actually names — the model header's `bindingHash`
 * field (R4 Task 9). Lifted out of `runRootsIndex` (below) into its own
 * standalone function, over `(repoRoot, config)` alone, so `cli/roots.ts`'s
 * D13 no-op short-circuit can compute this SAME value BEFORE mining ever
 * runs — `bindingHash` used to be `runRootsIndex`'s own *output*
 * (`result.bindingSetHash`), with no cheap pre-pass that produced it, which
 * made a pre-mining input comparison unimplementable.
 *
 * THIS IS A RE-SPECIFICATION, NOT A COPY OF THE LANDED FOLD, and the
 * difference is the whole point. As landed inline, the fold walked the parse
 * set and then *looked each asset up in `binding.ts`'s module-level cache*
 * (`cachedBindingHashFor`), which only `bindingForAsset` fills and which
 * `parseAndExtractAll` fills earlier in the SAME call, only for assets that
 * got past its `blobMaxBytes` and `MAX_PARSE_LINES` gates. Lifted verbatim
 * and called COLD — which is exactly how the short-circuit calls it — every
 * lookup would miss, the map would be empty, the fold would hash `"{}"`, and
 * D13's condition 1 could never hold. So this function owns its OWN pass —
 * `walkRepoFiles` → `forMarkers` → `forParsing` → `getGrammarForExtension` →
 * `assetNameOfWasmFile` — and DERIVES each used asset's binding through the
 * shared `bindingForAsset` (which itself warms `binding.ts`'s cache, so a
 * later reader of that cache in the SAME process still sees these entries —
 * this function is cache-*warming*, never cache-*reading*), so it returns
 * the SAME hash on a cold process and a warm one.
 *
 * NAME THE ONE BEHAVIORAL DIFFERENCE RATHER THAN CLAIMING THERE IS NONE. The
 * used-asset set here is the *parse-candidate* set (every asset with >= 1
 * file passing `forParsing`) instead of the *actually-parsed* set (every
 * asset with >= 1 file that survived `parseAndExtractAll`'s oversize/
 * max-lines gates, which need a file's own bytes in hand and are
 * deliberately NOT re-applied here — this function never reads a file's
 * content, only its path). The two differ only for a repository in which
 * EVERY candidate file of some grammar is over `blobMaxBytes` or over
 * `MAX_PARSE_LINES` — in which case that grammar's hash now enters the fold
 * where it previously did not, and the header's `bindingHash` changes. That
 * is a deliberate, stated change, and it is the RIGHT direction: the header
 * describes which grammars this repository's source WOULD BE READ WITH, not
 * which ones happened to survive a size gate. Report it; "unchanged
 * byte-for-byte" would be false.
 *
 * `runRootsIndex` (below) calls this SAME function instead of running the
 * loop inline, so there is exactly one definition — the lift replaced that
 * inline loop and touched nothing else in this file.
 */
export async function computeUsedGrammarSetHash(repoRoot: string, config: RootsConfig): Promise<string> {
  const allFiles = await walkRepoFiles(repoRoot);
  const filters = makeRootsFileFilters(config);
  const usedAssetHashes: Record<string, string> = {};
  for (const relPath of allFiles) {
    if (!filters.forMarkers(relPath)) continue;
    if (!filters.forParsing(relPath)) continue;
    const grammarInfo = getGrammarForExtension(path.extname(relPath));
    if (!grammarInfo) continue;
    const assetName = assetNameOfWasmFile(grammarInfo.wasmFile);
    if (assetName in usedAssetHashes) continue;
    usedAssetHashes[assetName] = bindingForAsset(assetName).hash;
  }
  return hashString(JSON.stringify(usedAssetHashes, Object.keys(usedAssetHashes).sort()));
}

export interface RootsIndexResult {
  body: MinedModel;
  /** sha256 over the sorted `assetName -> per-grammar bindingHash` map of every grammar this build actually used — the ALL-GRAMMAR fold spec `:137`/`:237` define; this is what the model header's `bindingHash` field stores (never the per-grammar hash alone). */
  bindingSetHash: string;
  candidateCountLog2: number;
}

/**
 * The four-argument form's own options (R4 Task 8). `historyDeps` absent ⇒
 * exactly today's degraded behavior: constant `noLifecycleWeight` weights, no
 * `AgeFn`, no history-fed model field — the degraded path, not the golden
 * one (`history.ts`'s own header explains why). `onProgress` is FORWARDED
 * into `buildHistoryJoin` even though nothing emits on it until T9's own
 * walk-progress reporting — every quantity that will ride on it is knowable
 * only inside `buildHistoryJoin`, so wiring the forward here (rather than
 * widening this file a second time in T9) costs one parameter now, for a
 * capability T9 fills in later.
 */
export interface RunRootsIndexOptions {
  historyDeps?: HistoryDeps;
  onProgress?: (info: HistoryProgressInfo) => void;
}

/**
 * The REAL, skeyR/relPath-keyed lifecycle index `makeWeightFns` reads —
 * `LifecycleRow.key` IS `skeyR` for a scope-level row (`history-replay.ts`'s
 * own `${postPath}#${kind}#${qualifiedName}` construction) and the bare
 * `relPath` for a file-level one, so a two-step `Map` lookup on `key` alone
 * answers `rowFor(skeyR, relPath)` without needing two tables — the two key
 * spaces are disjoint by construction (`LifecycleRow.key`'s own doc).
 */
export function makeLifecycleIndex(rows: readonly LifecycleRow[]): LifecycleIndex {
  const byKey = new Map<string, LifecycleRow>();
  for (const row of rows) byKey.set(row.key, row);
  return {
    rowFor(skeyR: string, relPath: string): LifecycleRow | undefined {
      return byKey.get(skeyR) ?? byKey.get(relPath);
    },
  };
}

/**
 * Exported (alongside `makeLifecycleIndex`) so the killer test for this exact
 * seam (`tests/unit/roots/history-join.test.ts`) can drive it directly
 * against a REAL `HistoryJoin`, rather than only through `runRootsIndex`'s
 * own opaque `MinedModel` output.
 *
 * THE HAZARD SEAM (weights.ts's own doc on `releasedMarks`): a `LedgerEntry`
 * carries only the marked scope's CURRENT `stable_id` (D6) — never a
 * `skeyR`/`relPath` pair — so resolving a mark to a lifecycle row means
 * mapping `stable_id -> ScopeUnit` over the CURRENT tree's own `units`
 * first, THEN resolving that unit's `(skeyR, relPath)` through the REAL
 * index above. A `LifecycleIndex` keyed DIRECTLY on `stable_id` (skipping
 * this resolution) would never match any lifecycle row at all — `stable_id`
 * folds `partitionId`, which no `LifecycleRow` carries — so no mark would
 * ever release, indistinguishable from the documented conservative "marks
 * the walk cannot see stay capped" path. This function is the one place that
 * resolution happens, aliases followed for free (the REAL index's own
 * lookup already resolves through the current tree's own units).
 */
export function makeStableIdLifecycleIndex(units: readonly ScopeUnit[], realIndex: LifecycleIndex): LifecycleIndex {
  const byStableId = new Map<string, LifecycleRow>();
  for (const unit of units) {
    const row = realIndex.rowFor(unit.skeyR, unit.relPath);
    if (row) byStableId.set(unit.stableId, row);
  }
  return {
    rowFor(stableId: string): LifecycleRow | undefined {
      return byStableId.get(stableId);
    },
  };
}

/**
 * Composes `parseAndExtractAll` → `derivePartitions` → `finalizeUnits` →
 * `buildVocabularies` → `enumerate` (per partition) → [R4: `buildHistoryJoin`
 * → the weight functions] → `induceRoles` → `mine`, constructing R1's
 * defaults: `WeightFn` = the CONSTANT `weights.noLifecycleWeight`
 * (config-supplied, spec §9.1/§4.5 — NOT 1.0, "uniform" is not unity), and NO
 * `AgeFn`, whenever `options.historyDeps` is absent or the join degrades
 * (R4-I4). `seeds` arrives as an explicit PARAMETER (Task 1's seeds seam:
 * engine never reads the store — the command loads `seeds.jsonl` via
 * `stores.ts` and passes the result here). Does NOT persist.
 */
export async function runRootsIndex(
  repoRoot: string,
  config: RootsConfig,
  seeds: SeedEntry[],
  options?: RunRootsIndexOptions,
): Promise<RootsIndexResult> {
  const { files, rawScopes } = await parseAndExtractAll(repoRoot, config);
  const partitions: PartitionMap = derivePartitions(files, rawScopes, config);
  const units: ScopeUnit[] = finalizeUnits(rawScopes, partitions);

  const vocab = buildVocabularies(units, partitions, config);
  const byPartition = new Map<string, ScopeUnit[]>();
  for (const unit of units) {
    const bucket = byPartition.get(unit.partitionId);
    if (bucket) bucket.push(unit);
    else byPartition.set(unit.partitionId, [unit]);
  }
  const bags: FeatureBag[] = [];
  const domains: DomainMap = new Map();
  for (const partitionId of partitions.survivingPartitionIds) {
    const partitionUnits = byPartition.get(partitionId) ?? [];
    const partitionVocab: RootsVocabularies = vocab.get(partitionId) ?? {
      nodeType: [],
      call: [],
      decorator: [],
      import: [],
      supertype: [],
      shape: [],
    };
    const result = enumerate(partitionUnits, partitionVocab, config);
    bags.push(...result.bags);
    for (const [surfaceId, members] of result.domains) {
      const existing = domains.get(surfaceId);
      if (existing) for (const m of members) existing.add(m);
      else domains.set(surfaceId, new Set(members));
    }
  }

  // R1's default: the constant `weights.noLifecycleWeight` — every instance
  // weighs this, regardless of scope, and no instance ever survives. R4's
  // history join (Step 1-3), when present, replaces every one of these four.
  let weightFn: WeightFn = () => config.weights.noLifecycleWeight;
  let ageFn: AgeFn | undefined;
  let surfaceWeightFn: ((unit: ScopeUnit, surface: string) => number) | undefined;
  let hookShapedFn: ((unit: ScopeUnit, surface: string) => boolean) | undefined;
  let join: HistoryJoin | undefined;

  if (options?.historyDeps) {
    join = await buildHistoryJoin(repoRoot, config, options.historyDeps, options.onProgress);
    if (join) {
      // The join finishes first; its alias closure resolves co-change
      // (`history.ts`'s own wiring); THEN the weights are built from the
      // finished lifecycle index (T8 Step 1's own stated order).
      const realIndex = makeLifecycleIndex(join.lifecycle);
      const stableIdIndex = makeStableIdLifecycleIndex(units, realIndex);
      const releasedKeys = releasedMarks(options.historyDeps.ledger, stableIdIndex, join.clockTs, config);
      const unreleasedLedger = options.historyDeps.ledger.filter((entry) => !releasedKeys.has(markKey(entry)));

      const weightFns = makeWeightFns({
        lifecycle: realIndex,
        ledger: unreleasedLedger,
        dirtyPaths: options.historyDeps.dirtyPaths,
        clockTs: join.clockTs,
        config,
      });
      weightFn = weightFns.baseWeight;
      ageFn = weightFns.ageDays;
      surfaceWeightFn = weightFns.surfaceWeight;
      hookShapedFn = weightFns.isHookShaped;
    }
  }

  const roles = induceRoles(units, weightFn, config);
  const { body, candidateCountLog2 } = mine({ units, bags, domains, vocab, partitions, roles, seeds, config, weightFn, ageFn, surfaceWeightFn, hookShapedFn });

  if (join) {
    body.historyStats = join.historyStats;
    body.cochange = join.cochange;
    body.agentShare = join.agentShare;
    body.aliases = join.aliases;

    const filesByPartition = new Map<string, Set<string>>();
    for (const [file, partitionId] of partitions.partitionOfFile) {
      const bucket = filesByPartition.get(partitionId);
      if (bucket) bucket.add(file);
      else filesByPartition.set(partitionId, new Set([file]));
    }
    for (const partition of body.partitions) {
      const { couplingByFile, couplingByModule } = projectCouplingForPartition(join, filesByPartition.get(partition.id) ?? new Set());
      partition.couplingByFile = couplingByFile;
      partition.couplingByModule = couplingByModule;
    }
  }

  // The all-grammar fold, lifted to `computeUsedGrammarSetHash` (above) so
  // `cli/roots.ts`'s D13 short-circuit can compute the identical value cold,
  // before mining. One definition, called from both places.
  const bindingSetHash = await computeUsedGrammarSetHash(repoRoot, config);

  return { body, bindingSetHash, candidateCountLog2 };
}
