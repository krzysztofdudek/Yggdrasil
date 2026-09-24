import type { Node } from 'web-tree-sitter';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile, TargetHint } from './types.js';
import { single } from './types.js';
import { rubyUnderscore } from './ruby-resolve.js';

/**
 * Ruby dependency extractor — the LAST language, and honestly the LOWEST-detectability
 * one. Ruby uses BOTH hint kinds:
 *
 *   - PATH hints (`require_relative '<literal>'`) — the ONLY file-precise static link in
 *     the language. Resolved by `ruby-resolve.ts` relative to the requiring file.
 *   - SYMBOL hints (constants) — `class C < Base`, `include/extend/prepend Mod`,
 *     `Foo::Bar`, a bare `constant` used as a value/receiver. Resolved through the shared
 *     SymbolTable like Kotlin/C#.
 *
 * WHY MOSTLY SILENT (the honest framing): Ruby has no syntactic file binding for a
 * constant — a name carries only a name, never a path. Class/module REOPENING (a `class
 * Foo` body that adds to an `Foo` defined elsewhere) is indistinguishable at the AST
 * level from a fresh definition, so a reopened constant has 2+ definitions in the
 * SymbolTable → `resolveUnique` returns undefined → SILENCE. Zeitwerk/Rails autoload
 * means a constant is used with NO `require` at all; `const_get`/`send` metaprogramming
 * uses dynamic strings (never a `constant` node). The net effect: `require_relative` is
 * precise; a constant binds only when Ruby's own lookup (Module.nesting, nearest first)
 * reaches exactly one in-repo definition that cannot be a reopening of a core class or a
 * framework namespace, and anything less certain is silenced. This trades recall for ZERO
 * false positives BY DESIGN (D8 — no waiver, a false red blocks CI with no escape).
 *
 * v1 SCOPE = EXISTENCE, not relation type. The edge is "depends on a constant/file owned
 * by another node". No `calls`/`uses`/`extends`/`implements` classification here.
 *
 * D6 PROBE (verified against the shipped tree-sitter-ruby wasm by parsing real Ruby):
 *   - `require_relative` is a `call` (NOT a node type): `method` field = `identifier`
 *     text `require_relative`, NO `receiver` field, `arguments` = `argument_list` whose
 *     first named child is a `string` (children: `string_content`, no `interpolation`).
 *   - `class`: `name` field = `constant`; `superclass` field = `superclass` node whose
 *     single named child is a `constant` or `scope_resolution`.
 *   - `module`: `name` field = `constant`; `body` = `body_statement` (nests modules/classes).
 *   - `scope_resolution`: `scope` field (a `constant` or nested `scope_resolution`) + `name`
 *     field (a `constant`). `.text` preserves `::` as written; a leading `::Top` is a
 *     `scope_resolution` whose `scope` field is null.
 *   - include/extend/prepend: a `call`, NO receiver, `method`=identifier, `arguments`=
 *     `argument_list` with `constant`/`scope_resolution` arguments.
 *   - `assignment`: `left`/`right` fields; a top-level constant has a `constant` on `left`.
 *   - qualified call: a `call` whose `receiver` field is a `constant`/`scope_resolution`.
 *   - `class << self` parses as `singleton_class` (`value` field = `self`) — no `constant`
 *     name, so it is naturally excluded.
 */

/** Canonicalize a constant-name node (`constant` or `scope_resolution`) to a stable
 *  symbolKey string. A `scope_resolution` keeps the `::` separators as written; a leading
 *  `::` (top-level absolute reference) is stripped so it matches a definition recorded
 *  without it. Returns undefined for anything that is not a constant-name node. */
function constantKey(node: Node | null): string | undefined {
  if (node === null) return undefined;
  if (node.type === 'constant') {
    const t = node.text;
    return t === '' ? undefined : t;
  }
  if (node.type === 'scope_resolution') {
    // `.text` preserves the full `A::B::C` (and a leading `::`). Strip a single leading
    // `::` so an absolute reference resolves against the same key a definition records.
    const t = node.text.replace(/^::/, '');
    return t === '' ? undefined : t;
  }
  return undefined;
}

