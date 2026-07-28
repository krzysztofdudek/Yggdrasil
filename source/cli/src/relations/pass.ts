import path from 'node:path';
import { readFile } from 'node:fs/promises';

import type { Graph } from '../model/graph.js';
import { parseFile, grammarWasmHash } from '../ast/parser.js';
import { getLanguageForExtension } from '../utils/language-registry.js';
import { ensureLoaderRegistered } from '../ast/loader-hook.js';
import { expandMappingPaths, hashString } from '../io/hash.js';

import { buildOwnerIndex } from './owner-index.js';
import { SymbolTable } from './symbol-table.js';
import { makeResolver, resolveCandidateGroup } from './resolver.js';
import {
  extractCsharpRefs,
  assembleCsharpCandidates,
  type CsharpExtract,
} from './extractors/csharp.js';
import { loadFacts, writeFacts, factsKey, astCacheDir } from './facts-cache.js';
import { extractorForLanguage } from './extractors/registry.js';
import { makeResolvePathToFile } from './resolve-path.js';
import { countFeatures, type FeatureVector } from './feature-vector.js';
import { verifyNodeDeps, type ResolvedDep, type RelationGraphView, type Violation } from './verifier.js';
import type {
  DependencyExtractor,
  ParsedFile,
  DeclaredSymbol,
  DetectedDep,
} from './extractors/types.js';

export interface NodeViolations {
  verdict: 'approved' | 'refused';
  reason?: string;
  violations: Violation[];
}

/**
 * The pure extractor output of ONE file returned by `runRelationPass`.
 * Exported so the cache-audit harness can deep-equal the per-file facts between
 * a cache-HIT run and a cache-DISABLED run.
 *
 * `uses` is `null` for C# files (candidates are assembled live from the pre-assembly
 * `csharp` extract after the project-wide global-using pre-pass — never cached as
 * resolved candidates). `csharp` is non-null for C#, null for every other language.
 */
export interface FileFacts {
  declarations: DeclaredSymbol[];
  uses: DetectedDep[] | null; // null ⇔ C# (assembled live)
  csharp: CsharpExtract | null; // non-null ⇔ C#
  /**
   * Per-file structural feature vector, computed in the SAME parse-on-miss walk as
   * declarations / uses (NO second parse). Speed-only, OUTSIDE every verdict hash — pure
   * instrumentation. Always present for an extractor-backed file (this pass only reaches
   * `countFeatures` for files with a registered extractor). Rides in the pass's returned
   * `factsByPath` for downstream read-only consumers; the anomaly layer reads
   * `factsByPath.get(path).features` alongside the per-file content hash the pass also
   * exposes on its result (`hashByPath`) to pin a file's vector to its exact bytes.
   */
  features: FeatureVector;
}

/**
 * An INFRASTRUCTURE failure while parsing a mapped source file during the relation
 * pass: a missing/corrupt WASM grammar, a `Parser.init()` / `Language.load()`
 * rejection, or `parser.parse()` returning null. tree-sitter is an ERROR-TOLERANT
 * parser — it returns a tree (with `hasError` nodes) for malformed source and NEVER
 * throws on bad syntax — so any exception `parseFile` throws is BY CONSTRUCTION an
 * infrastructure fault, never a code-level parse of bad source. Such a failure must
 * FAIL CLOSED: the relation-conformance check must NOT silently treat the file as
 * having zero dependencies (which would make `yg check` pass over code it never
 * analyzed — repo-wide for a whole language if that language's grammar is missing).
 * Deduplicated per language (one grammar fault hits every file of that language
 * identically); `examplePath` names the first file that hit it and `fileCount` how
 * many files of the language failed. The caller surfaces each as a BLOCKING issue.
 */
export interface RelationParseFailure {
  language: string;
  examplePath: string; // repo-rel POSIX path of the first file that failed to parse
  fileCount: number; // number of files of this language that failed to parse
  message: string; // the underlying parseFile error text (e.g. resolveWasm's)
}

/**
 * The one canonical declaration of the typed-edge shape the live type-relation gate
 * (relations/type-gate.ts) reads. Declared HERE — the relation pass is the SOLE producer,
 * built from the same per-file candidate resolution the pass already runs for every
 * enumerated file (both node-owned and type-covered). `type-gate.ts` imports this TYPE
 * only; it never redeclares or re-exports it.
 *
 * An edge appears here ONLY when its target resolved to a classified endpoint — an
 * explicit node (`kind: 'node'`) or a type-covered file (`kind: 'type-covered'`). A
 * candidate that resolves to no file, to an ambiguous symbol, or to an unmapped/
 * unclassified file is excluded from the index entirely at this SOURCE, not filtered
 * later — `type-gate.ts` never even sees such an edge.
 */
export interface TypedEdgeIndex {
  edgesFrom(file: string): Array<{
    toFile: string;
    toOwner: { kind: 'node'; path: string; type: string } | { kind: 'type-covered'; type: string };
  }>;
}

