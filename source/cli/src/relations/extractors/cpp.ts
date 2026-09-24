import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DeclaredSymbol, ParsedFile } from './types.js';
import { includeUses } from './c-cpp-shared.js';

/**
 * C++ dependency extractor.
 *
 * v1 scope = EXISTENCE, not relation type. Like C, C++ exposes exactly one parse-time
 * reference that names a concrete in-repo file: a QUOTED preprocessor include
 * (`#include "Order.hpp"`). A dependency edge is therefore established ONLY by a quoted
 * include — shared with the C extractor through `includeUses` (the `preproc_include` node
 * is identical in both grammars). Angle includes (`#include <vector>`) are system/
 * third-party → skipped; macro includes (`#include MYHDR`) have no literal path → skipped.
 *
 * Usage-site / definition work is DEFERRED to a later symbol/definition-index layer and is
 * NOT done here: class inheritance (`base_class_clause`), namespace-qualified references
 * (`qualified_identifier`), `using` declarations, ADL/overloaded calls, and virtual
 * dispatch all need overload resolution + a cross-node definition index this v1 layer does
 * not build. C++20 modules (`import foo;`) are unsupported by the bundled grammar (parse to
 * ERROR) and are out of scope. So this extractor performs NO usage-site refinement.
 *
 * NOTE on the `.h` split: a C++ header named `Foo.h` binds to the C grammar (not cpp) in
 * the language registry, so it is handled by the C extractor — its `#include` lines are
 * still detected (the only thing v1 reads), but header-declared inheritance/namespaces
 * under `.h` are a documented coverage gap, not handled here. This extractor handles the
 * cpp-grammar extensions: `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx`.
 */

const uses = includeUses;

/**
 * Top-level declarations — a thin parity layer (C++ resolves dependencies by include
 * PATH in v1, not by symbol). Emits the names of:
 *   - `function_definition`  (field `declarator` → function_declarator → identifier)
 *   - `struct_specifier`     (field `name` = type_identifier)
 *   - `type_definition`      (typedef; declared type_identifier)
 *   - `class_specifier`      (field `name` = type_identifier)        [C++ only]
 *   - `namespace_definition` (field `name` = namespace_identifier)   [C++ only]
 * Walks the whole tree so names nested inside a `namespace_definition` are still captured.
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  walk(file.tree.rootNode, (node) => {
    const line = node.startPosition.row + 1;
    if (node.type === 'function_definition') {
      const name = functionName(node);
      if (name !== undefined) out.push({ symbolKey: name, line });
      return undefined;
    }
    if (
      node.type === 'struct_specifier' ||
      node.type === 'class_specifier' ||
      node.type === 'namespace_definition'
    ) {
      const nameNode = node.childForFieldName('name');
      if (nameNode !== null) out.push({ symbolKey: nameNode.text, line });
      return undefined;
    }
    if (node.type === 'type_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child !== null && child.type === 'type_identifier') {
          out.push({ symbolKey: child.text, line });
        }
      }
      return undefined;
    }
    return undefined;
  });
  return out;
}

/** Drill through a `function_definition`'s `declarator` field (which may wrap a
 *  pointer/reference declarator) to the inner function_declarator's identifier name. */
function functionName(def: Node): string | undefined {
  let declarator: Node | null = def.childForFieldName('declarator');
  while (declarator !== null && declarator.type !== 'function_declarator') {
    declarator = declarator.childForFieldName('declarator');
  }
  if (declarator === null) return undefined;
  const id = declarator.childForFieldName('declarator');
  return id !== null ? id.text : undefined;
}

export const cppExtractor: DependencyExtractor = {
  languages: new Set(['cpp']),
  rev: 2,
  declarations,
  uses,
};