/** The first named child of a node (or null). */
function firstNamedChild(node: Node): Node | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c !== null) return c;
  }
  return null;
}

/** True when this `call` node is a bare (no-receiver) call to one of the given method
 *  names. Used for `require_relative` and the include/extend/prepend mixins. */
function isBareCallTo(node: Node, methods: ReadonlySet<string>): boolean {
  if (node.type !== 'call') return false;
  if (node.childForFieldName('receiver') !== null) return false;
  const method = node.childForFieldName('method');
  return method !== null && method.type === 'identifier' && methods.has(method.text);
}

/** The literal string argument of a `require_relative`-style call, or undefined. The
 *  argument must be a `string` with a single `string_content` child and NO `interpolation`
 *  child (a dynamic / interpolated argument is NOT statically resolvable → skip). */
function literalStringArg(callNode: Node): string | undefined {
  const args = callNode.childForFieldName('arguments');
  if (args === null) return undefined;
  const first = firstNamedChild(args);
  if (first === null || first.type !== 'string') return undefined;
  let content: string | undefined;
  for (let i = 0; i < first.namedChildCount; i++) {
    const c = first.namedChild(i);
    if (c === null) continue;
    if (c.type === 'interpolation') return undefined; // dynamic → not resolvable
    if (c.type === 'string_content') content = c.text;
  }
  return content; // undefined for an empty string `''` (no string_content child)
}

const MIXIN_METHODS = new Set(['include', 'extend', 'prepend']);
const REQUIRE_RELATIVE = new Set(['require_relative']);

/**
 * The dependency hints this file emits. TWO kinds:
 *   - PATH: a `require_relative '<lit>'` → `{kind:'path', specifier:<lit>}`.
 *   - SYMBOL: a superclass constant, a mixin-argument constant, a `scope_resolution`, and
 *     a bare `constant` used as a value/receiver → an ordered candidate group of symbol hints.
 *
 * LEXICAL RESOLUTION (Module.nesting). The walk keeps the lexical nesting: the FQN of every
 * enclosing class/module, innermost first (`module Shop; class Cart` → [Shop::Cart, Shop];
 * a compact `class Shop::Cart` at top level → [Shop::Cart] only, exactly as Ruby records it).
 * A reference is turned into candidates the way Ruby looks it up:
 *   - `::A::B` (rooted) is absolute → the single key `A::B`.
 *   - at top level (empty nesting) → the single key as written (cref is Object).
 *   - inside a namespace, `A::B` or a bare `A` → `N1::A::B`, `N2::A::B`, … for each nesting
 *     entry, nearest first, then the top-level `A::B`. A nesting candidate carries its
 *     first-segment name (`rubyAnchor`): when that name exists but the full candidate does
 *     not, Ruby has committed to it and the reference is silenced. The top-level fallback
 *     carries `rubyInheritGuard`: when any in-repo namespace nests a constant named `A`, it
 *     may be inherited through the enclosing class's ancestors, so the fallback is silenced.
 * The shared candidate walk takes the first candidate that binds (resolver.ts).
 *
 * A superclass is looked up in the scope that CONTAINS the `class` keyword (the outer
 * nesting); mixins and value uses in a body are looked up in the body's nesting.
 *
 * Definition-position constants (a `class`/`module` `name` field) are EXCLUDED so a node
 * never depends on itself. The superclass and mixin constants are emitted under the same
 * symbol channel (v1 does not classify relation type). To avoid double-counting and stray
 * descent, the walk handles each construct then prunes its constant children.
 */
