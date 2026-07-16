// source/cli/src/structure/types.ts
// Public types exposed to structure aspect check.mjs via ctx parameter.
// These are the PUBLIC GraphNode/File/Port/Relation shapes — NOT to be
// confused with internal model/graph.ts types. Internal GraphNode has
// node.meta.{type,mapping,...} and parent/children as object refs.
// The public GraphNode here is flat — built by toPublicNode().

export interface File {
  /** repo-relative POSIX path */
  path: string;
  /** raw file content */
  content: string;
  /** parsed tree-sitter Tree, eagerly attached for files of a registered language; undefined otherwise. May carry parse errors (inspect ast.rootNode.hasError). */
  ast?: unknown;
  /** language id from the extension registry (e.g. 'typescript'); undefined for files with no registered grammar */
  language?: string;
}

export interface Port {
  description: string;
  /** aspect ids required of consumers */
  aspects: string[];
}

export type RelationType = 'calls' | 'uses' | 'extends' | 'implements' | 'emits' | 'listens';

export interface Relation {
  type: RelationType;
  /** target node path (e.g. 'orders/handler') */
  target: string;
  /** consumed port names (when applicable) */
  consumes?: string[];
}

export interface GraphNode {
  /** node path under model/ (e.g. 'cli/templates') */
  id: string;
  /** node_type id from yg-architecture.yaml */
  type: string;
  /** mapping entries from yg-node.yaml, untouched */
  mapping: string[];
  /** materialized files for this node's mapping (child carve-out applied for own node) */
  files: File[];
  ports: Record<string, Port>;
}

export interface FsEntry {
  /** basename, e.g. 'foo.ts' */
  name: string;
  kind: 'file' | 'dir';
}

export interface Ctx {
  node: GraphNode;
  /** alias for node.files (own node files with child carve-out) */
  files: File[];
  /**
   * the unit's subject file(s): per:file → single; per:node → the node's
   * subject set (same array reference as `files` for the deterministic
   * whole-node case).
   */
  subject: File[];

  fs: {
    exists(path: string): 'file' | 'dir' | false;
    list(dir: string): FsEntry[];
    read(path: string): string;
  };

  graph: {
    node(id: string): GraphNode | undefined;
    nodesByType(type: string): GraphNode[];
    relationsFrom(node: GraphNode): Relation[];
    relationsTo(node: GraphNode): Relation[];
    children(node: GraphNode): GraphNode[];
    flowParticipants(flowName: string): GraphNode[];
  };

  parseAst(file: File | string, language: string): unknown;  // sync — prewarmed by dispatcher (decision A)
  parseYaml(file: File | string): unknown;
  parseJson(file: File | string): unknown;
  parseToml(file: File | string): unknown;
}

// Approach: PREWARMUP.
// `parseAst` is async (web-tree-sitter `parseFile` returns Promise<Tree>) BUT the structure
// runner enforces synchronous `check.mjs` via the STRUCTURE_CHECK_ASYNC guard (mirroring
// AST runner). Author CANNOT `await ctx.parseAst(...)` inside `check`.
//
// NOTE: the async guard is now POLICY-PARAMETERIZED in the shared hook loader
// (structure/hook-loader.ts). `check.mjs` keeps the sync-reject policy (a thenable
// return throws STRUCTURE_CHECK_ASYNC; the return is never awaited). `companion.mjs`
// uses the await-allow policy (the return MAY be a Promise and IS awaited), so a
// companion hook can legitimately call async helpers — `parseAst` is still prewarmed
// and sync in BOTH paths.
//
// Resolution: PREWARMUP. The dispatcher pre-parses every file in the aspect's
// "AST input set" before invoking `check(ctx)`. The AST input set is auto-derived:
//   - all paths in ctx.files (own mapping minus child carve-out)
//   - all paths in ctx.node.mapping that match known AST language extensions
//     (.ts/.tsx/.js/.jsx — language registry via getGrammarForExtension /
//      getLanguageForExtension in utils/language-registry.ts)
//   - paths reachable via ctx.graph.node(target).files for each declared relation target
//     (lazy: only parsed if the aspect actually touches that node)
//
// At runtime `parseAst(file, lang)` is **synchronous**: reads from prewarmed `astCache`
// (Map<path, Tree>). Cache miss = explicit error
// `structure-aspect-parseast-not-prewarmed` directing author to:
//   (i) ensure the file is in the aspect's allowed reads set via relation, or
//   (ii) call ctx.parseYaml/Json/Toml instead (those are natively sync).
//
// Effort: +1 dev-day in dispatcher to compute AST input set and prewarmup loop before
// invoking check. Reuses existing ParseCache from ast/runner.ts (line 11 export).

export interface Violation {
  message: string;
  file?: string;
  line?: number;
  column?: number;
  /** Reserved prefix 'structure-aspect-*' for runtime emissions */
  kind?: string;
}

/** check.mjs export signature (synchronous) */
export type CheckFunction = (ctx: Ctx) => Violation[];

export interface CompanionDescriptor { path: string; label?: string }
/** companion.mjs export — MAY be async (unlike sync-only check). Returns paths, never content. */
export type CompanionFunction = (ctx: Ctx) => CompanionDescriptor[] | Promise<CompanionDescriptor[]>;
