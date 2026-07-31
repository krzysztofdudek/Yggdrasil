import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureLoaderRegistered } from '../ast/loader-hook.js';
import { createCtxFs, UndeclaredFsReadError } from './ctx-fs.js';
import {
  createCtxGraph, createNodelessCtxGraph, UndeclaredGraphReadError, StructureNodeContextUnavailableError,
  computeAllowedNodePaths, recordNodeGraphObservation,
} from './ctx-graph.js';
import { createCtxParsers, prewarmupAstCache, enrichFilesWithAst, ParseAstNotPrewarmedError } from './ctx-parsers.js';
import { collectAllowedReadsForAspect } from './allowed-reads.js';
import { normalizeMappingPath, isPathInMapping } from './expand-mapping-sync.js';
import { expandMappingPathsWithinOwnGraph } from '../io/hash.js';
import type { Graph, GraphNode as ModelNode } from '../model/graph.js';
import type { Ctx, CompanionDescriptor, File, Port } from './types.js';
import type { ParseCache } from '../ast/parse-cache.js';
import { destroyParseCache } from '../ast/parse-cache.js';
import type { IssueMessage } from '../model/validation.js';
import { BINARY_EXTENSIONS } from '../utils/binary-extensions.js';
import { ObservationRecorder } from './observations.js';

/**
 * Raised by the shared hook loader and the deterministic structure runner.
 * Defined here (not in runner.ts) so both the loader and the runner can throw it
 * without a circular import; runner.ts re-exports it for backward compatibility.
 */
export class StructureRunnerError extends Error {
  public readonly messageData: IssueMessage;
  constructor(public readonly code: string, data: IssueMessage) {
    // Keep the code token in .message so author-facing assertions and logs
    // that key off the code continue to find it; carry the full what/why/next
    // in messageData for the structured renderer (parity with AstRunnerError).
    super(`${code}: ${data.what}\n${data.why}\n${data.next}`);
    this.messageData = data;
    this.name = 'StructureRunnerError';
  }
}

/**
 * Expand the node's own mapping to a flat list of readable text files.
 * Directory entries are expanded recursively via the gitignore-aware
 * expandMappingPathsWithinOwnGraph helper (same function used by the
 * node-size budget and build-context), so ctx.files exactly matches what the
 * LLM path sees — a nested project's own subtree (a directory carrying its
 * own `.yggdrasil/`) is dropped by that helper before it ever reaches ctx,
 * so a vendored dependency's or a submodule's files are never exposed to
 * this graph's review as though they were this node's own.
 * Files owned by descendant (child) nodes are carved out so a child's
 * aspects apply to those files, not the parent's.
 * Binary files (by extension) and unreadable files are silently skipped.
 *
 * Returns each file's RAW disk bytes alongside its File view so the caller can
 * fold a byte-symmetric `read:` observation if the check accesses a non-subject
 * sibling's content (spec §3.1, Bug 1).
 */
