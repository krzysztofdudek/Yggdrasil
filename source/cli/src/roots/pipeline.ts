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
import { assetNameOfWasmFile, bindingForAsset, cachedBindingHashFor, type RootsBinding } from './binding.js';
import { extractUnits, finalizeUnits, type RawScope, type ScopeUnit, type ExtractOptions } from './extract.js';
import { derivePartitions, makeRootsFileFilters, type PartitionMap } from './partitions.js';
import { buildVocabularies, enumerate, type FeatureBag, type DomainMap, type RootsVocabularies } from './enumerate.js';
import { induceRoles, type WeightFn } from './roles.js';
import { mine, type MinedModel, type AgeFn } from './mine.js';
import { hashString } from '../io/hash.js';

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

export interface RootsIndexResult {
  body: MinedModel;
  /** sha256 over the sorted `assetName -> per-grammar bindingHash` map of every grammar this build actually used — the ALL-GRAMMAR fold spec `:137`/`:237` define; this is what the model header's `bindingHash` field stores (never the per-grammar hash alone). */
  bindingSetHash: string;
  candidateCountLog2: number;
}

/**
 * Composes `parseAndExtractAll` → `derivePartitions` → `finalizeUnits` →
 * `buildVocabularies` → `enumerate` (per partition) → `induceRoles` →
 * `mine`, constructing R1's defaults: `WeightFn` = the CONSTANT
 * `weights.noLifecycleWeight` (config-supplied, spec §9.1/§4.5 — NOT 1.0,
 * "uniform" is not unity), and NO `AgeFn` (R4 widens this via a trailing
 * options parameter later — the same no-signature-break seam `roles.ts`
 * documents for `induceRoles`'s own `weights` parameter). `seeds` arrives as
 * an explicit PARAMETER (Task 1's seeds seam: engine never reads the store —
 * the Task-8 command loads `seeds.jsonl` via `stores.ts` and passes the
 * result here). Does NOT persist.
 */
export async function runRootsIndex(repoRoot: string, config: RootsConfig, seeds: SeedEntry[]): Promise<RootsIndexResult> {
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

  // R1's default WeightFn: the constant `weights.noLifecycleWeight` — every
  // instance weighs this, regardless of scope (no lifecycle rows exist yet).
  const weightFn: WeightFn = () => config.weights.noLifecycleWeight;
  const ageFn: AgeFn | undefined = undefined; // R4 seam — absent here is the fail-closed default, not a permissive one

  const roles = induceRoles(units, weightFn, config);
  const { body, candidateCountLog2 } = mine({ units, bags, domains, vocab, partitions, roles, seeds, config, weightFn, ageFn });

  // The all-grammar fold (spec `:137`/`:237`): sha256 over the sorted
  // `assetName -> per-grammar bindingHash` map of every grammar actually used
  // BY THIS BUILD — NOT `binding.ts`'s cache's full contents, which is a
  // process-lifetime cache (as of R4, shared with `history.ts`) and can carry
  // entries from an earlier call for a different repo (a different grammar
  // mix) within the same process. Reruns
  // the same PARSE-set filter `parseAndExtractAll` used (files ∧ forParsing ∧
  // registered grammar) to recover exactly this run's own used-asset set,
  // deliberately duplicating that small O(files) filter pass rather than
  // widening `parseAndExtractAll`'s own dictated `{files, rawScopes}` return
  // shape to smuggle it out.
  const usedAssetHashes: Record<string, string> = {};
  const reFilters = makeRootsFileFilters(config);
  for (const relPath of files) {
    if (!reFilters.forParsing(relPath)) continue;
    const grammarInfo = getGrammarForExtension(path.extname(relPath));
    if (!grammarInfo) continue;
    const assetName = assetNameOfWasmFile(grammarInfo.wasmFile);
    const cachedHash = cachedBindingHashFor(assetName);
    if (cachedHash) usedAssetHashes[assetName] = cachedHash;
  }
  const bindingSetHash = hashString(JSON.stringify(usedAssetHashes, Object.keys(usedAssetHashes).sort()));

  return { body, bindingSetHash, candidateCountLog2 };
}