function uses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();

  const emitPath = (specifier: string | undefined, line: number): void => {
    if (specifier === undefined || specifier === '') return;
    const dedupKey = `path\0${specifier}\0${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push(single({ kind: 'path', specifier }, 'import', line));
  };

  const emitConstant = (ref: Node | null, nesting: readonly string[], line: number): void => {
    const key = constantKey(ref);
    if (ref === null || key === undefined) return;
    const rooted = ref.type === 'scope_resolution' && ref.text.trimStart().startsWith('::');
    const scope = rooted ? [] : nesting;
    const dedupKey = `symbol\0${key}\0${scope.join(',')}\0${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    if (scope.length === 0) {
      out.push(single({ kind: 'symbol', symbolKey: key }, 'import', line));
      return;
    }
    const first = key.split('::')[0];
    const multi = key.includes('::');
    const candidates: TargetHint[] = scope.map((ns) =>
      multi
        ? { kind: 'symbol', symbolKey: `${ns}::${key}`, rubyAnchor: `${ns}::${first}` }
        : { kind: 'symbol', symbolKey: `${ns}::${key}` },
    );
    candidates.push({ kind: 'symbol', symbolKey: key, rubyInheritGuard: first });
    out.push({ candidates, kind: 'import', line });
  };

  const visit = (node: Node, nesting: readonly string[]): void => {
    // (a) require_relative '<lit>' → PATH hint. Path links never shadow; nesting-agnostic.
    if (isBareCallTo(node, REQUIRE_RELATIVE)) {
      emitPath(literalStringArg(node), node.startPosition.row + 1);
      return; // a string arg, no constant children to descend for symbols
    }

    // (b) class C < Base / module M → superclass in the OUTER nesting, then the body under
    //     the extended nesting.
    if (node.type === 'class' || node.type === 'module') {
      if (node.type === 'class') {
        const sup = node.childForFieldName('superclass');
        if (sup !== null) {
          const expr = firstNamedChild(sup);
          emitConstant(expr, nesting, (expr ?? sup).startPosition.row + 1);
        }
      }
      const body = node.childForFieldName('body');
      if (body !== null) {
        const nameNode = node.childForFieldName('name');
        const name = constantKey(nameNode);
        const rootedName = nameNode !== null && nameNode.text.trimStart().startsWith('::');
        const fqn = name === undefined ? undefined : rootedName || nesting.length === 0 ? name : `${nesting[0]}::${name}`;
        const inner = fqn === undefined ? nesting : [fqn, ...nesting];
        for (let i = 0; i < body.namedChildCount; i++) {
          const c = body.namedChild(i);
          if (c !== null) visit(c, inner);
        }
      }
      return;
    }

    // (c) include / extend / prepend Mod[, Mod2] → one candidate group per constant argument.
    if (isBareCallTo(node, MIXIN_METHODS)) {
      const args = node.childForFieldName('arguments');
      if (args !== null) {
        for (let i = 0; i < args.namedChildCount; i++) {
          const arg = args.namedChild(i);
          if (arg !== null) emitConstant(arg, nesting, arg.startPosition.row + 1);
        }
      }
      return; // mixin-arg constants handled; do not descend (would re-emit)
    }

    // (d) A bare `constant` or a `scope_resolution` used as a value / receiver.
    if (node.type === 'constant' || node.type === 'scope_resolution') {
      const parent = node.parent;
      if (parent !== null) {
        if (parent.type === 'class' || parent.type === 'module') {
          const nameField = parent.childForFieldName('name');
          if (nameField !== null && nameField.id === node.id) return; // self-definition
        }
        if (parent.type === 'scope_resolution') return; // inner qualifier of a longer name
        if (parent.type === 'superclass') return; // handled in (b)
      }
      emitConstant(node, nesting, node.startPosition.row + 1);
      return; // do not descend into a scope_resolution's inner constants
    }

    // Generic descent (nesting unchanged for non-class/module containers).
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null) visit(c, nesting);
    }
  };

  visit(file.tree.rootNode, []);
  return out;
}

/**
 * True when a file path follows the Zeitwerk / gem convention for a constant's full name:
 * the file stem is the underscored last segment and the directories right above it are the
 * underscored outer segments (`…/billing/invoice.rb` for `Billing::Invoice`).
 */
