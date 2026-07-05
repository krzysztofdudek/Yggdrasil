import { walk, report } from '@chrisdudek/yg/ast';

// These files manage WASM tree ownership explicitly and are approved for direct
// parseFile usage. Every other file must call withParsedFile instead.
//
// Approved rationale:
//   ast/parser.ts        — implements withParsedFile itself
//   ast/runner.ts        — localTrees[] ownership transferred at function exit
//   relations/pass.ts    — parseSingle() ownership-transfer adapter; callers use try/finally
//   structure/ctx-parsers.ts — prewarmupAstCache: stores into caller-owned ParseCache
const APPROVED_FILES = new Set([
  'source/cli/src/ast/parser.ts',       // implements withParsedFile
  'source/cli/src/ast/runner.ts',        // localTrees[] ownership pattern
  'source/cli/src/relations/pass.ts',    // parseSingle ownership-transfer adapter
  'source/cli/src/structure/ctx-parsers.ts', // prewarmupAstCache into caller-owned cache
]);

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (APPROVED_FILES.has(file.path)) continue;

    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'import_statement') return;

      const source = node.childForFieldName('source');
      if (!source) return false;
      const src = source.text.slice(1, -1); // strip surrounding quotes
      // Only care about imports from the ast/parser module.
      if (!src.endsWith('/parser') && !src.endsWith('/parser.js')) return false;

      // Walk named imports looking for 'parseFile'.
      const clause = node.namedChildren.find((c) => c.type === 'import_clause');
      if (!clause) return false;
      const named = clause.namedChildren.find((c) => c.type === 'named_imports');
      if (!named) return false;

      for (const spec of named.namedChildren) {
        if (spec.type !== 'import_specifier') continue;
        // For "parseFile as alias" the original name is the first named child.
        const originalName = spec.namedChildren[0]?.text ?? spec.text;
        if (originalName === 'parseFile') {
          violations.push(
            report(
              file,
              node,
              `direct import of 'parseFile' — use withParsedFile from ast/parser instead; ` +
              `parseFile returns a WASM-heap Tree that JS GC cannot reclaim, ` +
              `and withParsedFile guarantees tree.delete() in a finally block`,
            ),
          );
        }
      }
      return false; // no nested import_statement nodes
    });
  }

  return violations;
}