async function buildOwnFiles(
  node: ModelNode,
  projectRoot: string,
  touchedFiles: string[],
): Promise<Array<{ file: File; bytes: Buffer }>> {
  // Collect mapping entries from ALL strict-descendant nodes (not just direct
  // children) — we exclude any file a descendant maps (glob-aware) to preserve the
  // child-precedence (child-wins) model: the deepest node that maps a file owns it,
  // including a descendant claiming a specific file inside a directory this node
  // globs. Recursing beyond direct children keeps this identical to the subject-set
  // carve (getChildMappingExclusions), so ctx.node.files and the hashed subject set
  // agree even when a grandchild owns a file under an organizational parent.
  const childMappingEntries: string[] = [];
  const collectDescendantMappings = (n: ModelNode): void => {
    for (const child of n.children) {
      for (const raw of child.meta.mapping ?? []) {
        const p = normalizeMappingPath(raw);
        if (p) childMappingEntries.push(p);
      }
      collectDescendantMappings(child);
    }
  };
  collectDescendantMappings(node);

  const rawMapping = (node.meta.mapping ?? [])
    .map(normalizeMappingPath)
    .filter((p): p is string => p !== '');

  // Expand directories to constituent files (gitignore-aware, nested-graph subtrees dropped).
  const expanded = await expandMappingPathsWithinOwnGraph(projectRoot, rawMapping);

  const result: Array<{ file: File; bytes: Buffer }> = [];
  for (const p of expanded) {
    // Carve out files owned by descendant nodes.
    if (childMappingEntries.length > 0 && isPathInMapping(p, childMappingEntries)) continue;
    // Skip binary files by extension.
    if (BINARY_EXTENSIONS.has(path.extname(p).toLowerCase())) continue;
    const abs = path.resolve(projectRoot, p);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(abs);
    } catch {
      continue; // unreadable — skip
    }
    const content = bytes.toString('utf8');
    result.push({ file: { path: p, content }, bytes });
    touchedFiles.push(p);
  }
  return result;
}

/**
 * Wrap a NON-subject own-file (visible through `ctx.node.files`) so reading any
 * content-derived field folds a `read:` observation on first access. Both
 * `content` AND `ast` are gated: the AST is parsed from the file bytes, so a
 * check that inspects a sibling's `.ast` is reading its content just as surely
 * as reading `.content`, and must widen invalidation identically. Both getters
 * share one record-once guard, so touching either (or both) costs exactly one
 * observation; the raw disk `bytes` make the fold byte-symmetric with
 * verifyLock's re-observation. `path` and `language` pass through untouched —
 * both are extension/path-derived, not content-derived, so a sibling content
 * edit need never invalidate on their account. If raw bytes are unavailable
 * (defensive — should not happen for a materialized own-file) the fields read
 * back plainly without recording. Spec §3.1 (Bug 1): the observation is what
 * widens invalidation, so a sibling that is never read stays immune.
 */
function wrapNonSubjectFile(
  f: File,
  repoRelPosixPath: string,
  bytes: Buffer | undefined,
  recorder: ObservationRecorder,
): File {
  if (bytes === undefined) return f;
  const { content, ast, ...rest } = f;
  let recorded = false;
  const ensureRecorded = (): void => {
    if (!recorded) {
      recorder.recordRead(repoRelPosixPath, bytes);
      recorded = true;
    }
  };
  const wrapped = { ...rest } as File;
  Object.defineProperty(wrapped, 'content', {
    enumerable: true,
    configurable: true,
    get(): string {
      ensureRecorded();
      return content;
    },
  });
  Object.defineProperty(wrapped, 'ast', {
    enumerable: true,
    configurable: true,
    get(): unknown {
      ensureRecorded();
      return ast;
    },
  });
  return wrapped;
}

/**
 * Async mapping path enumeration for prewarmup. Mapping entries may be files
 * or directories; directories are expanded via expandMappingPathsWithinOwnGraph
 * (gitignore-aware, nested-graph subtrees dropped) — this also backs
 * `ctx.graph.node().files`, so a node whose mapping happens to contain a
 * vendored dependency's own graph must not expose that dependency's files
 * as though they belonged to the enumerated node.
 */
async function enumerateMappedFilesAsync(mappingPaths: string[], projectRoot: string): Promise<string[]> {
  const normalized = mappingPaths
    .map(normalizeMappingPath)
    .filter((p): p is string => p !== '');
  return expandMappingPathsWithinOwnGraph(projectRoot, normalized);
}

export interface LoadHookModuleParams {
  aspectDir: string;
  projectRoot: string;
  /** 'check.mjs' (deterministic) | 'companion.mjs' (LLM resolver). */
  filename: string;
  /** Error code raised on import/syntax failure (default STRUCTURE_LOADER_RESOLVE_FAILED). */
  resolveFailedCode?: string;
}

