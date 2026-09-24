import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';
import { single } from './types.js';

/**
 * Java dependency extractor.
 *
 * v1 scope = EXISTENCE, not relation type. The unit of an inter-component edge in
 * Java is the IMPORT: an `import_declaration` names a fully-qualified type (or, for
 * a wildcard import, a package). A dependency edge is therefore established ONLY by
 * an import declaration. Usage-site nodes (`extends`/`implements` super-types,
 * `object_creation_expression`, `method_invocation`, fully-qualified type
 * references, same-package references) would only REFINE the relation type of an
 * already-imported binding, and v1 does not enforce relation type — so this
 * extractor performs NO usage-site refinement. It emits exactly one path hint per
 * import, whose specifier is a Java FULLY-QUALIFIED NAME (a type FQN, or a package
 * FQN for a wildcard); the resolver maps that FQN → a file by Java's
 * package = directory convention.
 *
 * Each `import_declaration` carries one named `scoped_identifier` whose `.text` is
 * the dotted FQN (the grammar nests dotted names rightmost-outermost, so the
 * outermost node's `.text` is the complete dotted string — read it directly, never
 * reassemble segments). Two anonymous variant markers modify what that FQN means:
 *   - a `static` token child  (`import static com.foo.Bar.method;`) — the FQN's
 *     LAST segment is a member, not a type. Drop it: the dependency TYPE is
 *     `com.foo.Bar`. (A static-on-demand `import static com.foo.Bar.*;` has the
 *     asterisk instead, so it is handled by the wildcard branch and keeps the
 *     class FQN intact.)
 *   - an `asterisk` named child (`import com.foo.*;`) — the FQN is a PACKAGE prefix
 *     (`com.foo`), not a type. Emit the package FQN as-is; the resolver maps it to
 *     the package directory (any `.java` in it owns the dependency).
 *
 * `java.*` / `javax.*` / `jakarta.*` stdlib imports and any external-library import
 * still emit a hint here — silence is the RESOLVER's job (an FQN that maps to no
 * mapped `.java` resolves to undefined and is never flagged).
 *
 * INLINE FULLY-QUALIFIED TYPE references (`com.app.X x;`, `new com.app.X()`,
 * `extends com.app.Base`, `catch (com.app.E e)`, `List<com.app.Item>`) ARE emitted — as
 * SYMBOL hints, not path hints. A fully-qualified type written without an import appears in
 * the grammar as a `scoped_type_identifier` (dotted, e.g. `com.app.X`). This node type
 * occurs ONLY in TYPE positions: an EXPRESSION-position dotted access (`com.app.Helper.f()`)
 * parses as a `field_access`/`method_invocation` chain, NEVER a `scoped_type_identifier`, so
 * reading `scoped_type_identifier` captures type references exclusively and never the
 * member-access ambiguity. The hint is a SYMBOL hint resolved through the shared SymbolTable
 * (this is the one Java form that makes `declarations()` load-bearing): the table's
 * distinct-file rule silences any dotted name that could bind two ways (a fully-qualified
 * `com.app.Outer.Inner` resolves via the guarded `+`-split to the nested-type key; a
 * `Map.Entry`-style import-qualified nested ref matches no package key and stays silent), so
 * detection is additive recall with zero false positives. The OUTERMOST scoped_type_identifier
 * of a nested chain carries the complete dotted FQN — inner ones (the `scope` segments) are
 * skipped. Import declarations carry `scoped_identifier` (never `scoped_type_identifier`), so
 * they are untouched by this branch and stay path-resolved.
 *
 * MODULE IMPORT DECLARATIONS (`import module M;`, JEP 511, Java 25) are SKIPPED. The
 * operand is a MODULE name, not a type FQN or a package directory: the set of simple
 * names it brings lives in compiled module-path metadata (`java.base`'s jmods, a
 * third-party JAR) a hermetic source-only tool never reads, and a module exports many
 * packages from many directories, so there is no single path to map. A `module` import
 * is recognized by the `module` soft keyword and emitted as NO hint — so it can never
 * resolve to a phantom (in the pre-JEP-511 grammar an `import module M;` parses
 * malformed, with the swallowed `module` keyword leaving a whitespace-bearing pseudo-FQN
 * like `"module java.base"`; the same guard, plus a whitespace-validity backstop in
 * `emit`, drops it cleanly either way).
 *
 * MODULE DECLARATIONS (`module-info.java`) carry TYPE references in their `uses` /
 * `provides … with …` directives — genuine fully-qualified, shadow-free service-type
 * FQNs that resolve exactly like a single-type import. They ARE emitted as TYPE path
 * hints. The `requires` / `exports` / `opens` directives carry MODULE / PACKAGE names
 * (never types) and are EXCLUDED — mapping a module/package name to a `.java` would be a
 * phantom. (A `provides … with …` provider class is the kind of service-provider edge
 * the relation-conformance check tolerates as a declared relation even without code
 * backing; emitting it is sound — it is a real, shadow-free type reference.)
 */

