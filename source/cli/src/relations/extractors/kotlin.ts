import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';
import { single } from './types.js';
import { kotlinView, type KotlinView } from './kotlin-recover.js';

/**
 * Kotlin dependency extractor — the FIRST language that resolves through the shared
 * SymbolTable rather than a path mapping.
 *
 * WHY A SYMBOL TABLE (not path arithmetic): Kotlin decouples a file's `package`
 * declaration from its directory (unlike Java's enforced package = directory layout),
 * and `.kts` scripts may have no package at all. So a file's FULLY-QUALIFIED names
 * cannot be derived from its path — they must be read from the parsed `package_header`
 * plus each declaration's simple name. `declarations()` therefore emits the FQNs this
 * file DEFINES (`<package>.<Name>`), which the pass folds into ONE shared SymbolTable;
 * `uses()` emits SYMBOL hints (the imported FQN) that resolve through that table via
 * `resolveUnique`. There is NO `resolve-path.ts` branch for Kotlin — symbol hints never
 * touch `resolvePathToFile`.
 *
 * v1 scope = EXISTENCE, not relation type. The unit of an inter-component edge in
 * Kotlin is the IMPORT: an `import` statement names a fully-qualified symbol (or, for a
 * wildcard import, a package). Usage-site nodes — `:` supertype lists, `by` delegation,
 * qualified calls, type references, `::` callable references — would only REFINE the
 * relation type of an already-imported binding, and v1 does not enforce relation type.
 * This extractor performs NO usage-site refinement: it emits exactly one symbol hint
 * per import.
 *
 * D6 PROBE (empirically confirmed against the shipped tree-sitter-grammars wasm):
 *  - The import node is `import` (a NAMED node), NOT `import_header`. Its FQN is the
 *    child `qualified_identifier` whose `.text` is the dotted path.
 *  - A wildcard `import com.foo.*` parses with the `qualified_identifier` ALREADY equal
 *    to the package (`com.foo`); the `*` is a separate unnamed token. So the FQN text is
 *    the package as-is. v1 emits the package FQN as the symbol hint (documented below).
 *  - An aliased `import com.foo.Bar as B` keeps the `qualified_identifier` as the real
 *    FQN (`com.foo.Bar`); the alias is a trailing `identifier` child. The alias is
 *    IGNORED — the hint is the FQN.
 *  - `package_header` has a `qualified_identifier` child (NO `name` field); its `.text`
 *    is the package FQN, possibly absent (root package).
 *  - `class_declaration` (which ALSO covers `interface`!), `object_declaration`, and
 *    `function_declaration` carry a `name` field (an `identifier`). `property_declaration`
 *    and `type_alias` do NOT: a property's name sits under a `variable_declaration`
 *    child's `identifier`; a type alias's name is a direct `identifier` child.
 *
 * STAR IMPORTS: `import com.foo.*` emits the hint `com.foo.*` (the `*` kept as a marker the
 * resolver recognises). The resolver collapses it by owner exactly like Java's on-demand
 * import: the files declaring a direct top-level member of `com.foo` (or the classifier
 * `com.foo`, for a star import of an enum's entries / an object's members) → one owning node
 * → one edge; zero or two or more owners → silence. It is never expanded into per-name edges.
 *
 * ONE JVM NAMESPACE: Kotlin declares into, and resolves against, the same namespace as Java
 * (symbol-table.ts), so an import of a Java class binds, and a Java import of a Kotlin class or
 * file facade binds. A file with a top-level function or property also declares its JVM FILE
 * FACADE (`<File>Kt`, or the `@file:JvmName` name): Kotlin source can never name a facade, so
 * that key is only ever matched by a Java consumer.
 *
 * LOCAL DECLARATIONS (inside a function body, lambda, `init` block, accessor, secondary
 * constructor, or object expression) have no FQN and are not importable: they are NOT keyed.
 *
 * PARSE RECOVERY: the shipped grammar predates Kotlin 2.2 and turns a when-guard, a
 * multi-dollar string or a context-parameter clause into an ERROR that runs to the end of the
 * file. Both walks go through `kotlinView` (kotlin-recover.ts), which blanks those forms and
 * re-parses, re-parses what is still damaged one top-level declaration at a time, and reports
 * what it could not read. Unreadable parts become INCOMPLETENESS MARKERS: `<package>.*` (the
 * file may declare anything in its package) and `<package>.<Type>+*` (some members of `Type`
 * are unreadable). A marker never binds anything; the resolver uses it only to keep the
 * ambiguity the unreadable declarations might have created (fail closed).
 *
 * stdlib / external imports (`kotlin.*`, `kotlinx.*`, `java.*`, AndroidX, third-party)
 * still emit a symbol hint here — silence is the SymbolTable's job (an FQN no in-graph
 * file declares resolves to undefined and is never flagged).
 *
 * INLINE FULLY-QUALIFIED TYPE references (`val x: app.dto.Req`, `: app.base.Base()`
 * supertype, `List<app.dto.Item>`) ARE emitted — as symbol hints, exactly like imports. A
 * fully-qualified type written without an import appears as a `user_type` whose leading
 * children are the dotted `identifier` segments. This node type occurs ONLY in TYPE
 * positions: an EXPRESSION-position dotted reference (`app.logging.Logger()`) parses as a
 * `navigation_expression` chain, never a `user_type`, so reading `user_type` captures type
 * references exclusively and never the member-access ambiguity. Only a MULTI-segment
 * user_type (≥2 dotted identifiers) is emitted — a bare `String` is import/same-package
 * resolved and stays silent. Resolution is the SymbolTable's distinct-file rule, so a name
 * that could bind two ways silences; an import-qualified nested ref (`Outer.Inner`, whose
 * `Outer` carries an import that already covers the edge) matches no package-qualified key
 * and stays silent — detection is additive recall with zero false positives. A type's
 * generic ARGUMENTS are nested `user_type`s and are emitted independently; the leading
 * segment collection stops at the first non-identifier child (the `type_arguments`).
 */