/**
 * Dynamically import a user-authored hook module (check.mjs or companion.mjs)
 * from the aspect directory. Returns the loaded module record. Throws a
 * StructureRunnerError on import/syntax failure. Export-shape validation is the
 * caller's job (each hook has a different required export name and validator).
 */
export async function loadHookModule(params: LoadHookModuleParams): Promise<Record<string, unknown>> {
  ensureLoaderRegistered();
  const { aspectDir, projectRoot, filename } = params;
  const resolveFailedCode = params.resolveFailedCode ?? 'STRUCTURE_LOADER_RESOLVE_FAILED';
  const aspectDirAbs = path.isAbsolute(aspectDir) ? aspectDir : path.resolve(projectRoot, aspectDir);
  const modulePath = path.join(aspectDirAbs, filename);
  try {
    return await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
  } catch (err) {
    throw new StructureRunnerError(resolveFailedCode, {
      what: `Failed to load ${filename} at ${modulePath}: ${(err as Error).message}`,
      why: `The runner dynamically imports the aspect's ${filename} before invoking it.`,
      next: `Ensure ${filename} exists at the aspect directory and has no unresolved imports.`,
    });
  }
}

/**
 * How a deterministic/companion unit addresses its subject. A `node` unit is
 * owned by a real component (today's behavior, byte-identical). A `file` unit
 * has NO owning component — a file enforced by its architecture type alone
 * (coverage.type_level) — and carries its own allowance (`allowedReads`,
 * computed once per run by the caller via `collectArchitectureReach`) instead
 * of one derived from a component's mapping. `typeId` is the file's matched
 * architecture type — carried for diagnostics; the runner does not re-derive
 * anything from it.
 */
export type StructureUnit =
  | { kind: 'node'; nodePath: string }
  | { kind: 'file'; file: string; typeId: string; allowedReads: string[] };

export interface BuildUnitCtxParams {
  aspectId: string;
  unit: StructureUnit;
  graph: Graph;
  projectRoot: string;
  astCache: ParseCache;
  touchedFiles: string[];
  /**
   * Subject-scope override for a `per: file` unit owned by a component. When
   * present it overrides BOTH `ctx.files` (the unit sees only these subject
   * files) AND the observation-EXCLUSION set (a read of any OTHER node file
   * folds as a recorded `read:` observation, since it is no longer hashed as a
   * subject input). Repo-relative POSIX paths. Absent → byte-identical legacy
   * whole-node behavior. Ignored for a `unit.kind === 'file'` unit — its
   * single subject is `unit.file`, never narrowed or widened by this.
   */
  subjectScope?: string[];
}

export interface BuildUnitCtxResult {
  ctx: Ctx;
  recorder: ObservationRecorder;
  /** The resolved model node — undefined for a `unit.kind === 'file'` unit (no owning component). */
  node: ModelNode | undefined;
  /** The unit's subject-exclusion set (paths hashed as subject inputs). */
  subjectFiles: Set<string>;
  /** Own-mapping files (child carve-out applied), without AST enrichment. */
  ownFiles: File[];
  /** Files prewarmed into the AST cache (own files + relation-target files). */
  astInputSet: File[];
}

/**
 * Build the unit-scoped ctx shared by the deterministic check runner and the LLM
 * companion resolver. Extracted VERBATIM from runStructureAspect's head so the
 * deterministic path stays byte-behavior preserving: same recorder, same
 * touchedFiles, same subjectFiles set, same ctx identity (ctx.files === ctx.node.files
 * === ctx.subject reference in the whole-node case), and the same AST prewarmup.
 *
 * CRITICAL: createCtxGraph is seeded with currentNodePath = nodePath exactly as
 * the deterministic runner does — a later verify step re-observes stored
 * graph-bytype/graph-children observations and must reproduce identical hashes.
 */