/** Drop the trailing segment of a dotted FQN: `com.foo.Bar.method` → `com.foo.Bar`.
 *  Returns undefined when there is no segment to drop (a single bare segment). */
function dropLastSegment(fqn: string): string | undefined {
  const idx = fqn.lastIndexOf('.');
  if (idx <= 0) return undefined;
  return fqn.slice(0, idx);
}

/** The single FQN node of an `import_declaration`: its named `scoped_identifier`
 *  (or a bare `identifier` for a single-segment import). Returns its `.text`. */
function importFqn(decl: Node): string | undefined {
  for (let i = 0; i < decl.namedChildCount; i++) {
    const child = decl.namedChild(i);
    if (child === null) continue;
    if (child.type === 'scoped_identifier' || child.type === 'identifier') {
      return child.text;
    }
  }
  return undefined;
}

/** True when `decl` has an anonymous `static` token child (a static import). */
function isStaticImport(decl: Node): boolean {
  for (let j = 0; j < decl.childCount; j++) {
    const c = decl.child(j);
    if (c !== null && !c.isNamed && c.type === 'static') return true;
  }
  return false;
}

/** True when `decl` has a named `asterisk` child (a wildcard / on-demand import). */
function isWildcardImport(decl: Node): boolean {
  for (let j = 0; j < decl.childCount; j++) {
    const c = decl.child(j);
    if (c !== null && c.type === 'asterisk') return true;
  }
  return false;
}

/**
 * True when `decl` is a module import declaration `import module M;` (JEP 511, Java 25).
 * A module import names a MODULE, not a type/package — its imported set is unreadable
 * module-path metadata — so it must emit NO hint (see the file doc comment).
 *
 * Two recognition paths, covering grammar versions on both sides of JEP 511:
 *   - FUTURE grammar: an anonymous `module` token child (parallel to the `static`
 *     token of a static import).
 *   - PRE-JEP-511 grammar (the one shipped today): `import module M;` parses MALFORMED
 *     — the `module` soft keyword is swallowed as the first `identifier` of the
 *     `scoped_identifier`, leaving an ERROR node, so the node's text begins with the
 *     literal `module` followed by whitespace (`"module java.base"`). Detect the leading
 *     `module` identifier of an erroring scoped_identifier.
 */
function isModuleImport(decl: Node): boolean {
  for (let j = 0; j < decl.childCount; j++) {
    const c = decl.child(j);
    if (c !== null && !c.isNamed && c.type === 'module') return true; // future grammar
  }
  // Pre-JEP-511 fallback: a malformed `scoped_identifier` whose first identifier is the
  // swallowed `module` soft keyword.
  for (let i = 0; i < decl.namedChildCount; i++) {
    const child = decl.namedChild(i);
    if (child === null) continue;
    if (child.type === 'scoped_identifier' && child.hasError) {
      const firstId = firstIdentifierText(child);
      if (firstId === 'module') return true;
    }
  }
  return false;
}

/** The leftmost `identifier`'s text in a (possibly nested) `scoped_identifier`, or
 *  undefined. The grammar nests dotted names rightmost-outermost, so the leftmost leaf
 *  identifier is the first dotted segment. */
