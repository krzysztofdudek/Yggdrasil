import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DeclaredSymbol, ParsedFile } from './types.js';
import { includeUses } from './c-cpp-shared.js';

/**
 * C dependency extractor.
 *
 * v1 scope = EXISTENCE, not relation type. C has no module system; the ONLY parse-time
 * reference that names a concrete in-repo file is a QUOTED preprocessor include
 * (`#include "header.h"`). A dependency edge is therefore established ONLY by a quoted
 * include — shared with the C++ extractor through `includeUses` (the `preproc_include`
 * node is identical in both grammars). Angle includes (`#include <stdio.h>`) are
 * system/third-party → skipped; macro includes (`#include HDR`) have no literal path →
 * skipped.
 *
 * Usage-site work — function calls (`call_expression`), type references, function
 * pointers — is DEFERRED: a call binds at LINK time to whatever translation unit the
 * linker pairs it with, and a function-like macro is AST-identical to a call, so neither
 * can be attributed to a node without a prototype/definition index this v1 layer does not
 * build. So this extractor performs NO usage-site refinement.
 *
 * The `.h` extension binds to the C grammar (not cpp) in the language registry, so this
 * extractor handles both `.c` and `.h` files. A C++ header named `Foo.h` therefore parses
 * here under C — its `#include` lines are still detectable (the only thing v1 reads), but
 * header-declared C++ inheritance/namespaces are a documented coverage gap (handled, if at
 * all, by a later definition-index layer, not here).
 */

const uses = includeUses;

/**
 * Top-level declarations — a thin parity layer (C resolves dependencies by include PATH,
 * not by symbol, so a C SymbolTable is not load-bearing in v1). Emits the names of
 * top-level definitions:
 *   - `function_definition`  (field `declarator` → `function_declarator` → `identifier`)
 *   - `struct_specifier`     (field `name` = type_identifier)
 *   - `type_definition`      (typedef; the declared `type_identifier`)
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  walk(file.tree.rootNode, (node) => {
    if (node.type === 'function_definition') {
      const name = functionName(node);
      if (name !== undefined) out.push({ symbolKey: name, line: node.startPosition.row + 1 });
      return undefined;
    }
    if (node.type === 'struct_specifier') {
      const nameNode = node.childForFieldName('name');
      if (nameNode !== null) out.push({ symbolKey: nameNode.text, line: node.startPosition.row + 1 });
      return undefined;
    }
    if (node.type === 'type_definition') {
      // A typedef may declare one or more type_identifiers; emit each.
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child !== null && child.type === 'type_identifier') {
          out.push({ symbolKey: child.text, line: node.startPosition.row + 1 });
        }
      }
      return undefined;
    }
    return undefined;
  });
  return out;
}

/** Drill through a `function_definition`'s `declarator` field — which may be a
 *  `pointer_declarator` wrapping a `function_declarator` — to the inner identifier name. */
function functionName(def: Node): string | undefined {
  let declarator: Node | null = def.childForFieldName('declarator');
  while (declarator !== null && declarator.type !== 'function_declarator') {
    declarator = declarator.childForFieldName('declarator');
  }
  if (declarator === null) return undefined;
  const id = declarator.childForFieldName('declarator');
  return id !== null ? id.text : undefined;
}

export const cExtractor: DependencyExtractor = {
  languages: new Set(['c']),
  rev: 2,
  declarations,
  uses,
};