/** The FQN `qualified_identifier` child of an `import` node, as dotted text. A
 *  single-segment import is a bare `identifier` instead. Returns its `.text`. */
function importFqn(decl: Node): string | undefined {
  for (let i = 0; i < decl.namedChildCount; i++) {
    const child = decl.namedChild(i);
    if (child === null) continue;
    if (child.type === 'qualified_identifier' || child.type === 'identifier') {
      return child.text;
    }
  }
  return undefined;
}

/** The dotted FQN of a `user_type`: its LEADING `identifier` children joined by `.`,
 *  stopping at the first non-identifier child (a `type_arguments` generic list). Returns
 *  undefined for a single-segment type (`String`) — not a fully-qualified reference. */
function dottedUserType(node: Node): string | undefined {
  const segs: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c === null) continue;
    if (c.type === 'identifier') segs.push(c.text);
    else break; // type_arguments / nested structure → stop the dotted prefix
  }
  return segs.length >= 2 ? segs.join('.') : undefined;
}

/** True when an `import` node is a star import (`import a.b.*`): the `*` is its own token. */
function isStarImport(decl: Node): boolean {
  for (let i = 0; i < decl.childCount; i++) {
    const c = decl.child(i);
    if (c !== null && !c.isNamed && c.type === '*') return true;
  }
  return false;
}

/** Walk every trustworthy root of a view, never descending into an ERROR subtree. */
function walkView(view: KotlinView, visit: (node: Node) => boolean | undefined): void {
  for (const root of view.roots) {
    walk(root, (node) => (node.type === 'ERROR' ? false : visit(node)));
  }
}

/** Run `fn` over the recovered view of `file`, releasing any tree the recovery made. */
function withView<T>(file: ParsedFile, fn: (view: KotlinView) => T): T {
  const view = kotlinView(file.tree, file.content);
  try {
    return fn(view);
  } finally {
    view.dispose();
  }
}

function uses(file: ParsedFile): DetectedDep[] {
  return withView(file, (view) => usesOf(view));
}