function pathCorroborates(filePath: string, segments: readonly string[]): boolean {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const stem = parts[parts.length - 1].replace(/\.[^.]*$/, '');
  const dirs = parts.slice(0, -1);
  if (stem !== rubyUnderscore(segments[segments.length - 1])) return false;
  const outer = segments.slice(0, -1).map(rubyUnderscore);
  if (outer.length > dirs.length) return false;
  return outer.every((seg, i) => dirs[dirs.length - outer.length + i] === seg);
}

/**
 * The constant FQNs this file DEFINES — every `class` and `module` definition plus every
 * top-level constant assignment. The FQN is built from LEXICAL NESTING: a `class
 * OrderService` inside `module App; module Services` defines `App::Services::OrderService`.
 *
 * REOPENINGS ARE NOT DEDUPED (intentional and correct): every reopening of a class/module
 * emits another definition of the same FQN. The pass folds these into the shared
 * SymbolTable, which then has 2+ files for that FQN → the reference silences. A reopening
 * that lives in ONE file is indistinguishable from a definition here; the resolver treats
 * core classes and framework namespaces as external for exactly that reason
 * (isRubyExternalConstant).
 *
 * ZEITWERK IMPLICIT NAMESPACES: a compact `class Billing::Invoice` in `…/billing/invoice.rb`
 * relies on Zeitwerk to create `Billing` from the directory, so no file declares it. When the
 * file path corroborates the full name (pathCorroborates), the implicit outer namespaces are
 * declared by this file too, which anchors the root (resolver.ts rubyRootUnanchored). A
 * compact declaration whose path does not match (a stub `module Rack::Handler` in
 * `server_stub.rb`) anchors nothing.
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];

  // Walk with an explicit namespace stack so nested class/module names get their FQN.
  const visit = (node: Node, nsStack: string[]): void => {
    if (node.type === 'class' || node.type === 'module') {
      const nameField = node.childForFieldName('name');
      const name = constantKey(nameField);
      if (name !== undefined) {
        const fqn = nsStack.length === 0 ? name : `${nsStack.join('::')}::${name}`;
        const line = node.startPosition.row + 1;
        out.push({ symbolKey: fqn, line });
        if (nameField !== null && nameField.type === 'scope_resolution') {
          const segments = fqn.split('::');
          if (pathCorroborates(file.path, segments)) {
            for (let k = 1; k < segments.length; k++) {
              out.push({ symbolKey: segments.slice(0, k).join('::'), line });
            }
          }
        }
        // Descend into the body under the EXTENDED namespace. The name itself may be a
        // scoped name (`class A::B`), in which case it already carries its own prefix; push
        // the whole FQN so deeper nesting concatenates correctly.
        const body = node.childForFieldName('body');
        if (body !== null) {
          const childNs = [...nsStack, name];
          for (let i = 0; i < body.namedChildCount; i++) {
            const c = body.namedChild(i);
            if (c !== null) visit(c, childNs);
          }
        }
        return;
      }
    }

    // Top-level constant assignment: `MAX = 5`, `MyAlias = OriginalClass`. The `left` field
    // is a `constant`. (A scoped `Foo::BAR = ...` assignment to a constant is rare and not
    // a node-defining declaration — skip; only a bare top-level constant is indexed.)
    if (node.type === 'assignment') {
      const left = node.childForFieldName('left');
      if (left !== null && left.type === 'constant') {
        const name = left.text;
        if (name !== '') {
          const fqn = nsStack.length === 0 ? name : `${nsStack.join('::')}::${name}`;
          out.push({ symbolKey: fqn, line: node.startPosition.row + 1 });
        }
      }
      // An assignment's right-hand side is a USE, not a definition — do not recurse for defs.
      return;
    }

    // Generic descent for everything else (the body_statement of a class/module is reached
    // via the explicit recursion above; here we cover the top-level program and any other
    // container that may hold a class/module/assignment).
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null) visit(c, nsStack);
    }
  };

  visit(file.tree.rootNode, []);
  return out;
}

export const rubyExtractor: DependencyExtractor = {
  languages: new Set(['ruby']),
  rev: 2,
  declarations,
  uses,
};