function firstIdentifierText(node: Node): string | undefined {
  let cur: Node | null = node;
  while (cur !== null) {
    if (cur.type === 'identifier') return cur.text;
    let next: Node | null = null;
    for (let i = 0; i < cur.namedChildCount; i++) {
      const c = cur.namedChild(i);
      if (c !== null && (c.type === 'scoped_identifier' || c.type === 'identifier')) {
        next = c;
        break;
      }
    }
    cur = next;
  }
  return undefined;
}

function uses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();

  const emit = (specifier: string | undefined, node: Node, isPackage = false): void => {
    if (specifier === undefined || specifier === '') return;
    // Whitespace-validity backstop: a real Java FQN has no whitespace. A specifier that
    // contains any (e.g. the malformed `"module java.base"` of a pre-JEP-511 `import
    // module` parse) is not a resolvable FQN — drop it rather than risk a phantom path.
    if (/\s/.test(specifier)) return;
    const line = node.startPosition.row + 1;
    const dedupKey = `${specifier} ${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push(single({ kind: 'path', specifier, isPackage }, 'import', line));
  };

  // Inline fully-qualified type references resolve as SYMBOL hints (see file doc comment).
  // Keyed separately from the path-hint dedup so an FQN that appears both as an import and
  // inline is not cross-suppressed (different hint kinds, different resolution axes).
  const seenSym = new Set<string>();
  const emitSymbol = (symbolKey: string, node: Node): void => {
    if (symbolKey === '' || /\s/.test(symbolKey)) return;
    const line = node.startPosition.row + 1;
    const dedupKey = `${symbolKey} ${line}`;
    if (seenSym.has(dedupKey)) return;
    seenSym.add(dedupKey);
    out.push(single({ kind: 'symbol', symbolKey }, 'type-ref', line));
  };

  walk(file.tree.rootNode, (node) => {
    // Inline FQN type reference: the OUTERMOST scoped_type_identifier of a chain carries the
    // complete dotted FQN; inner ones are its `scope` segments. Type positions only — an
    // expression-position dotted access is a field_access chain, never this node.
    if (node.type === 'scoped_type_identifier' && node.parent?.type !== 'scoped_type_identifier') {
      emitSymbol(node.text, node);
      return undefined;
    }

    // `module-info.java`: emit the TYPE references of `uses` / `provides … with …`
    // directives ONLY (shadow-free service-type FQNs). `requires` / `exports` / `opens`
    // carry module/package names and are skipped (they are not `*_module_directive`
    // type-bearing forms we read).
    if (node.type === 'uses_module_directive' || node.type === 'provides_module_directive') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c !== null && (c.type === 'scoped_identifier' || c.type === 'identifier')) {
          emit(c.text, c);
        }
      }
      return undefined;
    }

    if (node.type !== 'import_declaration') return undefined;

    // `import module M;` (JEP 511) names a module, not a type/package → emit nothing.
    if (isModuleImport(node)) return undefined;

    const fqn = importFqn(node);
    if (fqn === undefined) return undefined;

    const wildcard = isWildcardImport(node);
    const isStatic = isStaticImport(node);

    if (wildcard) {
      // `import com.foo.*;`            → package FQN `com.foo` (a directory of types).
      // `import static com.foo.Bar.*;` → the scoped_identifier IS the class FQN
      //   `com.foo.Bar` (static-on-demand); it is a TYPE, not a package.
      emit(fqn, node, /* isPackage */ !isStatic);
    } else if (isStatic) {
      // `import static com.foo.Bar.method;` → drop the trailing member → type FQN.
      emit(dropLastSegment(fqn), node);
    } else {
      // Plain single-type import → the FQN is the type.
      emit(fqn, node);
    }
    return undefined;
  });

  return out;
}

const DECLARATION_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
]);

/** The package FQN of a compilation unit, read from its `package_declaration`'s
 *  `scoped_identifier` (a bare `identifier` for a single-segment package). Empty string
 *  for the unnamed/default package. */
function packageFqn(file: ParsedFile): string {
  let pkg = '';
  walk(file.tree.rootNode, (node) => {
    if (node.type !== 'package_declaration') return undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null && (c.type === 'scoped_identifier' || c.type === 'identifier')) {
        pkg = c.text;
        return false; // first package_declaration wins; stop descending it
      }
    }
    return false;
  });
  return pkg;
}

/** The enclosing-TYPE chain of `node`, outermost-first: the `name` of every ancestor
 *  `class`/`interface`/`enum`/`record` declaration. A nested `class Inner` inside
 *  `class Outer` yields `["Outer"]`; deeper nesting yields `["Outer", "Mid"]`; empty for a
 *  top-level declaration. Joined to the declaration's own simple name by the reflection
 *  separator `+` (Java's JVM binary name is `Outer$Inner`; the analyzer's canonical key is
 *  `Outer+Inner` — same boundary), DISJOINT from the package `.` so a nested key lives in a
 *  string space no dot-only candidate can collide with (separator isolation). */
function enclosingTypeChain(node: Node): string[] {
  const parts: string[] = [];
  let cur: Node | null = node.parent;
  while (cur !== null) {
    if (DECLARATION_TYPES.has(cur.type)) {
      const name = cur.childForFieldName('name')?.text;
      if (name !== undefined && name !== '') parts.unshift(name);
    }
    cur = cur.parent;
  }
  return parts;
}

/**
 * The FULLY-QUALIFIED symbol keys this file DEFINES. Java IMPORTS resolve by PATH first (the
 * package = directory convention under the importing file's ancestors), and fall back to this
 * table — the JVM namespace Java shares with Kotlin — only when that probe misses (a sibling
 * Maven/Gradle module, `src/test` → `src/main`, a Kotlin class or file facade; see resolver.ts).
 * The INLINE FULLY-QUALIFIED TYPE form (`uses()` emits a `symbol` hint for a
 * `scoped_type_identifier`) always resolves through the table. Either way the table's
 * distinct-file rule + guarded `+`-split give ambiguity→silence. Reads
 * the file's `package_declaration`, then for each `class`/`interface`/`enum`/`record`
 * declaration (top-level AND nested) emits `<package>.<TypeKey>` (or `<TypeKey>` for the
 * unnamed package).
 *
 * `<TypeKey>` is the enclosing-TYPE chain joined to the declaration's own simple name by `+`:
 * a top-level `Order` is `Order`; a nested `Inner` inside `Outer` is `Outer+Inner`. A NESTED
 * declaration emits ONLY its `+` key — NEVER also a bare flat `Inner`. Keying a nested type
 * flat (the latent v1 shape, mirrored on the pre-fix Kotlin bug) manufactured a phantom
 * top-level name: `class Outer { class Inner }` produced the bare `Inner`, which — the instant
 * any Java symbol consumer existed — a top-level `import <pkg>.Inner` (in Java that names a
 * TOP-LEVEL type, never the nested `Outer.Inner`) would mis-bind to this file (a false
 * positive), or which would collide with a real `<pkg>.Inner` in another node and silence its
 * legitimate edge. The `+` key lives in a string space disjoint from the dot-only namespace,
 * so it cannot collide; a nested-type use resolves to it through the resolver's guarded
 * `+`-boundary split — e.g. an inline `new com.app.Outer.Inner()` symbol hint splits at the
 * declared `com.app.Outer` type to the `com.app.Outer+Inner` key.
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  const pkg = packageFqn(file);
  walk(file.tree.rootNode, (node) => {
    if (!DECLARATION_TYPES.has(node.type)) return undefined;
    const nameNode = node.childForFieldName('name');
    if (nameNode === null || nameNode.text === '') return undefined;
    const typeKey = [...enclosingTypeChain(node), nameNode.text].join('+');
    const symbolKey = pkg === '' ? typeKey : `${pkg}.${typeKey}`;
    out.push({ symbolKey, line: node.startPosition.row + 1 });
    return undefined;
  });
  return out;
}

export const javaExtractor: DependencyExtractor = {
  languages: new Set(['java']),
  rev: 3,
  declarations,
  uses,
};