function usesOf(view: KotlinView): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();

  const emit = (symbolKey: string | undefined, node: Node, kind: 'import' | 'type-ref' = 'import'): void => {
    if (symbolKey === undefined || symbolKey === '') return;
    const line = node.startPosition.row + 1;
    const dedupKey = `${symbolKey} ${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push(single({ kind: 'symbol', symbolKey }, kind, line));
  };

  walkView(view, (node) => {
    // Inline FQN type reference: a multi-segment `user_type` (type position only — an
    // expression-position dotted reference is a navigation_expression, never a user_type).
    if (node.type === 'user_type') {
      emit(dottedUserType(node), node, 'type-ref');
      return undefined;
    }

    // Match the NAMED `import` node, never the bare `import` keyword token.
    if (node.type !== 'import' || !node.isNamed) return undefined;
    // The FQN is the qualified_identifier text. For a star import the text is the package
    // (the `*` is a separate token), emitted as `<package>.*` so the resolver collapses it by
    // owner; for an alias the trailing identifier (the `as B` binding) is a separate child and
    // is NOT returned by importFqn — so the FQN is emitted unchanged.
    const fqn = importFqn(node);
    emit(fqn !== undefined && isStarImport(node) ? `${fqn}.*` : fqn, node);
    return undefined;
  });

  return out;
}

/** The simple name an `import`/`package`-bearing declaration defines, or undefined.
 *  `class`/`interface`/`object`/`function` carry a `name` field; a `property` nests it
 *  under `variable_declaration`; a `type_alias` exposes a direct `identifier` child. */
function declarationName(node: Node): string | undefined {
  const nameField = node.childForFieldName('name');
  if (nameField !== null) return nameField.text;

  if (node.type === 'property_declaration') {
    // `val x = ...` → variable_declaration → identifier. (A multi_variable_declaration
    // destructures; v1 indexes only the single-name form, the common top-level case.)
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null && c.type === 'variable_declaration') {
        const id = firstIdentifier(c);
        if (id !== undefined) return id;
      }
    }
    return undefined;
  }

  if (node.type === 'type_alias') {
    // `typealias Money = Long` → first named identifier child is the alias name.
    return firstIdentifier(node);
  }

  return undefined;
}

/** The text of the first named `identifier` descendant child of `node` (shallow). */
function firstIdentifier(node: Node): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c !== null && c.type === 'identifier') return c.text;
  }
  return undefined;
}

const DECLARATION_TYPES = new Set([
  'class_declaration', // covers both `class` and `interface`
  'object_declaration',
  'function_declaration',
  'property_declaration',
  'type_alias',
]);

/** The classifier nodes a nested declaration can sit INSIDE — its enclosing-type chain.
 *  `class`/`interface` (`class_declaration`), `object` (`object_declaration`), and a
 *  `companion object` (`companion_object`, whose JVM/source name is `Companion`). A
 *  `function_declaration` is NEVER an enclosing TYPE (a local class inside a function is not
 *  importable from outside), so it is excluded from the chain. */
const ENCLOSING_TYPE_TYPES = new Set([
  'class_declaration',
  'object_declaration',
  'companion_object',
]);

/** Ancestors that make a declaration LOCAL (no FQN, not importable): a function body, a
 *  lambda or anonymous function, an `init` block, an accessor, a secondary constructor, an
 *  object expression, or any statement block / control-structure body. */
const LOCAL_SCOPE_TYPES = new Set([
  'function_body',
  'lambda_literal',
  'anonymous_function',
  'anonymous_initializer',
  'getter',
  'setter',
  'secondary_constructor',
  'object_literal',
  'block',
  'control_structure_body',
  'when_entry',
  'catch_block',
  'finally_block',
]);

function isLocal(node: Node): boolean {
  for (let cur = node.parent; cur !== null; cur = cur.parent) {
    if (LOCAL_SCOPE_TYPES.has(cur.type)) return true;
  }
  return false;
}

/** The JVM file-facade class name of a `.kt` file: the `@file:JvmName("…")` argument when
 *  present, else the file name (without `.kt`, non-identifier characters as `_`, first letter
 *  upper-cased) + `Kt`. Undefined for a script (`.kts`), which compiles to a script class. */
function facadeName(file: ParsedFile, view: KotlinView): string | undefined {
  if (!file.path.endsWith('.kt')) return undefined;
  let jvmName: string | undefined;
  walkView(view, (node) => {
    if (jvmName !== undefined) return false;
    if (node.type !== 'file_annotation') return node.type === 'source_file' ? undefined : false;
    const inv = node.namedChildren.find((c) => c?.type === 'constructor_invocation');
    const typeName = inv?.namedChildren.find((c) => c?.type === 'user_type')?.text;
    if (typeName !== 'JvmName' && typeName !== 'kotlin.jvm.JvmName') return false;
    const str = inv?.descendantsOfType('string_content')[0]?.text;
    if (str !== undefined && str !== '') jvmName = str;
    return false;
  });
  if (jvmName !== undefined) return jvmName;
  const base = file.path.slice(file.path.lastIndexOf('/') + 1, -'.kt'.length).replace(/[^A-Za-z0-9_$]/g, '_');
  if (base === '') return undefined;
  const safe = /^[0-9]/.test(base) ? `_${base}` : base;
  return `${safe[0].toUpperCase()}${safe.slice(1)}Kt`;
}

/** The enclosing-TYPE chain of `node`, read from its ancestor chain, outermost-first. A
 *  nested `class Inner` inside `class Outer` yields `["Outer"]`; deeper nesting yields
 *  `["Outer", "Mid"]`; a member inside a `companion object` yields `["Outer", "Companion"]`.
 *  Empty when the declaration is top-level (not nested in another type). Joined with the
 *  declaration's own simple name by the reflection separator `+` (Kotlin's JVM binary name
 *  is `Outer$Inner`; the analyzer's canonical key is `Outer+Inner` — same boundary), which
 *  is DISJOINT from the package `.` so a nested key lives in a string space no dot-only use
 *  candidate can match (separator isolation). This is what stops a nested `Inner` from being
 *  keyed as the bare top-level `<package>.Inner` and silencing — or mis-binding — a real
 *  top-level type of the same simple name in another node. */
function enclosingTypeChain(node: Node): string[] {
  const parts: string[] = [];
  let cur: Node | null = node.parent;
  while (cur !== null) {
    if (ENCLOSING_TYPE_TYPES.has(cur.type)) {
      // A `companion object` has no `name` field — its canonical name is `Companion`.
      const name = cur.type === 'companion_object' ? 'Companion' : cur.childForFieldName('name')?.text;
      if (name !== undefined && name !== '') parts.unshift(name);
    }
    cur = cur.parent;
  }
  return parts;
}

/**
 * The FULLY-QUALIFIED symbol keys this file DEFINES. Reads the file's `package_header`
 * (the package FQN, possibly empty for a root-package / `.kts` file), then for each
 * declaration (top-level AND nested) emits `<package>.<TypeKey>`, or just `<TypeKey>` when
 * the package is empty.
 *
 * `<TypeKey>` is the enclosing-TYPE chain joined to the declaration's own simple name by the
 * reflection separator `+`: a top-level `Order` is `Order`; a nested `Inner` inside `Outer`
 * is `Outer+Inner`; a member of a `companion object` is `Outer+Companion+member`. A NESTED
 * declaration emits ONLY its `+` key — NEVER also the bare `<package>.<SimpleName>`. Keying
 * a nested type flat (the v1 bug) manufactured a phantom top-level FQN: a `class Outer { class
 * Inner }` produced `<package>.Inner`, which a consumer's `import <package>.Inner` (in Kotlin
 * that names a TOP-LEVEL type, never the nested `Outer.Inner`) would mis-bind to this file —
 * a false positive — or which would collide with a real top-level `<package>.Inner` in another
 * node and silence its legitimate edge. The `+` key lives in a string space disjoint from the
 * dot-only namespace, so it cannot collide; a use of `import <package>.Outer.Inner` resolves
 * to it through the resolver's guarded `+`-boundary split (`Outer` is a declared type → split
 * to `<package>.Outer+Inner`).
 *
 * These keys feed the shared SymbolTable; a use's import FQN resolves against them.
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  return withView(file, (view) => declarationsOf(file, view));
}

function declarationsOf(file: ParsedFile, view: KotlinView): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  const seen = new Set<string>();
  const add = (symbolKey: string, line: number): void => {
    if (seen.has(symbolKey)) return;
    seen.add(symbolKey);
    out.push({ symbolKey, line });
  };

  let pkg = '';
  walkView(view, (node) => {
    if (node.type !== 'package_header') return undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null && c.type === 'qualified_identifier') {
        pkg = c.text;
        return false; // first package_header wins; stop descending it
      }
    }
    return false;
  });

  const qualify = (typeKey: string): string => (pkg === '' ? typeKey : `${pkg}.${typeKey}`);
  let topLevelCallable = false;
  walkView(view, (node) => {
    if (!DECLARATION_TYPES.has(node.type)) return undefined;
    if (isLocal(node)) return undefined;
    const name = declarationName(node);
    if (name === undefined || name === '') return undefined;
    const chain = enclosingTypeChain(node);
    if (chain.length === 0 && (node.type === 'function_declaration' || node.type === 'property_declaration')) {
      topLevelCallable = true;
    }
    add(qualify([...chain, name].join('+')), node.startPosition.row + 1);
    return undefined;
  });

  // Declarations read only from a damaged declaration's leading tokens, and the markers for
  // what could not be read at all (see the file doc comment, PARSE RECOVERY).
  for (const d of view.lexical) {
    if (d.kind === 'callable') topLevelCallable = true;
    add(qualify(d.name), d.line);
  }
  for (const typeName of view.incompleteTypes) add(qualify(`${typeName}+*`), 1);
  if (view.packageIncomplete) add(qualify('*'), 1);

  if (topLevelCallable) {
    const facade = facadeName(file, view);
    if (facade !== undefined) add(qualify(facade), 1);
  }
  return out;
}

export const kotlinExtractor: DependencyExtractor = {
  languages: new Set(['kotlin']),
  rev: 3,
  declarations,
  uses,
};
