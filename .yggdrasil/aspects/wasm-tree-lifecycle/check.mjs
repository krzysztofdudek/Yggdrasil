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

    // Namespace bindings of the parser module (`import * as p from '.../parser'`),
    // through which `p.parseFile(...)` reaches the banned function without a named import.
    const parserNamespaces = new Set();
    const isParserSource = (src) => src.endsWith('/parser') || src.endsWith('/parser.js');

    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'import_statement') return;

      const source = node.childForFieldName('source');
      if (!source) return false;
      const src = source.text.slice(1, -1); // strip surrounding quotes
      // Only care about imports from the ast/parser module.
      if (!isParserSource(src)) return false;

      const clause = node.namedChildren.find((c) => c.type === 'import_clause');
      if (!clause) return false;

      // Namespace import: record the binding so a later `<ns>.parseFile` is caught.
      const namespaceImport = clause.namedChildren.find((c) => c.type === 'namespace_import');
      if (namespaceImport) {
        const id = namespaceImport.namedChildren.find((c) => c.type === 'identifier');
        if (id) parserNamespaces.add(id.text);
      }

      // Named import of 'parseFile' (with or without an alias) — banned directly.
      const named = clause.namedChildren.find((c) => c.type === 'named_imports');
      if (named) {
        for (const spec of named.namedChildren) {
          if (spec.type !== 'import_specifier') continue;
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
      }
      return false; // no nested import_statement nodes
    });

    // Second pass: a `<parserNamespace>.parseFile` member access evades the named-import
    // ban but reaches the same WASM-leaking function.
    if (parserNamespaces.size > 0) {
      walk(file.ast.rootNode, (node) => {
        if (node.type !== 'member_expression') return;
        const obj = node.childForFieldName('object');
        const prop = node.childForFieldName('property');
        if (obj?.type === 'identifier' && parserNamespaces.has(obj.text) && prop?.text === 'parseFile') {
          violations.push(
            report(
              file,
              node,
              `namespace access '${obj.text}.parseFile' reaches parseFile without a named import — ` +
              `use withParsedFile from ast/parser instead; parseFile returns a WASM-heap Tree that JS GC ` +
              `cannot reclaim, and withParsedFile guarantees tree.delete() in a finally block`,
            ),
          );
        }
      });
    }
  }

  return violations;
}