export interface RelationPassResult {
  violationsByNode: Map<string, NodeViolations>;
  /**
   * ALWAYS present (empty when every mapped file parsed). Infrastructure parse
   * failures encountered during the pass, one entry per affected language. The gate
   * caller (`yg check`) MUST surface each as a blocking issue — an unparsed file
   * contributes no detected dependencies, so silently dropping it would let the
   * relation-conformance check go green over code it never analyzed. A read-only
   * consumer (e.g. the calibration dump) may ignore this field; it is never a gate.
   */
  parseFailures: RelationParseFailure[];
  /** Per-file extractor facts (repo-rel POSIX path → facts). Always populated.
   *  Exposed so the cache-audit harness can deep-equal a cache-HIT run against a
   *  cache-DISABLED run — a mismatch means an incomplete key or a broken round-trip. */
  factsByPath: Map<string, FileFacts>;
  /**
   * ADDITIVE, read-only: repo-rel POSIX path → the file's raw content hash
   * (`FileRecord.hash`, i.e. `hashString(fileBytes)`). Computed once at file-enumeration
   * time from the freshly-read bytes — the SAME hash regardless of an AST-cache hit/miss,
   * and the SAME hash a later reader re-derives from the file bytes. Exposed so downstream
   * read-only consumers (the silent feature-field index) can pin an entry to the exact bytes
   * the feature vectors were computed from WITHOUT re-reading or re-hashing. Populated for
   * every enumerated file (a superset of `factsByPath`, which drops parse-failed files).
   */
  hashByPath: Map<string, string>;
  /**
   * ADDITIVE, read-only: the FULL set of statically-detected cross-node code edges
   * keyed by source nodeId → the set of resolved target nodeIds it depends on. This is
   * the SUPERSET of `violationsByNode` (which carries only the UNDECLARED subset) — every
   * edge the resolver uniquely resolved to another node, whether declared or not, and
   * BEFORE the declared/ancestor filtering that `verifyNodeDeps` applies. Self-edges and
   * ancestor/descendant edges are excluded (they are never a relation between two distinct
   * nodes). Populated from the same `resolvedDeps` the verdict pass already computes, so it
   * adds no parse and changes no verdict logic. Consumers (the portal boundary join) use it
   * to compute declared-only (declared MINUS detected) and forbidden-type (detected ×
   * architecture matrix) without re-parsing.
   */
  detectedEdgesByNode: Map<string, Set<string>>;
  /**
   * ADDITIVE, read-only: the live type-to-type relation gate's edge index (coverage.
   * type_level's import-edge check). Built from the SAME per-file candidate resolution
   * this pass already runs, generalized across both node-owned and type-covered files —
   * no extra parse. Empty (every `edgesFrom` call returns `[]`) when `deps.typeCoveredFiles`
   * is undefined/empty AND the graph has no explicit nodes, but in practice this pass
   * always populates it for node-owned files regardless of the type-level flag; the gate
   * caller (`core/check.ts`) decides whether to act on it (R3 gates the DECISION, and —
   * via `deps.typeCoveredFiles` — the type-covered half of the ENUMERATION, not this
   * field's mere existence).
   */
  typedEdges: TypedEdgeIndex;
  /**
   * ADDITIVE, read-only: every enumerated file's OWN owner's type — a node-owned file's
   * owning node's type, or a type-covered file's matched classifying type. Built from the
   * same `fileRecords` this pass already enumerated (both node-owned and type-covered), no
   * extra I/O. The live type-relation gate needs this to resolve an edge's SOURCE type,
   * mirroring how each edge's own `toOwner` already carries the TARGET type.
   */
  fileOwnerType: Map<string, string>;
} // key = nodeId (node.path)

export interface RelationPassDeps {
  extractorFor: (language: string) => DependencyExtractor | undefined;
  resolvePathToFile: (specifier: string, fromFile: string, language: string, isPackage?: boolean) => string | undefined;
  /**
   * File → matched classifying typeId (coverage.type_level), e.g.
   * `computeTypeCoverage(...).covered`. Undefined or empty ⇒ this pass's file enumeration
   * ADDS NOTHING beyond the existing node-mapped files — zero added parse cost, byte-
   * identical to today (R3). When populated, each entry is enumerated the SAME way a
   * node-mapped file is (read, hash, detect language, extract facts) and attributed to its
   * matched TYPE rather than a nodeId, feeding both `typedEdges` and `fileOwnerType` below.
   */
  typeCoveredFiles?: Map<string, string>;
  /**
   * Root of the content-addressed AST fact cache, e.g. `<root>/.yggdrasil/.ast-cache`.
   * The cache is SPEED-only: it caches the pure extractor facts (declarations / uses /
   * C# pre-assembly extract) of a file, keyed by the file's raw content hash + language +
   * grammar wasm hash + extractor rev. The resolve/verify join stays LIVE every run, so a
   * cached fact can never carry a stale relation verdict.
   */
  symbolIndexDir: string;
  /**
   * When `true`, the pass NEVER reads from the fact cache (`loadFacts` is bypassed —
   * every file is forced to a MISS) and NEVER writes back to it (`writeFacts` is a
   * no-op). Every file is always parsed fresh. Used exclusively by the cache-audit
   * harness to produce a ground-truth run for deep-equal comparison against a cache-HIT
   * run. Not intended for production use.
   */
  disableCache?: boolean;
}

