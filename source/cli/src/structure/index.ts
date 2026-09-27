export type { Ctx, File, FsEntry, GraphNode, Port, Relation, Violation, CheckFunction, CompanionFunction, CompanionDescriptor, RelationType } from './types.js';
export { runStructureAspect, StructureRunnerError } from './runner.js';
// Suppress-range resolver — the architecture-legal bridge that lets the engine
// (cli/core/fill) and the aspect-test command resolve LLM-prompt suppress spans
// without importing ast/* directly.
export { resolveSuppressedRangesForPrompt, SuppressMarkerError } from './suppress-ranges.js';
// ParseCache — the shared per-run AST cache type, plus its WASM-safe destructor
// (a ParseCache holds native web-tree-sitter Tree objects that must be deleted
// explicitly; JS GC never frees them). Re-exported so the engine (cli/core/fill,
// cli/core/companion-resolve) can own a cache scoped to one (aspect, node)
// bucket — sharing it across a rule's subjects on the same node — without
// importing ast/* directly (same bridge pattern as the suppress-range resolver
// above).
export type { ParseCache } from '@chrisdudek/runes/ast';
export { destroyParseCache } from '@chrisdudek/runes/ast';
// Re-export AST helpers for structure aspect authors.
// closest/walk come from @chrisdudek/runes/ast, the AST helpers the relation extractors use too.
export { walk, closest } from '@chrisdudek/runes/ast';
export { report } from '../ast/report.js';
export { inFile, type InFilePattern } from '../ast/file-path.js';
export { findComments, type FindCommentsTarget } from '../ast/find-comments.js';