export async function buildUnitCtx(params: BuildUnitCtxParams): Promise<BuildUnitCtxResult> {
  const { aspectId, unit, graph, projectRoot, astCache, touchedFiles, subjectScope } = params;
  void aspectId; // unused here — the loader threads it through unchanged; callers use it for messaging

  if (unit.kind === 'file') {
    return buildNodelessUnitCtx({ unit, projectRoot, astCache, touchedFiles });
  }

  const nodePath = unit.nodePath;
  const node = graph.nodes.get(nodePath);
  if (!node) {
    throw new StructureRunnerError('STRUCTURE_NODE_MISSING', {
      what: `Node '${nodePath}' not in graph.`,
      why: `The runner resolves the node by path to load its mapped files and aspects.`,
      next: `Pass an existing node path, or add the node to the graph.`,
    });
  }

  const allowedSet = collectAllowedReadsForAspect(nodePath, graph);

  // Construct one ObservationRecorder per run — threaded into all ctx factories.
  const recorder = new ObservationRecorder();

  // Build the own files first (needed to compute subjectFiles set before creating ctxFs).
  // We must know which paths are subject files so we can skip recording read: observations
  // for them — they are hashed separately as subject inputs in the deterministic pair hash.
  // We collect own file paths from the mapping before actually reading them so that the
  // subject set is available when ctxFs/ctxGraph/parsers are created. Nested-graph subtrees
  // are dropped the same way `core/pairs.ts` drops them from the fingerprint this subject
  // set stands in for — a foreign file must never be treated as this pair's subject.
  const ownFilesRaw = (node.meta.mapping ?? [])
    .map(normalizeMappingPath)
    .filter((p): p is string => p !== '');
  const ownFilesExpanded = await expandMappingPathsWithinOwnGraph(projectRoot, ownFilesRaw);
  // The observation-EXCLUSION set: paths hashed as subject inputs are NOT
  // double-recorded as observations. For a `per: file` pair (subjectScope set)
  // this is exactly that file, so a sibling read folds as an observation
  // (contract #8). Absent → the whole node mapping (legacy behavior).
  const subjectFiles = subjectScope !== undefined
    ? new Set<string>(subjectScope.map(normalizeMappingPath))
    : new Set<string>(ownFilesExpanded);

  const ctxFs = createCtxFs({ allowedSet, projectRoot, touchedFiles, recorder, subjectFiles });
  // Pre-expand each graph-readable node's mapping to concrete files (directory
  // and glob entries resolved here in the async layer) so ctx.graph.node().files
  // sees a glob-mapped node's real files. Each graph file's read: observation
  // folds lazily inside ctx.graph (only when the check reads its `.content`), so
  // a path-only check does not widen its verdict to every sibling's bytes.
  const expandedFilesByNode = new Map<string, string[]>();
  for (const id of computeAllowedNodePaths(nodePath, graph)) {
    const m = graph.nodes.get(id);
    if (m) expandedFilesByNode.set(id, await enumerateMappedFilesAsync(m.meta.mapping ?? [], projectRoot));
  }
  const ctxGraph = createCtxGraph({ currentNodePath: nodePath, graph, projectRoot, touchedFiles, expandedFilesByNode, recorder, subjectFiles });
  const parsers = createCtxParsers({ allowedSet, projectRoot, touchedFiles, astCache, recorder, subjectFiles });

  const ownFilesWithBytes = await buildOwnFiles(node, projectRoot, touchedFiles);
  const ownFiles = ownFilesWithBytes.map((x) => x.file);
  // Raw disk bytes per own-file path — used to fold a byte-symmetric read:
  // observation if the check accesses a non-subject sibling's content (Bug 1).
  const bytesByPath = new Map<string, Buffer>();
  for (const x of ownFilesWithBytes) bytesByPath.set(normalizeMappingPath(x.file.path), x.bytes);
  // Eagerly parse own-mapping files so ctx.files carry .ast + .language (AST-aspect parity).
  await prewarmupAstCache({ astCache, projectRoot, files: ownFiles });

  const ownFilesEnriched = enrichFilesWithAst(ownFiles, astCache);
  // ctx.node.files always exposes the FULL node mapping (node-scoped, §1). When
  // the subject set is narrowed (subjectScope set, i.e. a per: file pair), a
  // NON-subject sibling here has its `content` wrapped in a getter that folds a
  // read: observation on first access — so a check that reads a sibling's
  // preloaded content (no ctx.fs call) still invalidates when that sibling is
  // edited (spec §3.1, Bug 1). A sibling that is NEVER accessed records nothing,
  // preserving scope.files-excluded immunity: the filter bounds the subject, the
  // OBSERVATION bounds invalidation.
  //
  // When the subject set is NOT narrowed (per: node, no override) every own-file
  // is a subject — nothing to wrap — and ctx.node.files IS ctx.files (same array
  // reference; the documented alias holds).
  let nodeFilesEnriched: File[];
  let ctxFilesEnriched: File[];
  if (subjectScope !== undefined) {
    nodeFilesEnriched = recorder !== undefined
      ? ownFilesEnriched.map((f) => {
          const p = normalizeMappingPath(f.path);
          if (subjectFiles.has(p)) return f; // subject — hashed as a subject input
          return wrapNonSubjectFile(f, p, bytesByPath.get(p), recorder);
        })
      : ownFilesEnriched;
    // ctx.files is the scope-driven subject view: exactly the subjectScope files.
    ctxFilesEnriched = ownFilesEnriched.filter((f) => subjectFiles.has(normalizeMappingPath(f.path)));
  } else {
    nodeFilesEnriched = ownFilesEnriched;
    ctxFilesEnriched = ownFilesEnriched;
  }
  // ctx.node reads of `type` / `ports` must fold the node's identity into the
  // verdict, else a check that gates on ctx.node.type (a documented cookbook
  // pattern) produces a stale-green verdict when the type/ports later change.
  // A Proxy records the same graph:<self> observation a ctx.graph.node(self) call
  // would — lazily, so a check that never reads type/ports pays nothing. (id,
  // mapping, files are already covered: nodePath is hashed, subject files hashed,
  // node.files reads fold their own observations.)
  const rawCtxNode = {
    id: node.path,
    type: node.meta.type,
    mapping: node.meta.mapping ?? [],
    files: nodeFilesEnriched,
    ports: (node.meta.ports ?? {}) as Record<string, Port>,
  };
  const ctxNode = new Proxy(rawCtxNode, {
    get(target, prop, receiver) {
      if (prop === 'type' || prop === 'ports') {
        recordNodeGraphObservation(recorder, projectRoot, node);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const ctx: Ctx = {
    node: ctxNode,
    files: ctxFilesEnriched,
    // ctx.subject is the unit's subject file(s): for the deterministic whole-node
    // case it is the SAME array reference as ctx.files; for a per:file unit it is
    // exactly the narrowed subject view (also ctx.files here). Identical reference
    // in both branches keeps the alias contract.
    subject: ctxFilesEnriched,
    fs: ctxFs,
    graph: ctxGraph,
    parseAst: parsers.parseAst,
    parseYaml: parsers.parseYaml,
    parseJson: parsers.parseJson,
    parseToml: parsers.parseToml,
  };

  // PREWARMUP. Compute AST input set, prewarm cache.
  const astInputSet: File[] = [...ownFiles];
  for (const rel of (node.meta.relations ?? [])) {
    const target = graph.nodes.get(rel.target);
    if (!target) continue;
    for (const p of await enumerateMappedFilesAsync(target.meta.mapping ?? [], projectRoot)) {
      const abs = path.resolve(projectRoot, p);
      try {
        const content = fs.readFileSync(abs, 'utf8');
        astInputSet.push({ path: p, content });
      } catch {/* skip */}
    }
  }
  await prewarmupAstCache({ astCache, projectRoot, files: astInputSet });

  return { ctx, recorder, node, subjectFiles, ownFiles, astInputSet };
}

/**
 * Build the ctx for a unit with NO owning component — a file enforced by its
 * architecture type alone (coverage.type_level). `unit.allowedReads` (computed
 * once per run by the caller via `collectArchitectureReach`, structure/allowed-reads.ts)
 * stands in for the component-derived allow-set `ctx.fs` / `ctx.parseAst` enforce
 * identically (no logic change there — only the allowance SET differs).
 *
 * `ctx.node` and `ctx.graph` are unavailable: there is no yg-node.yaml backing
 * either, so every property access on `ctx.node` and every `ctx.graph.*` call
 * raises `StructureNodeContextUnavailableError` — translated to the typed,
 * fail-closed `STRUCTURE_NODE_CONTEXT_UNAVAILABLE` disposition at the runner
 * boundary (structure/runner.ts) — rather than a silent empty/undefined result
 * an author could mistake for "reachable, but nothing there."
 *
 * The observation seed starts empty and STAYS empty for anything graph-shaped:
 * because ctx.graph refuses every call, the graph:/graph-children:/graph-bytype:/
 * graph-flow: observation kinds can never be recorded here — precisely why
 * re-verification needs no component (verify-lock.ts's `reObserve` never has to
 * resolve any of those keys for a nodeless pair).
 */
async function buildNodelessUnitCtx(params: {
  unit: Extract<StructureUnit, { kind: 'file' }>;
  projectRoot: string;
  astCache: ParseCache;
  touchedFiles: string[];
}): Promise<BuildUnitCtxResult> {
  const { unit, projectRoot, astCache, touchedFiles } = params;

  const allowedSet = new Set<string>(unit.allowedReads);
  const recorder = new ObservationRecorder();
  // The subject is the file itself, so its own content is a subject input and
  // is not double-recorded — mirrors the whole-node per:file case exactly.
  const subjectFiles = new Set<string>([unit.file]);

  const ctxFs = createCtxFs({ allowedSet, projectRoot, touchedFiles, recorder, subjectFiles });
  const parsers = createCtxParsers({ allowedSet, projectRoot, touchedFiles, astCache, recorder, subjectFiles });

  // Read the subject file directly — there is no mapping to expand and no
  // children to carve out (there is no component). Binary-by-extension and
  // unreadable are both skipped silently, mirroring buildOwnFiles' own
  // per-file policy; ctx.subject simply reads back empty in that case, same
  // as a vanished own-file does for a real node.
  const ownFiles: File[] = [];
  if (!BINARY_EXTENSIONS.has(path.extname(unit.file).toLowerCase())) {
    try {
      const content = fs.readFileSync(path.resolve(projectRoot, unit.file), 'utf8');
      ownFiles.push({ path: unit.file, content });
      touchedFiles.push(unit.file);
    } catch {/* unreadable — skip, mirrors buildOwnFiles */}
  }

  // Eagerly parse the subject file so ctx.subject carries .ast + .language
  // (AST-aspect parity) — exactly as the whole-node path does for ctx.files.
  await prewarmupAstCache({ astCache, projectRoot, files: ownFiles });
  const ownFilesEnriched = enrichFilesWithAst(ownFiles, astCache);

  const ctxNode = new Proxy({} as Ctx['node'], {
    get(_target, prop): never {
      throw new StructureNodeContextUnavailableError(`node.${String(prop)}`);
    },
  });
  const ctxGraph = createNodelessCtxGraph();

  const ctx: Ctx = {
    node: ctxNode,
    files: ownFilesEnriched,
    // ctx.subject === ctx.files: the same array reference (the documented
    // alias contract), there being no ctx.node.files to alias to instead.
    subject: ownFilesEnriched,
    fs: ctxFs,
    graph: ctxGraph,
    parseAst: parsers.parseAst,
    parseYaml: parsers.parseYaml,
    parseJson: parsers.parseJson,
    parseToml: parsers.parseToml,
  };

  return {
    ctx,
    recorder,
    node: undefined,
    subjectFiles,
    ownFiles: ownFilesEnriched,
    astInputSet: ownFilesEnriched,
  };
}

export interface RunCompanionHookParams {
  aspectDir: string;
  aspectId: string;
  unit: StructureUnit;
  graph: Graph;
  projectRoot: string;
  parseCache?: ParseCache;
  /** Subject-scope override for a per:file unit (see BuildUnitCtxParams). */
  subjectScope?: string[];
}

export type CompanionInfra = { kind: 'infra'; messageData: IssueMessage };
export type RunCompanionHookResult =
  | { kind: 'ok'; descriptors: CompanionDescriptor[]; touchedFiles: string[]; observations: Array<[string, string]>; observationsTainted: boolean }
  | CompanionInfra;

function companionInfra(what: string, why: string, next: string): CompanionInfra {
  return { kind: 'infra', messageData: { what, why, next } };
}

/**
 * Load and run an aspect's companion.mjs over a unit, returning the resolved
 * companion descriptors (paths the LLM reviewer should additionally see).
 *
 * The companion hook NEVER judges — every failure path (import/syntax error, bad
 * export, hook throw, bad return shape, or a declared-read error raised by ctx)
 * maps to INFRA-FAIL, never to a Violation. Unlike check.mjs, the companion
 * return MAY be a Promise and IS awaited (await-allow policy): a thenable return
 * does NOT throw STRUCTURE_CHECK_ASYNC.
 *
 * Returns the recorder snapshot so the caller (fill-llm) can fold the hook's
 * out-of-subject observations into the LLM pair hash (`touched`).
 */
export async function runCompanionHook(params: RunCompanionHookParams): Promise<RunCompanionHookResult> {
  const { aspectDir, aspectId, unit, graph, projectRoot, subjectScope } = params;
  const ownCache = !params.parseCache;
  const astCache: ParseCache = params.parseCache ?? new Map();
  const touchedFiles: string[] = [];
  try {

  // 1. Load companion.mjs — infra-fail on import/syntax error.
  let mod: Record<string, unknown>;
  try {
    mod = await loadHookModule({
      aspectDir,
      projectRoot,
      filename: 'companion.mjs',
      resolveFailedCode: 'COMPANION_LOADER_RESOLVE_FAILED',
    });
  } catch (err) {
    if (err instanceof StructureRunnerError) {
      return { kind: 'infra', messageData: err.messageData };
    }
    return companionInfra(
      `Failed to load companion.mjs for aspect '${aspectId}': ${(err as Error).message}`,
      `The runner dynamically imports the aspect's companion.mjs before resolving companions.`,
      `Ensure companion.mjs exists at the aspect directory and has no unresolved imports.`,
    );
  }

  // 2. Validate the export is a callable `companion`.
  const fn = mod.companion;
  if (typeof fn !== 'function') {
    return companionInfra(
      `companion.mjs does not export a function named 'companion' (aspect '${aspectId}'; got ${typeof fn}).`,
      `The runner imports the named export 'companion' and calls companion(ctx).`,
      `Add 'export function companion(ctx) { ... }' to companion.mjs (it may be async).`,
    );
  }

  // Build the unit-scoped ctx (shared with the deterministic runner).
  let built: BuildUnitCtxResult;
  try {
    built = await buildUnitCtx({ aspectId, unit, graph, projectRoot, astCache, touchedFiles, subjectScope });
  } catch (err) {
    if (err instanceof StructureRunnerError) {
      return { kind: 'infra', messageData: err.messageData };
    }
    throw err;
  }
  const { ctx, recorder } = built;

  // 3. Run the hook — AWAIT (companion MAY be async; do NOT throw STRUCTURE_CHECK_ASYNC).
  //    Declared-read errors raised by ctx during the hook → INFRA-FAIL (the hook
  //    never judges), NOT a Violation.
  let out: unknown;
  try {
    out = await (fn as (ctx: Ctx) => unknown)(ctx);
  } catch (err) {
    // ctx.node / ctx.graph accessed on a unit with no owning component (a
    // companion resolving over a file enforced by its architecture type
    // alone): this error is thrown ONLY by buildNodelessUnitCtx's ctx.node
    // Proxy and createNodelessCtxGraph()'s methods (ctx-graph.ts), so `unit`
    // is guaranteed `kind === 'file'` here — never a bug in companion.mjs
    // itself, always a hook written for a component that this unit does not
    // have. A typed, fail-closed infra disposition (never a Violation, never
    // a stack trace, never a phantom component name), naming both exits —
    // mirrors runner.ts's STRUCTURE_NODE_CONTEXT_UNAVAILABLE translation for
    // the deterministic path.
    if (err instanceof StructureNodeContextUnavailableError) {
      const target = unit.kind === 'file' ? unit.file : unit.nodePath;
      return companionInfra(
        `companion.mjs for aspect '${aspectId}' on '${target}' accessed ctx.${err.member}: this paired-file rule needs a component to work.`,
        `The file is enforced by its architecture type alone — there is no owning component, so there is no yg-node.yaml to back ctx.node or ctx.graph.`,
        `Give the file a component of its own (a yg-node.yaml mapping it) so ctx.node/ctx.graph become available, or rewrite the companion to use only ctx.subject/ctx.fs over files the architecture already permits this file's type to reach.`,
      );
    }
    if (
      err instanceof UndeclaredFsReadError ||
      err instanceof UndeclaredGraphReadError ||
      err instanceof ParseAstNotPrewarmedError
    ) {
      return companionInfra(
        `companion.mjs for aspect '${aspectId}' read an undeclared path or node: ${(err as Error).message}`,
        `A companion resolves the prompt only — it cannot judge code, so an undeclared read is an infrastructure fault, not a code violation.`,
        `Declare a relation in yg-node.yaml to the node owning that path, or read only relation-reachable files.`,
      );
    }
    return companionInfra(
      `companion hook threw while resolving companions (aspect '${aspectId}'): ${(err as Error).message}`,
      `${(err as Error).stack ?? ''}`,
      `Fix the bug in companion.mjs, then re-run: yg check --approve`,
    );
  }

  // 4. Validate the return is CompanionDescriptor[] (array of { path: string, label?: string }).
  if (!Array.isArray(out)) {
    return companionInfra(
      `companion.mjs returned ${typeof out}, expected an array of { path: string, label?: string } (aspect '${aspectId}').`,
      `The runner attaches each returned path to the reviewer prompt; a non-array return cannot be interpreted.`,
      `Return [] or { path, label? }[] from companion.`,
    );
  }
  const descriptors: CompanionDescriptor[] = [];
  for (const d of out) {
    if (typeof d !== 'object' || d === null || typeof (d as CompanionDescriptor).path !== 'string') {
      return companionInfra(
        `companion.mjs returned an entry that is not { path: string, label?: string } (aspect '${aspectId}').`,
        `Each companion descriptor must carry a string 'path' (and an optional string 'label').`,
        `Return objects shaped { path: string, label?: string } from companion.`,
      );
    }
    const dd = d as CompanionDescriptor;
    if (dd.label !== undefined && typeof dd.label !== 'string') {
      return companionInfra(
        `companion.mjs returned an entry whose 'label' is not a string (aspect '${aspectId}'; got ${typeof dd.label}).`,
        `A companion descriptor's optional 'label' is a human tag and must be a string when present.`,
        `Omit 'label' or set it to a string in companion.`,
      );
    }
    descriptors.push({ path: dd.path, ...(dd.label !== undefined ? { label: dd.label } : {}) });
  }

  return {
    kind: 'ok',
    descriptors,
    touchedFiles,
    observations: recorder.snapshot(),
    observationsTainted: recorder.tainted,
  };
  } finally {
    if (ownCache) destroyParseCache(astCache);
  }
}