interface FileRecord {
  path: string; // repo-rel POSIX
  content: string;
  hash: string;
  language: string | null;
  nodeId: string;
  /**
   * Set (to its matched classifying type) for a type-covered record, undefined for a
   * node-owned one. The two are mutually exclusive by construction: a type-covered file
   * is, by definition, one `computeTypeCoverage` found no node mapping for.
   */
  typeId?: string;
}

// The exported `FileFacts` interface above is used directly throughout the pass body.
// No internal alias needed — it is both the extractor-output shape and the public audit type.

export async function runRelationPass(
  graph: Graph,
  projectRoot: string,
  deps: RelationPassDeps,
): Promise<RelationPassResult> {
  // 1. Register the loader hook once so tree-sitter grammars resolve under test/dev.
  ensureLoaderRegistered();

  // 2. Enumerate every node's mapped files once; read bytes, hash, detect language.
  //    Files unreadable are skipped silently. Each file is read exactly once, so the
  //    hash captured here is reused everywhere (no re-read → the F8 taint guard is moot
  //    in a single pass; we hash at read time and never re-read the same path).
  const fileRecords: FileRecord[] = [];
  const recordByPath = new Map<string, FileRecord>();
  for (const [nodeId, node] of graph.nodes) {
    const mapping = node.meta.mapping ?? [];
    if (mapping.length === 0) continue;
    const files = await expandMappingPaths(projectRoot, mapping);
    for (const rel of files) {
      if (recordByPath.has(rel)) continue; // already enumerated under another node
      let content: string;
      try {
        content = await readFile(path.join(projectRoot, rel), 'utf-8');
      } catch {
        continue; // unreadable → skip
      }
      const language = getLanguageForExtension(path.extname(rel));
      const record: FileRecord = {
        path: rel,
        content,
        hash: hashString(content),
        language,
        nodeId,
      };
      fileRecords.push(record);
      recordByPath.set(rel, record);
    }
  }

  // Type-covered files (coverage.type_level): enumerated the SAME way as node-mapped
  // files (read, hash, detect language) but attributed to their matched TYPE, not a
  // nodeId. Empty/undefined typeCoveredFiles (flag off, or no coverage scan ran) means
  // this loop does nothing — zero added parse cost, byte-identical to today (R3).
  for (const [rel, typeId] of deps.typeCoveredFiles ?? []) {
    if (recordByPath.has(rel)) continue; // defensive; cannot actually overlap with a node mapping by construction
    let content: string;
    try {
      content = await readFile(path.join(projectRoot, rel), 'utf-8');
    } catch {
      continue; // unreadable → skip
    }
    const language = getLanguageForExtension(path.extname(rel));
    const record: FileRecord = { path: rel, content, hash: hashString(content), language, nodeId: '', typeId };
    fileRecords.push(record);
    recordByPath.set(rel, record);
  }

  // 3. Owner index over the whole graph.
  const ownerIndex = buildOwnerIndex(graph.nodes);

  // Child-precedence: enumeration above records each file once under the FIRST node
  // in graph insertion order whose mapping matches it — typically a globbing parent.
  // But ownership (and therefore which node's declared relations sanction the file's
  // outgoing dependencies) must honor child-precedence, exactly as `yg owner` and the
  // pair-set carve-out do. Re-point every record at its true owner so a parent is
  // never blamed for a dependency the child node that actually owns the file declared.
  // A type-covered record (typeId set) has no node owner to re-point to child-precedence
  // — it is skipped here, not merely a no-op, since it never has a node's declared
  // relations to sanction anything in the first place.
  for (const record of fileRecords) {
    if (record.typeId !== undefined) continue;
    const trueOwner = ownerIndex.ownerOf(record.path);
    if (trueOwner !== undefined) record.nodeId = trueOwner;
  }

  // Infrastructure parse failures collected during the pass, deduped per language.
  // Populated ONLY by the parseFile-throws branch in parseSingle below; returned on
  // the result so the gate caller can surface each as a blocking issue (fail closed).
  const parseFailuresByLanguage = new Map<string, RelationParseFailure>();

  // Parse a single file, returning a ParsedFile with a live WASM tree.
  // The CALLER must call tree.delete() immediately after use — trees are never cached
  // here to keep WASM heap usage bounded to O(1) trees at any moment.
  async function parseSingle(record: FileRecord): Promise<ParsedFile | null> {
    // No grammar registered for this file's extension → a legitimate, SILENT skip:
    // the file is simply outside relation conformance. This is NOT an infra failure
    // and must never surface as an error.
    if (!record.language) return null;
    try {
      const tree = await parseFile(record.path, record.content);
      return { path: record.path, content: record.content, tree, language: record.language };
    } catch (err) {
      // FAIL CLOSED. tree-sitter is error-tolerant — it returns a tree (with `hasError`
      // nodes) for malformed source and never throws on bad syntax — so any throw from
      // parseFile is an INFRASTRUCTURE fault (missing/corrupt WASM grammar,
      // Parser.init()/Language.load() rejection, or parser.parse() returning null),
      // exactly the condition ast/runner.ts treats as AST_GRAMMAR_LOAD_FAILED. The old
      // `catch { return null; }` collapsed this into "the file has no dependencies",
      // silently zeroing the relation-conformance analysis for the file — repo-wide for a
      // whole language if its grammar is missing — so `yg check` went green over code it
      // never analyzed. Record the fault (deduped per language) so the caller surfaces it
      // as a BLOCKING relation-parse-failed issue; still return null so the pass completes
      // and every OTHER language is analyzed and reported. parseFile creates no tree when
      // it throws, so there is nothing to delete here.
      const message = err instanceof Error ? err.message : String(err);
      const prior = parseFailuresByLanguage.get(record.language);
      if (prior) {
        prior.fileCount++;
      } else {
        parseFailuresByLanguage.set(record.language, {
          language: record.language,
          examplePath: record.path,
          fileCount: 1,
          message,
        });
      }
      return null;
    }
  }

  // Parse a file ONCE and return its pure extractor facts. The single walk runs
  // `declarations()` (+ for non-C# `uses()`, + for C# the alias-UNRESOLVED `extractCsharpRefs`)
  // inside ONE try/finally that ALWAYS deletes the tree — even if an extractor throws
  // mid-extraction — so a thrown extractor never leaks a WASM tree. Returns `null` iff
  // the parse itself failed or the file has no language, so callers can distinguish a
  // failed parse from a legitimately empty file (never treat a failure as empty facts; a
  // `null` is never written to the cache — design §14 Correction B). The facts are then reused
  // by the symbol build, the C# pre-pass, and per-node resolution, so each file is parsed at
  // most once here — including C#, whose candidate groups are now ASSEMBLED live from the
  // cached pre-assembly extract (no re-parse).
  async function extractFileFacts(
    record: FileRecord,
    extractor: DependencyExtractor,
  ): Promise<FileFacts | null> {
    const parsed = await parseSingle(record);
    if (!parsed) return null;
    try {
      const declarations = extractor.declarations(parsed);
      const isCsharp = record.language === 'csharp';
      // C#: cache the alias-UNRESOLVED extract; the project-wide global-using aggregate is
      // folded LIVE per node at assembly time (after the pre-pass) — never baked into the
      // cached fact. Non-C#: `uses()` is a pure function of the file's bytes → cache it.
      const uses = isCsharp ? null : extractor.uses(parsed);
      const csharp = isCsharp ? extractCsharpRefs(parsed) : null;
      // Structural feature vector over the SAME already-parsed tree (no second parse). This
      // is speed-only instrumentation and never enters any verdict hash.
      const features = countFeatures(parsed.tree.rootNode, parsed.language);
      return { declarations, uses, csharp, features };
    } finally {
      parsed.tree.delete();
    }
  }

  // Eager per-extension grammar wasm hash, memoized once per extension present in the run,
  // BEFORE any cache lookup. Critical: on an all-hit run the parser is never invoked, so a
  // lazily-derived grammar hash would never be produced and a grammar upgrade would go
  // unnoticed (every file would stay a stale hit). `grammarWasmHash` itself memoizes per
  // extension; this local map only caches the (extension → hash | null) lookup so a file whose
  // extension has no grammar is recorded as `null` (→ uncacheable, always parsed live).
  const grammarHashByExt = new Map<string, string | null>();
  const grammarHashForExt = (ext: string): string | null => {
    const hit = grammarHashByExt.get(ext);
    if (hit !== undefined) return hit;
    let h: string | null;
    try {
      h = grammarWasmHash(ext);
    } catch {
      h = null; // no grammar for this extension → cannot content-address → always parse live
    }
    grammarHashByExt.set(ext, h);
    return h;
  };

  // Cache-backed fact resolution for one file. Computes the content-key (raw content hash +
  // language + grammar wasm hash + extractor rev), tries the AST fact cache, and on a MISS
  // parses live via `extractFileFacts` and writes the shard back — but ONLY on a successful
  // parse (a `null` is fail-closed-to-parse: nothing is written, the file re-parses next run).
  // A file with no grammar hash (no grammar for its extension) is never cacheable → parse live.
  // The returned in-memory `FileFacts` is shaped per language: non-C# carries `uses`; C# carries
  // the alias-UNRESOLVED `csharp` extract (assembled live downstream).
  //
  // When `deps.disableCache` is true, EVERY lookup is forced to a MISS and no shard is written.
  // This is the cache-audit path: callers compare the returned facts against a prior cache-HIT
  // run; any difference is an incomplete key or a broken round-trip → gate fails.
  async function loadOrExtractFacts(
    record: FileRecord,
    extractor: DependencyExtractor,
  ): Promise<FileFacts | null> {
    const language = record.language!;
    const isCsharp = language === 'csharp';
    const grammarHash = grammarHashForExt(path.extname(record.path));

    // No grammar hash → cannot key the cache. Parse live, do not cache.
    if (grammarHash === null) return extractFileFacts(record, extractor);

    // Cache-ENABLED path: read the shard; on a HIT skip the parse, on a MISS parse live and
    // write the shard back. (The cache-audit BYPASS — never read, never write, always parse —
    // lives at the `disableCache=true` return at the bottom of this function.)
    if (!deps.disableCache) {
      const key = factsKey({
        contentHash: record.hash,
        language,
        grammarHash,
        rev: extractor.rev,
      });

      const cached = await loadFacts(deps.symbolIndexDir, language, key);
      // A C# HIT is valid ONLY when the shard actually carries the `csharp` extract. A shard
      // that matches the key but LACKS `csharp` (`cached.csharp === undefined`) is NOT a
      // null-csharp hit — that would yield `csharp: null` and silently SKIP the file downstream
      // (`facts.csharp === null` → continue), erasing a real C# cross-node edge → false green.
      // Treat it as a MISS so the file falls through to the live parse below (fail-closed-to-PARSE,
      // never fail-closed-to-empty). For non-C# files an absent `csharp` is legitimate (stays null).
      if (cached && (!isCsharp || cached.csharp !== undefined)) {
        // HIT — rebuild the in-memory per-file fact from the cached extractor output. The cache
        // skips the PARSE, never the downstream join (symbol declare / resolve / assemble).
        // `cached.csharp` is guaranteed present here for C# (guard above).
        return {
          declarations: cached.declarations,
          uses: isCsharp ? null : cached.uses,
          csharp: isCsharp ? cached.csharp! : null,
          // Guaranteed present — `loadFacts` fail-closes to a MISS on a missing/malformed
          // features field, so a returned cached fact always carries a valid vector.
          features: cached.features,
        };
      }

      // MISS — parse live. A failed parse writes NOTHING (fail-closed-to-parse).
      const facts = await extractFileFacts(record, extractor);
      if (!facts) return null;

      // Persist the pure extractor output. C# stores its alias-unresolved extract under `csharp`
      // (with `uses: []` unused); non-C# stores `uses` (no `csharp`). `writeFacts` is create-only.
      await writeFacts(deps.symbolIndexDir, language, key, {
        declarations: facts.declarations,
        uses: facts.uses ?? [],
        features: facts.features,
        ...(facts.csharp !== null ? { csharp: facts.csharp } : {}),
      });
      return facts;
    }

    // Cache-audit BYPASS (disableCache=true): never read AND never write — parse every file
    // fresh, proving the same facts emerge from parsing as the cache would have served.
    return extractFileFacts(record, extractor);
  }

  // 4. Per-file fact resolution. Universe = all mapped files of an extractor-backed language
  //    (broad universe so ambiguity is detected across the repo). Each such file's facts come
  //    from the content-addressed AST cache when its bytes/grammar/extractor are unchanged
  //    (NO parse), else from a live single walk (then cached). The result feeds the symbol
  //    build, the C# pre-pass, and the per-node resolution below — no phase re-parses. A failed
  //    parse (null) is simply absent from factsByPath (never recorded as empty facts), exactly
  //    as the old per-phase `if (!parsed) continue;` skipped it.
  const symbolTable = new SymbolTable();
  const recordsByLanguage = new Map<string, FileRecord[]>();
  for (const record of fileRecords) {
    if (!record.language) continue;
    if (!deps.extractorFor(record.language)) continue;
    let list = recordsByLanguage.get(record.language);
    if (!list) {
      list = [];
      recordsByLanguage.set(record.language, list);
    }
    list.push(record);
  }

  const factsByPath = new Map<string, FileFacts>();
  for (const record of fileRecords) {
    if (!record.language) continue;
    const extractor = deps.extractorFor(record.language);
    if (!extractor) continue;
    const facts = await loadOrExtractFacts(record, extractor);
    if (facts) factsByPath.set(record.path, facts);
  }

  // 4a. Build the shared SymbolTable by re-declaring EVERY file's declarations every run (cached
  //     or fresh). The cache skips the PARSE, never the `declare()` — ambiguity (`defCount` /
  //     `filesFor`, and Ruby's intentionally non-deduped reopenings) is a CROSS-FILE property; a
  //     hit that skipped re-declaring would under-count `defCount`, make an ambiguous symbol look
  //     unique, and silence a real ambiguity → false green (design §8 mandatory invariant). The
  //     table is order-independent (`Map<key, Set<file>>`), so re-declaring all files in any order
  //     reproduces the same table.
  for (const [language, records] of recordsByLanguage) {
    for (const record of records) {
      const facts = factsByPath.get(record.path);
      if (!facts) continue;
      for (const decl of facts.declarations) {
        symbolTable.declare(language, decl.symbolKey, record.path);
      }
    }
  }

  // 4.5 C# global-using pre-pass (R5). A `global using N;` declared in ANY C# file is a
  //     project-wide import that qualifies bare names in EVERY C# file. Aggregate every C#
  //     file's `global using` namespace prefixes once, then inject the set into each file's
  //     candidate assembly below (as the lowest using tier). This is the one cross-file scope
  //     channel the per-file extractor cannot see on its own. Implicit/SDK global usings remain
  //     invisible to a source-only tool → the names they would import stay silenced (correct).
  //     Also aggregate every file's `global using Alias = N.Type;` project-wide aliases (A12):
  //     a global-using alias declared in ANY file is usable in EVERY file, resolved in the
  //     declaring file's context (the alias RHS is fully-qualified, so the captured FQN is the
  //     target). A later same-named global alias overwrites an earlier one (last-wins is benign:
  //     a genuine cross-file collision is a compile error C# itself rejects; our zero-FP floor is
  //     that a file-local alias of the same name always takes precedence, enforced in assembly).
  //     This reads from the CACHED per-file C# extract (`facts.csharp.scope.globalPrefixes /
  //     globalAliases`) — NO C# re-parse — but MUST still complete (aggregate ALL C# files)
  //     BEFORE per-node assembly: a `global using` in any file changes another file's bare-name
  //     resolution, so the full aggregate is the input to every per-node `assembleCsharpCandidates`
  //     call below.
  const csharpRecords = recordsByLanguage.get('csharp') ?? [];
  const projectGlobalUsings = new Set<string>();
  const projectGlobalUsingAliases = new Map<string, string>();
  for (const record of csharpRecords) {
    const facts = factsByPath.get(record.path);
    if (!facts || facts.csharp === null) continue;
    for (const prefix of facts.csharp.scope.globalPrefixes) projectGlobalUsings.add(prefix);
    for (const [name, fqn] of facts.csharp.scope.globalAliases) projectGlobalUsingAliases.set(name, fqn);
  }
  const csharpGlobalUsings = [...projectGlobalUsings];
  const csharpGlobalUsingAliases = [...projectGlobalUsingAliases.entries()];

  // 5. Resolver composes owner index + symbol table + injected path resolution.
  const resolver = makeResolver({
    ownerIndex,
    symbolTable,
    resolvePathToFile: deps.resolvePathToFile,
  });

  // 7. Graph view for the verifier.
  const graphView: RelationGraphView = {
    isAncestorOf(a, b) {
      return b.startsWith(a + '/');
    },
    declaredTargets(nodeId) {
      return new Set((graph.nodes.get(nodeId)?.meta.relations ?? []).map((r) => r.target));
    },
    parentChain(nodeId) {
      const chain: string[] = [];
      let cur = nodeId;
      while (cur.includes('/')) {
        cur = cur.slice(0, cur.lastIndexOf('/'));
        chain.push(cur);
      }
      return chain;
    },
  };

  // 6. Per node: collect detected uses (the cached `uses` for every non-C# file; for C# the
  //    candidate groups ASSEMBLED LIVE from the cached extract + the project-global aggregate),
  //    resolve each, verify undeclared cross-node dependencies, and form the LIVE result.
  const violationsByNode = new Map<string, NodeViolations>();
  // ADDITIVE: the full set of resolved cross-node edges per source node (declared OR not),
  // for read-only consumers. Self / ancestor / descendant edges are not real edges between
  // two distinct nodes, so they are excluded here exactly as `verifyNodeDeps` skips them.
  const detectedEdgesByNode = new Map<string, Set<string>>();
  // ADDITIVE: the live type-relation gate's per-FILE edge index (TypedEdgeIndex), keyed by
  // source file rather than owning node — a type-covered file has no node to group under.
  // Populated below from the SAME per-record candidate resolution both the node-owned loop
  // and the type-covered loop already run; see `addTypedEdges`.
  const typedEdgesByFile = new Map<
    string,
    Array<{ toFile: string; toOwner: { kind: 'node'; path: string; type: string } | { kind: 'type-covered'; type: string } }>
  >();

  // Resolve one file's detected uses into cross-node edges (shared by both paths below).
  const resolveDetected = (record: FileRecord, detected: DetectedDep[], resolvedDeps: ResolvedDep[]): void => {
    for (const dep of detected) {
      // Ordered first-unique-match-wins walk over the candidate group — the SINGLE
      // definition shared verbatim with the reference-case runner (resolveCandidateGroup).
      // A resolved self-edge is pushed here and filtered downstream by verifyNodeDeps
      // against the node's declared relations.
      const ownerNode = resolveCandidateGroup(dep.candidates, resolver, record.path, record.language!);
      if (ownerNode !== undefined) {
        resolvedDeps.push({ fromFile: record.path, line: dep.line, ownerNode });
      }
    }
  };

  // Resolve one file's detected uses into the live type-relation gate's typed-edge index,
  // generalized across node-owned and type-covered sources. Mirrors resolveDetected's
  // nearest-candidate-first precedence (a resolved candidate stops the group; an ambiguous
  // one silences it with no edge), extended with ONE new resolution path: a candidate that
  // `classify` reports `absent` (no node owns its resolved file, or it resolves to nothing)
  // may STILL name a TYPE-COVERED file — checked via `resolver.resolveFile`, which `classify`
  // never consults (it only ever asks `ownerIndex`). An edge whose target is neither a node
  // nor a type-covered file (ambiguous/unmatched) is excluded here entirely, matching the
  // design's "not gated" rule at the SOURCE rather than filtering it out downstream.
  const addTypedEdges = (record: FileRecord, detected: DetectedDep[]): void => {
    for (const dep of detected) {
      for (const cand of dep.candidates) {
        const outcome = resolver.classify(cand, record.path, record.language!);
        if (outcome.kind === 'resolved') {
          const targetNode = graph.nodes.get(outcome.ownerNode);
          if (targetNode) {
            let list = typedEdgesByFile.get(record.path);
            if (!list) {
              list = [];
              typedEdgesByFile.set(record.path, list);
            }
            list.push({ toFile: outcome.resolvedFile, toOwner: { kind: 'node', path: outcome.ownerNode, type: targetNode.meta.type } });
          }
          break; // nearest candidate bound — stop this dep's group
        }
        if (outcome.kind === 'ambiguous') break; // present-but-ambiguous → silence the group
        // absent: the node-owner walk found nothing for this candidate. Check whether its
        // raw resolved file (if any) is nonetheless a TYPE-COVERED file — invisible to
        // `classify`, which only ever resolves against `ownerIndex`.
        const file = resolver.resolveFile(cand, record.path, record.language!);
        if (file) {
          const targetRecord = recordByPath.get(file);
          if (targetRecord?.typeId !== undefined) {
            let list = typedEdgesByFile.get(record.path);
            if (!list) {
              list = [];
              typedEdgesByFile.set(record.path, list);
            }
            list.push({ toFile: file, toOwner: { kind: 'type-covered', type: targetRecord.typeId } });
            break; // bound to a type-covered target — stop this dep's group
          }
        }
        // else continue to the next, farther candidate
      }
    }
  };

  for (const [nodeId] of graph.nodes) {
    const records = fileRecords.filter((r) => r.nodeId === nodeId);
    if (records.length === 0) continue; // node with NO mapped source files → no result

    const resolvedDeps: ResolvedDep[] = [];

    for (const record of records) {
      if (!record.language) continue;
      const extractor = deps.extractorFor(record.language);
      if (!extractor) continue;

      if (record.language === 'csharp') {
        // C# candidate groups fold the cross-file global-using aggregate as their lowest using
        // tier (R5), so they are ASSEMBLED LIVE here from the file's cached pre-assembly extract
        // (`facts.csharp`) plus the project-wide aggregate built above — NO C# re-parse. This is
        // where C# finally stops re-parsing unchanged files. A file whose parse failed is absent
        // from factsByPath — skip it, exactly as `if (!parsed) continue;` did.
        const facts = factsByPath.get(record.path);
        if (!facts || facts.csharp === null) continue;
        const detected = assembleCsharpCandidates(facts.csharp, {
          projectGlobalUsings: csharpGlobalUsings,
          projectGlobalUsingAliases: csharpGlobalUsingAliases,
        });
        resolveDetected(record, detected, resolvedDeps);
        addTypedEdges(record, detected);
        continue;
      }

      // Every non-C# file's uses() came from the single walk above (no re-parse). A file whose
      // parse failed is absent from factsByPath — skip it, exactly as `if (!parsed) continue;` did.
      const facts = factsByPath.get(record.path);
      if (!facts || facts.uses === null) continue;
      resolveDetected(record, facts.uses, resolvedDeps);
      addTypedEdges(record, facts.uses);
    }

    // ADDITIVE read-only edge set: every uniquely-resolved cross-node target, declared or
    // not, with self / ancestor / descendant edges excluded (not edges between two distinct
    // nodes). This is the full detected superset; verifyNodeDeps below narrows it to the
    // undeclared subset for the verdict. No extra parse — `resolvedDeps` is already built.
    const edges = new Set<string>();
    for (const d of resolvedDeps) {
      const m = d.ownerNode;
      if (m === nodeId) continue;
      if (graphView.isAncestorOf(m, nodeId) || graphView.isAncestorOf(nodeId, m)) continue;
      edges.add(m);
    }
    if (edges.size > 0) detectedEdgesByNode.set(nodeId, edges);

    const violations = verifyNodeDeps(nodeId, resolvedDeps, graphView);
    if (violations.length) {
      const reason = violations
        .map((v) => `${v.fromFile}:${v.line} → undeclared dependency on ${v.ownerNode}`)
        .join('\n');
      violationsByNode.set(nodeId, { verdict: 'refused', reason, violations });
    } else {
      violationsByNode.set(nodeId, { verdict: 'approved', violations: [] });
    }
  }

  // 6.5 Type-covered records (coverage.type_level): NOT visited by the per-node loop above
  //     (keyed by nodeId; a type-covered record's nodeId is '' by construction — it has no
  //     node to group under). Each is resolved individually here for the SAME
  //     typedEdgesByFile, reusing the SAME cached facts (no re-parse) — a type-covered file
  //     is enumerated and its facts extracted exactly like a node-owned one (step 2 /
  //     section 4 above already cover it); only this candidate-resolution walk needs a
  //     dedicated loop since it has no shared per-node grouping to batch against. Empty when
  //     no type-covered records were enumerated (flag off, or no coverage scan ran) — R3.
  for (const record of fileRecords) {
    if (record.typeId === undefined) continue; // node-owned — already handled above
    if (!record.language) continue;
    const extractor = deps.extractorFor(record.language);
    if (!extractor) continue;

    if (record.language === 'csharp') {
      const facts = factsByPath.get(record.path);
      if (!facts || facts.csharp === null) continue;
      const detected = assembleCsharpCandidates(facts.csharp, {
        projectGlobalUsings: csharpGlobalUsings,
        projectGlobalUsingAliases: csharpGlobalUsingAliases,
      });
      addTypedEdges(record, detected);
      continue;
    }

    const facts = factsByPath.get(record.path);
    if (!facts || facts.uses === null) continue;
    addTypedEdges(record, facts.uses);
  }

  // ADDITIVE read-only: expose each enumerated file's raw content hash (computed once from
  // the freshly-read bytes at enumeration, independent of any AST-cache hit/miss). Lets the
  // silent feature-field index pin an entry to exact bytes without re-reading or re-hashing.
  const hashByPath = new Map<string, string>();
  for (const [rel, record] of recordByPath) hashByPath.set(rel, record.hash);

  // ADDITIVE, read-only: every enumerated file's OWNER's type — a node-owned file's owning
  // node's type, or a type-covered file's matched type. Built from the same fileRecords this
  // pass already enumerated (both loops in step 2); no extra I/O. Consumed directly by the
  // live type-relation gate to resolve an edge's SOURCE type — mirrors how each edge's own
  // toOwner already carries the TARGET type.
  const fileOwnerType = new Map<string, string>();
  for (const [rel, record] of recordByPath) {
    if (record.typeId !== undefined) {
      fileOwnerType.set(rel, record.typeId);
    } else if (record.nodeId) {
      const node = graph.nodes.get(record.nodeId);
      if (node) fileOwnerType.set(rel, node.meta.type);
    }
  }

  return {
    violationsByNode,
    factsByPath,
    detectedEdgesByNode,
    hashByPath,
    parseFailures: [...parseFailuresByLanguage.values()],
    typedEdges: { edgesFrom: (file: string) => typedEdgesByFile.get(file) ?? [] },
    fileOwnerType,
  };
}

/**
 * Convenience entry point for callers OUTSIDE runCheck (the yg find / yg structure
 * navigation surfaces read derived edges without running a full check) that want the
 * live type-relation edge index without assembling RelationPassDeps themselves. Runs
 * the SAME live pass runRelationPass does — no separate implementation, no drift —
 * and returns just the one field those callers need. `covered` is a type-covered
 * file -> matched typeId map, e.g. computeTypeCoverage(...).covered. core/check.ts
 * itself does NOT call this: it already holds a full RelationPassResult from its own
 * direct runRelationPass call, and calling this too would re-run the whole pass a
 * second time in the same check.
 */
export async function buildTypedEdgeIndex(
  graph: Graph,
  covered: Map<string, string>,
): Promise<TypedEdgeIndex> {
  const projectRoot = path.dirname(graph.rootPath);
  const ownerIndex = buildOwnerIndex(graph.nodes);
  const result = await runRelationPass(graph, projectRoot, {
    extractorFor: extractorForLanguage,
    resolvePathToFile: makeResolvePathToFile(projectRoot, ownerIndex.ownerOf),
    symbolIndexDir: astCacheDir(graph.rootPath),
    typeCoveredFiles: covered,
  });
  return result.typedEdges;
}
