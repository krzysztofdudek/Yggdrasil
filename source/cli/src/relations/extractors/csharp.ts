import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type {
  DependencyExtractor,
  DetectedDep,
  DeclaredSymbol,
  ParsedFile,
  TargetHint,
  SymbolSetMember,
} from './types.js';

/**
 * C# dependency extractor — the HARDEST language, and the design's poster child for
 * SymbolTable resolution.
 *
 * WHY A SYMBOL TABLE (and why it is harder than every imports-only language): C# has
 * NO file-level import that names a file. A `using Foo.Bar;` names a NAMESPACE, and a
 * namespace is a symbol that spans arbitrarily many files in arbitrarily many
 * directories (one file may declare several namespaces; one namespace may be split
 * across the tree). There is no compile-time file→file edge in the syntax. The
 * dependency EDGE therefore comes from a SYMBOL USE — a type reference, a `new`, a base
 * type, a qualified name — resolved to a fully-qualified name (FQN) and looked up in the
 * shared SymbolTable.
 *
 * THE MODEL (mirrors kotlin.ts: declarations build FQN keys, uses emit `{kind:'symbol'}`
 * hints, NO resolve-path branch):
 *
 *  - declarations(file): each TYPE's FQN. The enclosing namespace is read from the
 *    ancestor chain — a `namespace_declaration` (block `namespace Foo { }`) or a
 *    `file_scoped_namespace_declaration` (`namespace Foo.Bar;`), with nested namespaces
 *    concatenated. For each class/interface/struct/record/enum declaration, emit
 *    `<namespace>.<TypeChain>`, where `<TypeChain>` is the enclosing-TYPE chain joined by
 *    the .NET reflection separator `+` and ending in the type's own simple name: a
 *    top-level type is `App.Type`, a nested `Inner` in `Outer` is `App.Outer+Inner`, a
 *    file-scope nested type is `Outer+Inner`. A nested type emits ONLY its `+` key, never
 *    also the bare simple name — that removes the collision that would otherwise let a
 *    nested `Inner` silence a legitimate top-level `App.Inner`. These populate the shared
 *    SymbolTable as FQN→file. Separator isolation: nested keys use `+`, namespace boundaries
 *    use `.`, so a dot-only use candidate never accidentally matches a `+` key.
 *
 *  - uses(file): build the file's USING SCOPE first — the set of namespace prefixes from
 *    each PLAIN `using Foo.Bar;` and `global using Foo.Bar;` (D6: a `using_directive` with no
 *    `static` token child and no `name` field), plus an ALIAS map from `using Alias = Foo.Bar;`
 *    (D6: the `name` field carries the alias; the `qualified_name` sibling is the aliased FQN).
 *    `using static X;` (a `static` token child) is SKIPPED — it imports a type's static MEMBERS,
 *    not a namespace. A `global using Foo.Bar;` applies to every file of its PROJECT (R5, M6):
 *    pass.ts groups the files by nearest `.csproj` (csharp-project.ts), aggregates each project's
 *    global-using prefixes — plus its MSBuild `<Using>` items and SDK implicit usings — and
 *    injects them into each file's `uses(file, { projectGlobalUsings })` as the lowest using tier. Then, for each type reference (detected across every syntactic
 *    type position — base/`new`, field/property/parameter/return/local types, generic base names
 *    and type arguments, member-access receivers through a type name (`Guard.NotNull()`), attributes `[Foo]`/`[FooAttribute]`, generic constraints, `typeof`/`is`/`as`/
 *    cast operands, tuple/array/nullable element types, and a C#12 alias RHS's embedded named
 *    types), build ONE ORDERED candidate group in C# name-binding order (nearest scope first,
 *    verbatim/top-level LAST), and emit it as a single `DetectedDep`:
 *      [alias-expansion?]                              ← leftmost segment is a local alias
 *        ++ [enclosing-namespace chain innermost→outermost]
 *        ++ [using-prefix block, code-point sorted]    ← ONE binding level (CS0104 set)
 *        ++ [verbatim / bare top-level]                ← farthest, last
 *    The per-reference resolver (`pass.ts`) walks this group and takes the FIRST candidate
 *    that binds to a UNIQUE mapped definition — that IS the binding; it emits at most one
 *    edge and STOPS, never reaching a farther candidate. A nearer candidate that is
 *    present-but-ambiguous SILENCES the whole group rather than leaking to the verbatim
 *    top-level interpretation. The verbatim form therefore only binds when nothing nearer does
 *    — which closes the decisive C# false positive (a partially-qualified ref whose verbatim
 *    top-level reading coincides with another node's same-named type). Three C# lookup rules are
 *    encoded as hint metadata, invisible to the group's display shape (which reads only the
 *    candidate's `symbolKey`):
 *      • the using-prefix candidates form ONE CS0104 SET (R9): classification resolves the union
 *        of all using expansions; 2+ distinct files → ambiguous → silence (two imports each
 *        defining the same simple name is a real C# ambiguity, never an arbitrary pick).
 *      • a using-prefix candidate on a MULTI-segment ref is `nestedOnly` (R4): `using A;` + `B.T`
 *        may bind the nested type `A.B+T` (B a type, T nested) but NEVER the dotted `A.B.T`
 *        (B a sub-namespace) — `using A;` imports the TYPES of exactly A, not A's namespaces.
 *      • the alias candidate carries a CO-DEFINITION set (R8): the alias target competes with a
 *        same-named enclosing-ns member; 2+ resolving → ambiguous → silence.
 *    A `global::`-rooted name (R12) is stripped and resolved from the root as its sole candidate;
 *    a non-`global` extern/using alias (`Lib::A.B`) is left intact (its `::` text cannot collide
 *    with a dot-only key → R13 silence-by-luck). Nested-type recovery is centralized in the
 *    resolver: for any dotted candidate it also tries the guarded `+`-boundary split (split
 *    `s1..sk + '+' + s_{k+1}..sn` only when `s1..sk` is a declared TYPE), so a use of
 *    `Outer.Inner` resolves to the `Outer+Inner` declaration key.
 *
 * SILENCE-ON-DOUBT (D8 — no waiver; a false positive blocks CI with no escape). All of
 * the following stay silent here, by construction:
 *   - DI-container registration / reflection (`Type.GetType`, `Activator.CreateInstance`)
 *     / source generators — they surface no resolvable qualified type, so any candidate FQN they
 *     do emit resolves to nothing. (Extension-method calls are NOT dynamic: C# binds them at
 *     compile time through the namespaces in scope, so they resolve against the `<ns>.<Name>()`
 *     extension keys — see `extensionKey`.)
 *   - `using static X;` — skipped (no namespace prefix recorded).
 *   - IMPLICIT / SDK `global using`s — read from the project file when `<ImplicitUsings>` is on,
 *     but they name external namespaces, so a bare name they qualify resolves to nothing unless
 *     the repository declares it there → SILENCE. (DECLARED `global using`s are aggregated per
 *     project per R5 above.)
 *   - external-assembly / BCL types (System.*, Microsoft.*) — emit candidate FQNs, but
 *     they resolve to no in-graph file → never flagged.
 *   - any reference that does not resolve to exactly one mapped file (zero or ≥2 matches across
 *     its candidate group) → silence.
 *
 * NO resolve-path branch: symbol hints route through the table; `makeResolvePathToFile`
 * returns undefined for csharp.
 *
 * v1 SCOPE = EXISTENCE. The edge is the TYPE DEPENDENCY (the symbol use). Method-call
 * relation-TYPE classification (calls vs uses vs extends) is deferred — this extractor
 * only establishes that a dependency on another node's type exists.
 *
 * D6 PROBE (verified against the shipped tree-sitter-c_sharp wasm by parsing samples):
 *   - using_directive: PLAIN `using Foo.Bar;` → `using` token + `qualified_name` child
 *     (or a single `identifier` child for a one-segment namespace), no `name` field.
 *     `using static X;` → an anonymous `static` token child present. `global using ...;`
 *     → an anonymous `global` token child. Alias `using Gw = Foo.Bar;` → `name` FIELD =
 *     identifier `Gw`, plus the aliased `qualified_name`/`identifier` sibling.
 *   - file_scoped_namespace_declaration: `name` field = qualified_name|identifier whose
 *     `.text` is the namespace FQN.
 *   - namespace_declaration (block): `name` field + `body=declaration_list`; nests.
 *   - class/interface/struct/record/enum _declaration: `name` field = identifier.
 *   - base_list: a CHILD (not a field) of the type decl; its namedChildren are the base
 *     types ({qualified_name, identifier, generic_name, primary_constructor_base_type}).
 *   - object_creation_expression: `type` field = identifier (bare) | qualified_name | …
 */

const TYPE_DECLARATION_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'struct_declaration',
  'record_declaration',
  'record_struct_declaration',
  'enum_declaration',
]);

/**
 * The file-scoped namespace FQN (`namespace Foo.Bar;`), or '' if the file has none.
 *
 * D6 GOTCHA: a `file_scoped_namespace_declaration` does NOT nest the type declarations
 * as its children — the types are SIBLINGS in the `compilation_unit`. (C# allows at most
 * one file-scoped namespace, and it cannot mix with block namespaces at top level.) So
 * the ancestor walk in `blockNamespace()` cannot see it; it must be read off the
 * compilation unit once and prefixed onto every type's namespace.
 */
function fileScopedNamespace(root: Node): string {
  let ns = '';
  walk(root, (node) => {
    if (node.type === 'file_scoped_namespace_declaration') {
      const nameField = node.childForFieldName('name');
      if (nameField !== null && nameField.text !== '') ns = nameField.text;
      return false; // at most one; do not descend
    }
    return undefined;
  });
  return ns;
}

/** The dotted BLOCK-namespace prefix for a node, read from its ancestor chain. Nested
 *  `namespace A { namespace B { } }` concatenates outermost-first → "A.B". Empty when no
 *  block namespace ancestor (the type may still sit in a file-scoped namespace). */
function blockNamespace(node: Node): string {
  const parts: string[] = [];
  let cur: Node | null = node.parent;
  while (cur !== null) {
    if (cur.type === 'namespace_declaration') {
      const nameField = cur.childForFieldName('name');
      if (nameField !== null && nameField.text !== '') parts.unshift(nameField.text);
    }
    cur = cur.parent;
  }
  return parts.join('.');
}

/** The enclosing-TYPE chain of `node`, read from its ancestor chain, outermost-first.
 *  A nested `class Inner` inside `class Outer` yields `["Outer"]`; deeper nesting yields
 *  `["Outer", "Mid"]`. Empty when the type is not nested in another type. Joined with the
 *  type's own simple name by `+` (the .NET reflection FQN separator) — distinct from the
 *  namespace `.` so a nested key lives in a disjoint string space from any dot-only use
 *  candidate (separator isolation). */
function enclosingTypeChain(node: Node): string[] {
  const parts: string[] = [];
  let cur: Node | null = node.parent;
  while (cur !== null) {
    if (TYPE_DECLARATION_TYPES.has(cur.type)) {
      const nameField = cur.childForFieldName('name');
      if (nameField !== null && nameField.text !== '') parts.unshift(nameField.text);
    }
    cur = cur.parent;
  }
  return parts;
}

/** True when a `*_declaration` node carries the C#11 `file` modifier — a child `modifier`
 *  node whose text is the keyword `file`. A `file`-modified type is visible ONLY inside its
 *  declaring source file (it cannot be referenced cross-file, and two different files may each
 *  declare an unrelated same-named `file` type). */
function hasFileModifier(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c !== null && c.type === 'modifier' && c.text === 'file') return true;
  }
  return false;
}

/** True when `node` is a `file`-local type OR is nested (at any depth) inside a `file`-local
 *  type. A type unreachable across files because an enclosing type is `file`-local must also be
 *  withheld from the cross-file index — a nested type of a `file` type cannot escape the file. */
function isFileLocalType(node: Node): boolean {
  let cur: Node | null = node;
  while (cur !== null) {
    if (TYPE_DECLARATION_TYPES.has(cur.type) && hasFileModifier(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * The symbol key of an EXTENSION METHOD named `name` declared in namespace `ns`: `<ns>.<name>()`
 * (`<name>()` in the global namespace). C# binds an extension-method call `x.Name()` by the
 * method NAME among the extension methods of the namespaces in scope (the enclosing namespaces
 * and the imported ones) — the declaring static class is not part of the lookup, so it is not
 * part of the key. The trailing `()` puts these keys in a string space no type key or type-use
 * candidate can ever produce (a type name never contains parentheses), so an extension key can
 * never be mistaken for, or silence, a type.
 */
function extensionKey(ns: string, name: string): string {
  return ns === '' ? `${name}()` : `${ns}.${name}()`;
}

/** True when `node` has a `static` modifier child. */
function hasStaticModifier(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c !== null && c.type === 'modifier' && c.text === 'static') return true;
  }
  return false;
}

/** True when a parameter carries the `this` modifier (the receiver of a classic extension method). */
function isThisParameter(param: Node): boolean {
  for (let i = 0; i < param.childCount; i++) {
    const c = param.child(i);
    if (c !== null && c.type === 'modifier' && c.text === 'this') return true;
  }
  return false;
}

/** The enclosing type declaration of `node` (its nearest TYPE ancestor), or null. */
function enclosingTypeDecl(node: Node): Node | null {
  let cur: Node | null = node.parent;
  while (cur !== null) {
    if (TYPE_DECLARATION_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * The name of the extension method `node` declares, or undefined when it declares none. Three
 * shapes are recognised, each inside a TOP-LEVEL (non-nested) `static` class that is not
 * `file`-local — the only place C# allows extension members:
 *  - the classic form: a `method_declaration` whose first parameter carries `this`;
 *  - a C# 14 extension-block member on a grammar that knows the block: a `method_declaration`
 *    whose ancestor is an `extension_declaration`;
 *  - the same member on the shipped pre-C# 14 grammar, which misreads the block as a constructor
 *    named `extension` and its methods as local functions in that constructor's body.
 * Indexing the last shape only ever ADDS a key; nothing else depends on the misreading.
 */
function extensionMethodName(node: Node): string | undefined {
  if (node.type !== 'method_declaration' && node.type !== 'local_function_statement') return undefined;
  const owner = enclosingTypeDecl(node);
  if (owner?.type !== 'class_declaration' || !hasStaticModifier(owner) || isFileLocalType(owner) || enclosingTypeDecl(owner) !== null) {
    return undefined;
  }
  const name = node.childForFieldName('name')!.text; // a method / local function always has a name
  if (node.type === 'local_function_statement') {
    // Only a local function DIRECTLY in the body of the misread `extension(…)` constructor of the
    // static class itself; a local function anywhere else is a helper, never an extension member.
    const ctor = node.parent!.parent!;
    const misreadBlock =
      ctor.type === 'constructor_declaration' && ctor.childForFieldName('name')!.text === 'extension' && ctor.parent!.parent!.id === owner.id;
    return misreadBlock ? name : undefined;
  }
  // The C# 14 block form on a grammar that knows it: a method inside an extension declaration.
  for (let cur = node.parent!; cur.id !== owner.id; cur = cur.parent!) {
    if (cur.type === 'extension_declaration') return name;
  }
  // The classic form: the first parameter carries `this`.
  const first = node.childForFieldName('parameters')!.namedChild(0);
  return first?.type === 'parameter' && isThisParameter(first) ? name : undefined;
}

/**
 * The FULLY-QUALIFIED symbol keys this file DEFINES. The namespace for each type is the
 * file-scoped namespace (if any) joined with the block-namespace ancestor chain. The TYPE
 * part is the enclosing-type chain joined by the reflection separator `+`, ending in the
 * type's own simple name: a top-level type is `<namespace>.<TypeName>`; a nested type is
 * `<namespace>.<Outer>+<Inner>` (deeper: `<Outer>+<Mid>+<Inner>`); at true file scope the
 * namespace prefix is omitted (`<TypeName>` or `<Outer>+<Inner>`). A nested type emits ONLY
 * its `+` key — never also the bare simple name — so it cannot collide with, and silence, a
 * legitimate top-level type of the same simple name in another node. These keys feed the
 * shared SymbolTable; a use's `Outer.Inner` reference resolves to them via the resolver's
 * guarded `+`-boundary split.
 *
 * A C#11 `file`-local type (and anything nested inside one) is NEVER published to the shared
 * cross-file index: it is visible only in its own file, so a cross-file reference to a
 * same-named type must never bind to it, and two files declaring same-named `file` types must
 * not mis-merge into one cross-file definition (zero-FP guard F5).
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  const fileNs = fileScopedNamespace(file.tree.rootNode);

  walk(file.tree.rootNode, (node) => {
    const extName = extensionMethodName(node);
    if (extName !== undefined) {
      const ns = [fileNs, blockNamespace(node)].filter((p) => p !== '').join('.');
      out.push({ symbolKey: extensionKey(ns, extName), line: node.startPosition.row + 1 });
      return undefined;
    }
    if (!TYPE_DECLARATION_TYPES.has(node.type)) return undefined;
    const nameField = node.childForFieldName('name');
    if (nameField === null || nameField.text === '') return undefined;
    // C#11 `file`-local type → not a cross-file resolution target. Skip publishing its FQN.
    if (isFileLocalType(node)) return undefined;
    const blockNs = blockNamespace(node);
    const ns = [fileNs, blockNs].filter((p) => p !== '').join('.');
    const typeKey = [...enclosingTypeChain(node), nameField.text].join('+');
    const symbolKey = ns === '' ? typeKey : `${ns}.${typeKey}`;
    out.push({ symbolKey, line: node.startPosition.row + 1 });
    return undefined;
  });

  return out;
}

interface UsingScope {
  /** Namespace prefixes from plain `using Foo.Bar;` directives (file-local). */
  prefixes: string[];
  /** Namespace prefixes from `global using Foo.Bar;` declared in THIS file. Tracked apart
   *  from `prefixes` only so the cross-file pre-pass (pass.ts) can aggregate them project-
   *  wide; for THIS file's resolution they bind identically to a file-local plain using. */
  globalPrefixes: string[];
  /** alias local-name → aliased FQN from `using Alias = Foo.Bar;` (incl. `global using
   *  Alias = ...`, an alias is always file-local in effect for resolution). */
  aliases: Map<string, string>;
  /** alias local-name → aliased FQN from `global using Alias = Foo.Bar;` declared in THIS file
   *  only. Tracked apart from `aliases` so the cross-file pre-pass (pass.ts) can aggregate them
   *  project-wide (A12). The RHS FQN is the resolved alias target (C# resolves an alias RHS
   *  fully-qualified vs the global namespace, so the captured dotted text IS the target). */
  globalAliases: Map<string, string>;
  /** Fully-resolved TARGET type FQN (with the directive's line) of each `using static N.C;` /
   *  `global using static N.C;` directive in this file (A8/A11). The directive names a concrete
   *  type whose static members are imported — that target is a real type dependency of this file,
   *  resolved like an alias RHS (already fully-qualified). NOT a namespace prefix (a sibling
   *  `N.Baz` is never imported). */
  staticTargets: Array<{ fqn: string; line: number }>;
}

const NAMESPACE_NODE_TYPES = new Set([
  'qualified_name',
  'identifier',
  'generic_name',
  'alias_qualified_name',
]);

/** The imported namespace/type dotted text of a `using_directive`. When `skipName` is the
 *  directive's `name`-field node (the alias identifier in `using Alias = Foo.Bar;`), it is
 *  skipped so the ALIASED target is returned, not the alias name. The text is normalized so a
 *  `global::`-rooted import (`global::Foo.Bar`) records the clean dotted FQN. */
function directiveNamespaceText(directive: Node, skipName: Node | null = null): string | undefined {
  for (let i = 0; i < directive.namedChildCount; i++) {
    const c = directive.namedChild(i);
    if (c === null) continue;
    if (skipName !== null && c.id === skipName.id) continue;
    if (NAMESPACE_NODE_TYPES.has(c.type)) return stripGlobalQualifier(c.text);
  }
  return undefined;
}

/** True when the directive has an anonymous token child of the given keyword type. */
function hasTokenChild(directive: Node, token: string): boolean {
  for (let i = 0; i < directive.childCount; i++) {
    const c = directive.child(i);
    if (c !== null && !c.isNamed && c.type === token) return true;
  }
  return false;
}

/** Strip a leading `global::` alias qualifier (R12): `global::A.B.Base` → `A.B.Base`, resolved
 *  as a fully-qualified name from the root. A NON-`global` extern/using alias qualifier
 *  (`Lib::A.B`) is left intact — its `::` text never matches a dot-only declaration key, so it
 *  stays silence-by-luck (R13), never mis-binding a same-tail type. */
function stripGlobalQualifier(text: string): string {
  return text.startsWith('global::') ? text.slice('global::'.length) : text;
}

/** `A.B<C<D>>.E` → `A.B.E`: drop every (nested) type-argument list from a written type name. */
function stripTypeArguments(text: string): string {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/** Build the file's using scope: file-local plain prefixes, project-wide `global using`
 *  prefixes, the alias map (file-local + project-wide global aliases tracked apart), and the
 *  fully-resolved target type of each `using static` / `global using static` directive. */
function buildUsingScope(file: ParsedFile): UsingScope {
  const prefixes: string[] = [];
  const globalPrefixes: string[] = [];
  const aliases = new Map<string, string>();
  const globalAliases = new Map<string, string>();
  const staticTargets: Array<{ fqn: string; line: number }> = [];

  walk(file.tree.rootNode, (node) => {
    if (node.type !== 'using_directive') return undefined;

    // `using static N.C;` imports a type's static MEMBERS, not a namespace → NO namespace
    // prefix. But the TARGET type `N.C` IS a real type dependency of this file (A8/A11),
    // resolved like an alias RHS (already fully-qualified). Record it as a static target.
    if (hasTokenChild(node, 'static')) {
      const target = directiveNamespaceText(node);
      if (target !== undefined && target !== '') {
        staticTargets.push({ fqn: target, line: node.startPosition.row + 1 });
      }
      return undefined;
    }

    // `using Alias = Foo.Bar;` — the `name` field is the alias; record alias→FQN. Do
    // NOT treat the alias as a namespace prefix. A `global using Alias = ...` is ALSO
    // recorded apart so pass.ts can apply the alias project-wide (A12).
    const aliasName = node.childForFieldName('name');
    if (aliasName !== null) {
      const written = directiveNamespaceText(node, aliasName);
      // A closed-generic alias target (`using R = Shop.Core.Repository<Order>;`) binds by its
      // plain container name — declaration keys carry no arity (the embedded type arguments are
      // harvested separately as their own references).
      const fqn = written === undefined ? undefined : stripTypeArguments(written);
      if (fqn !== undefined && fqn !== '') {
        aliases.set(aliasName.text, fqn);
        if (hasTokenChild(node, 'global')) globalAliases.set(aliasName.text, fqn);
      }
      return undefined;
    }

    // Plain `using Foo.Bar;` or `global using Foo.Bar;` — a namespace import. Either binds
    // for THIS file; a `global using` is ALSO recorded apart so pass.ts can apply it
    // project-wide to every C# file.
    const ns = directiveNamespaceText(node);
    if (ns !== undefined && ns !== '') {
      if (hasTokenChild(node, 'global')) globalPrefixes.push(ns);
      else prefixes.push(ns);
    }
    return undefined;
  });

  return { prefixes, globalPrefixes, aliases, globalAliases, staticTargets };
}

/**
 * Collect the `global using Foo.Bar;` namespace prefixes a C# file declares (project-wide
 * imports). Used by the cross-file pre-pass in pass.ts to aggregate the global usings of every
 * file of a project before per-file resolution, so a `global using` in ANY file of the project
 * qualifies bare names in EVERY file of that project (R5, M6). Aliases and `using static` are file-local (per the C# spec, a `global using static`
 * / `global using alias` is still project-wide, but its members/alias are not a namespace
 * prefix), so only the namespace-import global prefixes are aggregated here.
 */
export function collectGlobalUsings(file: ParsedFile): string[] {
  return buildUsingScope(file).globalPrefixes;
}

/**
 * Collect the `global using Alias = Foo.Bar;` aliases a C# file declares (project-wide
 * aliases, A12). Used by the cross-file pre-pass in pass.ts to aggregate every file's global
 * aliases before per-file resolution, so a `global using` alias declared in ANY file is usable
 * in EVERY file. The alias RHS is resolved fully-qualified vs the global namespace (C# resolves
 * an alias RHS ignoring other usings and the enclosing namespace), so the captured dotted FQN
 * IS the resolved target in the declaring file's context — aggregating `[alias, fqn]` pairs is
 * sufficient. Returned as entries so pass.ts can union them into a project-wide alias map.
 */
export function collectGlobalUsingAliases(file: ParsedFile): Array<[string, string]> {
  return [...buildUsingScope(file).globalAliases.entries()];
}

/** The enclosing-namespace prefixes for a reference, INNERMOST first. For a reference in
 *  `namespace App.Services.Sub` (file-scoped `App` + block chain `Services.Sub`) the chain
 *  is `["App.Services.Sub", "App.Services", "App"]` — C# looks an unqualified/partial name
 *  up against each progressively-shorter enclosing namespace, innermost outward, before the
 *  imports. An empty result means the reference sits at true file scope. */
function enclosingNamespaceChain(fileNs: string, node: Node): string[] {
  const segments = [fileNs, blockNamespace(node)]
    .filter((p) => p !== '')
    .join('.')
    .split('.')
    .filter((s) => s !== '');
  const chain: string[] = [];
  for (let i = segments.length; i >= 1; i--) chain.push(segments.slice(0, i).join('.'));
  return chain;
}

/** Options for `uses()` — the cross-file global-using scope injected by the pass-level
 *  pre-pass (R5). These prefixes bind below the file's own usings (lowest using tier). */
export interface CsharpUsesOptions {
  /** Namespace prefixes from `global using` directives aggregated across EVERY C# file in the
   *  project (a project-wide import set). Applied to every file's simple-name resolution. */
  projectGlobalUsings?: string[];
  /** Alias name → fully-qualified target from `global using Alias = ...;` directives aggregated
   *  across EVERY C# file of the project (A12), and from `<Using Include Alias>` items. Merged
   *  into this file's alias map BELOW any file-local alias of the same name (a file-local alias
   *  takes precedence). A name listed with 2+ distinct targets is ambiguous → silenced (M7). */
  projectGlobalUsingAliases?: Array<[string, string]>;
}

/**
 * One alias-UNRESOLVED per-reference descriptor emitted by `extractCsharpRefs` (the pure half).
 *
 * WHY UNRESOLVED (design §14 Correction A): C# `uses()` consults the MERGED alias map
 * (file-local ∪ project-global) DURING the walk — at `pushRef`'s leftmost-segment alias lookup
 * and the `S::Tail` alias rewrite — to decide whether a reference is emitted at all and with
 * what key. A project-global alias added in ANOTHER file changes what this file emits, so the
 * cached fact must be PRE-assembly: the alias merge + candidate building is deferred entirely to
 * `assembleCsharpCandidates`. The descriptor carries no live AST node (the tree is destroyed
 * after `tree.delete()`) — every node-derived input is precomputed here, notably the
 * enclosing-namespace chain (`enclosingNs`).
 */
export type CsharpRefDescriptor =
  /** A plain `pushRef(ref, node, line, rooted)` reference: a dotted partial name or bare
   *  identifier. `rooted` (a `global::`-stripped or `using static` target form) resolves
   *  verbatim-only; otherwise alias/enclosing-ns/using-prefix expansion applies on assembly. */
  | { kind: 'plain'; ref: string; line: number; rooted: boolean; enclosingNs: string[] }
  /** An `S::Tail` alias-qualified reference (`alias_qualified_name`, non-`global` alias). Emitted
   *  only on assembly IF the merged alias map binds `aliasName` → its rewritten `${fqn}.${tail}`
   *  resolves verbatim-from-root; otherwise dropped (extern/unknown alias → R13 silence). */
  | { kind: 'alias'; aliasName: string; tail: string; line: number; enclosingNs: string[] }
  /** A `using static N.C;` / `global using static N.C;` TARGET edge — the concrete type whose
   *  static members are imported. Resolves verbatim-from-root as its sole candidate (A8/A11). */
  | { kind: 'static'; fqn: string; line: number }
  /** An attribute usage `[Foo]` / `[FooAttribute]` — TWO readings (`written` + the optional
   *  `Attribute`-suffixed form) merged into ONE ordered group on assembly (E9). */
  | { kind: 'attr'; written: string; suffixed?: string; line: number; enclosingNs: string[] }
  /** The receiver of a member access through a TYPE name (`Guard.NotNull(x)`, `OrderStatus.Paid`,
   *  `Shop.Core.Guard.NotNull(x)`): `chain` is the dotted receiver, leftmost first, without the
   *  accessed member. On assembly each prefix (`Shop`, `Shop.Core`, `Shop.Core.Guard`) is one
   *  reading, concatenated in that order into ONE group — C# binds the leftmost simple name first
   *  and only reads further segments when it names a namespace. Emitted only when the leftmost
   *  identifier is not a name this file declares (a local, parameter, field, property, method…),
   *  so a value that shadows a type name never manufactures a type edge. */
  | { kind: 'receiver'; chain: string[]; line: number; enclosingNs: string[] }
  /** An extension-method call `value.Name(…)` on an instance-like receiver: resolved against the
   *  extension-method keys (`<ns>.Name()`) of the enclosing namespaces, then the imported
   *  namespaces as one set, then the global namespace. */
  | { kind: 'ext'; name: string; line: number; enclosingNs: string[] };

/**
 * The pure, alias-UNRESOLVED extract of one C# file — the cacheable fact (design §14 Correction
 * A). It is a function of the file's bytes/AST ALONE: NO `options`, NO alias merge, NO
 * project-global resolution. `assembleCsharpCandidates` turns it (plus the live project-global
 * scope) into the final `DetectedDep[]`.
 */
export interface CsharpExtract {
  /** The file-scoped namespace FQN (`namespace Foo.Bar;`), or '' if none. */
  fileNs: string;
  /** The full FILE-LOCAL using scope from `buildUsingScope` (prefixes, globalPrefixes, aliases,
   *  globalAliases, staticTargets) — alias merge with the project-global set is deferred. */
  scope: UsingScope;
  /** The per-reference descriptors in original walk EMIT ORDER (static targets first, then the
   *  alias-RHS embedded-types walk, then the main walk). Replaying them in order reproduces the
   *  exact `DetectedDep[]` order — load-bearing for the downstream violation-reason order. */
  refs: CsharpRefDescriptor[];
}

/** Receiver node types that name a TYPE, never an instance (`base.X()`, `string.Join()`,
 *  `List<int>.X`, `A.B.X()` as a qualified name) — an extension method is never called on them. */
const NON_INSTANCE_RECEIVERS = new Set(['base', 'predefined_type', 'generic_name', 'qualified_name', 'alias_qualified_name']);

/** `System.Object` member names. Every receiver has these as instance methods, and an instance
 *  method always wins over a same-named extension method, so a call to one of them is never an
 *  extension-method call even when an in-repo extension of that name is in scope. */
const OBJECT_MEMBER_NAMES = new Set(['ToString', 'Equals', 'GetHashCode', 'GetType', 'MemberwiseClone', 'ReferenceEquals']);

/** Declaring node types whose `name` field introduces a value or member name. */
const NAME_DECLARING_TYPES = new Set([
  'variable_declarator',
  'parameter',
  'method_declaration',
  'local_function_statement',
  'property_declaration',
  'event_declaration',
  'enum_member_declaration',
  'delegate_declaration',
  'type_parameter',
  'declaration_pattern',
  'declaration_expression',
  'catch_declaration',
  'from_clause',
  'let_clause',
  'join_clause',
  'join_into_clause',
  'tuple_pattern',
  'receiver_parameter',
  ...TYPE_DECLARATION_TYPES,
]);

/**
 * Every name this file DECLARES that is not a namespace: locals, parameters (method, lambda,
 * primary-constructor), fields, properties, events, methods and local functions, enum members,
 * type parameters, pattern/`out var`/deconstruction designations, `foreach`/`catch`/query range
 * variables, and the file's own type names — collected file-wide, not per scope.
 *
 * WHY FILE-WIDE (the M16 shadow guard): a member access `X.Member` reads as a static access
 * through the TYPE `X` only when no nearer value named `X` is in scope. Deciding real C# scoping
 * would need the enclosing method, lambda and type bodies; over-approximating to the whole file
 * can only drop a reading (a missed edge), never add one, which is the direction the zero-false-
 * positive contract allows. Also returns the ordinary (non-extension) method names the file
 * declares: a call `x.Name()` whose name the file itself declares as a method is most likely that
 * instance method, which C# prefers over any extension method.
 */
function collectDeclaredNames(root: Node): { declaredNames: Set<string>; methodNames: Set<string> } {
  const declaredNames = new Set<string>();
  const methodNames = new Set<string>();
  walk(root, (node) => {
    if (node.type === 'implicit_parameter' || node.type === 'single_variable_designation') {
      declaredNames.add(node.text);
    } else if (node.type === 'foreach_statement') {
      const left = node.childForFieldName('left')!;
      if (left.type === 'identifier') declaredNames.add(left.text); // `foreach (var (a, b) in …)` is a pattern
    } else if (NAME_DECLARING_TYPES.has(node.type)) {
      // An ordinary (non-extension) method or local function also names a callable member.
      const ordinaryMethod =
        (node.type === 'method_declaration' || node.type === 'local_function_statement') && extensionMethodName(node) === undefined;
      for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) !== 'name' || node.child(i)!.type !== 'identifier') continue;
        declaredNames.add(node.child(i)!.text);
        if (ordinaryMethod) methodNames.add(node.child(i)!.text);
      }
    }
    return undefined;
  });
  return { declaredNames, methodNames };
}

/**
 * Extract one C# file's alias-UNRESOLVED reference descriptors + full file-local using scope.
 *
 * PURE over the file's bytes/AST: takes NO `options` and does NO alias/using/project-global
 * resolution. Because the AST node is destroyed after `tree.delete()`, every descriptor carries
 * its enclosing-namespace chain PRECOMPUTED as `string[]` (never a live node). The emit ORDER —
 * `using static` targets first, then the C#12 alias-RHS embedded-types walk, then the main
 * type-position walk — is preserved exactly; `assembleCsharpCandidates` replays it in order.
 */
export function extractCsharpRefs(file: ParsedFile): CsharpExtract {
  const scope = buildUsingScope(file);
  const fileNs = fileScopedNamespace(file.tree.rootNode);
  const refs: CsharpRefDescriptor[] = [];

  // A node id is recorded here once its TYPE reference has been emitted, so a later, broader
  // walk visit (e.g. the generic outermost-qualified_name pass) never re-emits the same node.
  const emitted = new Set<number>();

  // Every value/member name this file declares (M16 shadow guard) and the names of the ordinary
  // (non-extension) methods it declares (m27 guard). See `collectDeclaredNames`.
  const { declaredNames, methodNames } = collectDeclaredNames(file.tree.rootNode);

  /** True when `node` sits inside a `nameof(…)` operand — a string producer, never a dependency. */
  const insideNameof = (node: Node): boolean => {
    for (let cur = node.parent; cur !== null; cur = cur.parent) {
      if (cur.type === 'invocation_expression' && cur.childForFieldName('function')?.text === 'nameof') return true;
    }
    return false;
  };

  /** True when a call's receiver is a VALUE rather than a type name: its leftmost element is a
   *  name this file declares, `this`, or any non-name expression (a call result, `new`, a literal,
   *  an index…). An undeclared leftmost identifier reads as a type (a static call, handled as a
   *  `receiver`); `base.X()` and a predefined/generic/qualified type receiver are never instances. */
  const instanceLikeReceiver = (receiver: Node): boolean => {
    let cur = receiver;
    while (cur.type === 'member_access_expression') cur = cur.childForFieldName('expression')!;
    if (cur.type === 'identifier') return declaredNames.has(cur.text);
    return !NON_INSTANCE_RECEIVERS.has(cur.type);
  };

  /** The method name of an extension-method-shaped call `value.Name(…)` / `value?.Name(…)`, or
   *  undefined when the call cannot be an in-repo extension-method call worth resolving. */
  const extensionCall = (inv: Node): string | undefined => {
    const fn = inv.childForFieldName('function')!;
    let nameNode: Node;
    let receiver: Node;
    if (fn.type === 'member_access_expression') {
      nameNode = fn.childForFieldName('name')!;
      receiver = fn.childForFieldName('expression')!;
    } else if (fn.type === 'conditional_access_expression') {
      // `value?.Name(…)`; a binding holding an ERROR is a parser recovery, never read as a call.
      const binding = findChild(fn, 'member_binding_expression');
      if (binding === null || findChild(binding, 'ERROR') !== null) return undefined;
      nameNode = binding.childForFieldName('name')!;
      receiver = fn.childForFieldName('condition')!;
    } else {
      return undefined;
    }
    // `value.Name<T>(…)` names the method by the generic's base identifier.
    const name = (nameNode.type === 'generic_name' ? findChild(nameNode, 'identifier')! : nameNode).text;
    if (OBJECT_MEMBER_NAMES.has(name) || methodNames.has(name)) return undefined;
    return instanceLikeReceiver(receiver) ? name : undefined;
  };

  /** Emit a plain reference descriptor (alias-unresolved). `enclosingNs` is precomputed from the
   *  node before the tree is destroyed; the alias/using expansion happens later, on assembly. */
  const pushRef = (ref: string, node: Node, line: number, rooted = false): void => {
    refs.push({
      kind: 'plain',
      ref,
      line,
      rooted,
      enclosingNs: enclosingNamespaceChain(fileNs, node),
    });
  };

  /** Emit an attribute descriptor (the two-reading `[Foo]`/`[FooAttribute]` group). */
  const pushAttribute = (
    written: string,
    suffixed: string | undefined,
    node: Node,
    line: number,
  ): void => {
    refs.push({
      kind: 'attr',
      written,
      suffixed,
      line,
      enclosingNs: enclosingNamespaceChain(fileNs, node),
    });
  };

  /**
   * Emit references for every NAMED type a TYPE node carries, descending the type-constructor
   * shapes (generics, arrays, nullables, tuples) to their leaf named types. A bare `identifier`
   * or a `qualified_name` is one reference; a `generic_name`'s BASE name and each of its type
   * ARGUMENTS are references (an external container like `List`/`Task` resolves to nothing, so
   * it manufactures no edge); an
   * `array_type`/`nullable_type` unwraps to its element type; a `tuple_type` descends each
   * element. `predefined_type` (int, string, void, object…) and `implicit_type` (`var`) carry
   * no named dependency and are skipped.
   */
  const emitTypeNode = (typeNode: Node | null): void => {
    if (typeNode === null) return;
    switch (typeNode.type) {
      case 'identifier': {
        if (emitted.has(typeNode.id)) return;
        emitted.add(typeNode.id);
        pushRef(typeNode.text, typeNode, typeNode.startPosition.row + 1);
        return;
      }
      case 'qualified_name': {
        if (emitted.has(typeNode.id)) return;
        emitted.add(typeNode.id);
        emitQualified(typeNode);
        return;
      }
      case 'alias_qualified_name': {
        // `global::A.B` rooted reference (R12): resolve the right side from the global root.
        const aliasField = typeNode.childForFieldName('alias');
        if (aliasField !== null && aliasField.text === 'global') {
          if (emitted.has(typeNode.id)) return;
          emitted.add(typeNode.id);
          const nameField = typeNode.childForFieldName('name');
          if (nameField !== null) emitTypeNode(nameField);
          return;
        }
        // `S::Tail` where `S` is an in-file `using S = N;` namespace alias (B5): the leftmost
        // `S` is rewritten to its aliased FQN ON ASSEMBLY (the merged alias map decides emit-or-
        // not — an extern/unknown alias is dropped → R13 silence). The descriptor is emitted
        // UNCONDITIONALLY here, alias-unresolved; assembly drops it when the alias is absent.
        // (The original's conditional `emitted.add` here is unobservable — an
        // `alias_qualified_name` node is only ever reached once via `emitTypeNode`.)
        if (aliasField !== null) {
          const nameField = typeNode.childForFieldName('name');
          if (nameField !== null) {
            refs.push({
              kind: 'alias',
              aliasName: aliasField.text,
              tail: stripGlobalQualifier(nameField.text),
              line: typeNode.startPosition.row + 1,
              enclosingNs: enclosingNamespaceChain(fileNs, typeNode),
            });
          }
        }
        return;
      }
      case 'generic_name': {
        // The generic's BASE name is a type reference of its own (`Repository<Order>` depends on
        // `Repository` as much as on `Order`), resolved like a bare identifier. An external
        // container (`List`, `Task`, `Dictionary`) resolves to no in-graph declaration, so it stays
        // silent by the ordinary fail-to-silence rule. The type arguments are descended as before.
        if (emitted.has(typeNode.id)) return;
        emitted.add(typeNode.id);
        pushRef(findChild(typeNode, 'identifier')!.text, typeNode, typeNode.startPosition.row + 1);
        emitTypeArguments(typeNode);
        return;
      }
      case 'array_type':
      case 'nullable_type':
      case 'pointer_type': {
        emitTypeNode(typeNode.childForFieldName('type'));
        return;
      }
      case 'tuple_type': {
        for (let i = 0; i < typeNode.namedChildCount; i++) {
          const el = typeNode.namedChild(i);
          if (el !== null && el.type === 'tuple_element') emitTypeNode(el.childForFieldName('type'));
        }
        return;
      }
      default:
        // predefined_type / implicit_type / function_pointer_type / unrecognized → no named dep.
        return;
    }
  };

  /** Descend the type arguments of one `generic_name` (each argument is its own reference). */
  function emitTypeArguments(generic: Node): void {
    const args = findChild(generic, 'type_argument_list')!; // a generic_name always has its argument list
    for (let i = 0; i < args.namedChildCount; i++) emitTypeNode(args.namedChild(i));
  }

  /**
   * Emit one `qualified_name` reference. A qualified name that carries generic segments
   * (`Shop.Core.Repository<int>`, `Outer<int>.Inner`) is referenced by its PLAIN dotted name — the
   * type-argument lists stripped (`Shop.Core.Repository`, `Outer.Inner`), because declaration keys
   * carry no arity — and every type-argument list inside it is descended as its own references.
   * Without the strip the written text, `<…>` included, could never match a declaration key.
   */
  function emitQualified(q: Node): void {
    const line = q.startPosition.row + 1;
    const rooted = q.text.startsWith('global::');
    if (!q.text.includes('<')) {
      pushRef(stripGlobalQualifier(q.text), q, line, rooted);
      return;
    }
    const segs: string[] = [];
    const generics: Node[] = [];
    let ok = true;
    const collect = (n: Node): void => {
      if (n.type === 'qualified_name') {
        collect(n.childForFieldName('qualifier')!);
        collect(n.childForFieldName('name')!);
      } else if (n.type === 'generic_name') {
        segs.push(findChild(n, 'identifier')!.text);
        generics.push(n);
      } else if (n.type === 'alias_qualified_name') {
        // `global::A.B<T>` resolves from the root (R12); any other alias qualifier (`Lib::A<T>.B`)
        // can never match a dot-only key (R13), so the name is not emitted at all.
        if (n.childForFieldName('alias')!.text === 'global') collect(n.childForFieldName('name')!);
        else ok = false;
      } else {
        segs.push(n.text); // identifier
      }
    };
    collect(q);
    if (ok) pushRef(segs.join('.'), q, line, rooted);
    for (const g of generics) emitTypeArguments(g);
  }

  /** The first child of the given type, or null. */
  function findChild(node: Node, childType: string): Node | null {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null && c.type === childType) return c;
    }
    return null;
  }

  // ── `using static N.C;` / `global using static N.C;` TARGET edge (A8/A11) ────────────────
  // The directive imports the static MEMBERS of the concrete type `N.C` — the target type
  // itself is a real, fully-qualified type dependency of this file (never a namespace prefix:
  // a sibling `N.Baz` is never imported). It resolves FROM THE ROOT as its sole candidate (like
  // an alias RHS): no enclosing-ns / using-prefix expansion. Emitted FIRST (matching the
  // original walk's leading static-target loop) so the descriptor order — and thus the final
  // edge order — is preserved.
  for (const target of scope.staticTargets) {
    refs.push({ kind: 'static', fqn: target.fqn, line: target.line });
  }

  // ── C#12 alias-RHS embedded named types (R7 + A6) ───────────────────────────────────────
  // `using L = System.Collections.Generic.List<MyApp.Models.Customer>;` — the alias NAME `L`
  // resolves to the closed generic on use (the container `List` is external), but the EMBEDDED
  // named type arguments (`MyApp.Models.Customer`) are real dependencies the alias-on-use cannot
  // surface as their own edge. The directive header is skipped by the main walk, so harvest the
  // RHS's embedded named types here.
  //
  // C#12 lets the alias RHS be ANY type — a tuple `(int, Mod.Customer)`, an array `Mod.Order[]`,
  // a pointer `Mod.Header*`, a nullable value `Mod.Money?` — and each NAMED type embedded in the
  // structural RHS is a real reference. So descend the RHS structural WRAPPERS (generic args,
  // tuple elements, array/pointer/nullable element types) for their embedded named types. What is
  // NEVER emitted: a plain top-level bare named RHS (`using X = N.Type;`) — that is the alias
  // TARGET, surfaced via the alias map on USE (emitting it here would double-count the A3 edge),
  // and the tuple element LABELS (they are not types).
  walk(file.tree.rootNode, (node) => {
    if (node.type !== 'using_directive') return undefined;
    if (node.childForFieldName('name') === null) return false; // not an alias directive
    // Find every type_argument_list anywhere in the RHS and emit each argument's named types
    // (covers `List<Customer>`, and a generic nested inside a tuple/array element).
    walk(node, (n) => {
      if (n.type === 'type_argument_list') {
        for (let i = 0; i < n.namedChildCount; i++) emitTypeNode(n.namedChild(i));
        return false; // args handled; do not descend further into this list
      }
      // Tuple / array / pointer / nullable RHS — the element type(s) are embedded NAMED types.
      // Emit a non-generic element directly (a generic element is covered by the
      // type_argument_list walk above; `emitted` dedups, and a `<…>`-bearing element is skipped
      // here so we never emit a full `Container<…>` verbatim key). The top-level alias TARGET is
      // a bare named RHS with no wrapper, so it is never reached here.
      if (n.type === 'tuple_element') {
        const t = n.childForFieldName('type');
        if (t !== null && !t.text.includes('<')) emitTypeNode(t);
        return undefined;
      }
      if (n.type === 'array_type' || n.type === 'pointer_type' || n.type === 'nullable_type') {
        const el = n.childForFieldName('type');
        if (el !== null && !el.text.includes('<')) emitTypeNode(el);
        return undefined;
      }
      return undefined;
    });
    return false;
  });

  walk(file.tree.rootNode, (node) => {
    // Do NOT descend into directive/declaration HEADERS — their dotted names are the
    // imported namespace or the declared namespace name, not a symbol USE.
    if (node.type === 'using_directive' || node.type === 'file_scoped_namespace_declaration') {
      return false;
    }
    if (node.type === 'namespace_declaration') {
      const nameField = node.childForFieldName('name');
      if (nameField !== null) return undefined; // continue into the body for real uses
    }

    // ── Type-bearing positions (descend the type node to its named leaf types) ────────────
    // Field / property / local variable type.
    if (node.type === 'variable_declaration') {
      emitTypeNode(node.childForFieldName('type'));
      return undefined; // keep descending — initializers may carry more references
    }
    // Parameter type.
    if (node.type === 'parameter') {
      emitTypeNode(node.childForFieldName('type'));
      return undefined;
    }
    // Method / property / operator / indexer / delegate return type.
    if (
      node.type === 'method_declaration' ||
      node.type === 'property_declaration' ||
      node.type === 'delegate_declaration' ||
      node.type === 'operator_declaration' ||
      node.type === 'indexer_declaration' ||
      node.type === 'conversion_operator_declaration' ||
      node.type === 'event_declaration'
    ) {
      emitTypeNode(node.childForFieldName('type') ?? node.childForFieldName('returns'));
      return undefined;
    }
    // Local-function RETURN type (E17): `Foo Helper(Bar b) {…}`. The `type` field is the return
    // type; the parameter types are `parameter` nodes handled above. (An explicitly-typed lambda
    // parameter is also a `parameter` node — already covered — so the lambda needs no own case.)
    if (node.type === 'local_function_statement') {
      emitTypeNode(node.childForFieldName('type'));
      return undefined;
    }
    // `catch (FooException e)` exception type (E18). The `catch_declaration` `type` field is the
    // exception type; the `name` field (the bound variable) is NOT a type reference.
    if (node.type === 'catch_declaration') {
      emitTypeNode(node.childForFieldName('type'));
      return undefined;
    }
    // typeof(X) / sizeof(X) / default(X).
    if (
      node.type === 'typeof_expression' ||
      node.type === 'sizeof_expression' ||
      node.type === 'default_expression'
    ) {
      emitTypeNode(node.childForFieldName('type'));
      return undefined;
    }
    // `x as X` (right field) and cast `(X)x` (type field).
    if (node.type === 'as_expression') {
      emitTypeNode(node.childForFieldName('right'));
      return undefined;
    }
    if (node.type === 'cast_expression') {
      emitTypeNode(node.childForFieldName('type'));
      return undefined;
    }
    // `is X` patterns: `o is X x` (declaration_pattern) / `o is X` (recursive_pattern) carry a
    // type; the bare-constant form `o is Z` is a constant_pattern over an identifier expression.
    if (node.type === 'declaration_pattern' || node.type === 'recursive_pattern') {
      emitTypeNode(node.childForFieldName('type'));
      return undefined;
    }
    if (node.type === 'constant_pattern') {
      // `o is Z` — Z is an expression that, in a pattern position, names a type (or a constant).
      // Emit it as a candidate (a type reference if Z is a type; silence otherwise).
      const expr = node.namedChild(0);
      if (expr !== null && (expr.type === 'identifier' || expr.type === 'qualified_name')) emitTypeNode(expr);
      return undefined;
    }
    // Generic constraint `where T : Constraint`.
    if (node.type === 'type_parameter_constraint') {
      emitTypeNode(node.childForFieldName('type'));
      return undefined;
    }
    // Attribute usage `[Foo]` / `[FooAttribute]` / generic `[Foo<Bar>]` (C#11, E9).
    if (node.type === 'attribute') {
      const nameField = node.childForFieldName('name');
      if (nameField !== null && (nameField.type === 'identifier' || nameField.type === 'qualified_name')) {
        if (!emitted.has(nameField.id)) {
          emitted.add(nameField.id);
          const written = stripGlobalQualifier(nameField.text);
          // The C# attribute-naming convention: `[Foo]` may name `Foo` OR `FooAttribute`. Emit
          // both readings as ONE group (the verbatim and the `Attribute`-suffixed form), so the
          // dependency resolves whichever the declaring type is named.
          const last = written.split('.').pop() ?? written;
          const suffixed =
            last.endsWith('Attribute') ? undefined : `${written}Attribute`;
          pushAttribute(written, suffixed, nameField, nameField.startPosition.row + 1);
        }
      } else if (nameField !== null && nameField.type === 'generic_name') {
        // C#11 generic attribute `[Foo<Bar>]`: the attribute NAME is the `generic_name`'s base
        // identifier (`Foo`, with the `Foo`/`FooAttribute` convention), and each type ARGUMENT
        // (`Bar`) is its own real type reference. The base container name resolves the attribute
        // class; the type arguments are descended separately.
        if (!emitted.has(nameField.id)) {
          emitted.add(nameField.id);
          const baseName = nameField.childForFieldName('name');
          const baseId = baseName ?? findChild(nameField, 'identifier');
          if (baseId !== null) {
            const written = stripGlobalQualifier(baseId.text);
            const last = written.split('.').pop() ?? written;
            const suffixed = last.endsWith('Attribute') ? undefined : `${written}Attribute`;
            pushAttribute(written, suffixed, baseId, baseId.startPosition.row + 1);
          }
          const args =
            nameField.childForFieldName('type_arguments') ?? findChild(nameField, 'type_argument_list');
          if (args !== null) {
            for (let i = 0; i < args.namedChildCount; i++) emitTypeNode(args.namedChild(i));
          }
        }
      }
      return undefined;
    }

    // ── Pre-existing reference forms ──────────────────────────────────────────────────────
    // Qualified references anywhere (outermost qualified_name): static-call receivers,
    // remaining type positions not covered above, etc. Skipped when already emitted by a
    // type-position handler, or when it is a namespace-declaration name, or a nested qualifier.
    if (node.type === 'qualified_name') {
      if (emitted.has(node.id)) return undefined;
      if (node.parent !== null && node.parent.type === 'namespace_declaration') {
        const nm = node.parent.childForFieldName('name');
        if (nm !== null && nm.id === node.id) return undefined;
      }
      if (node.parent !== null && node.parent.type === 'qualified_name') return undefined;
      // A `qualified_name` that is itself the `qualifier` of an `alias_qualified_name` is part
      // of a `global::`-rooted name handled at the alias node — skip the bare qualifier.
      if (node.parent !== null && node.parent.type === 'alias_qualified_name') return undefined;
      emitted.add(node.id);
      emitQualified(node);
      return undefined;
    }

    // C# 14 extension block on a grammar that knows it (M2): `extension(Order order) { … }` —
    // the receiver's type is a type reference. The shipped pre-C# 14 grammar misreads the block
    // as a constructor named `extension`, whose receiver is then an ordinary `parameter` (handled
    // above); this case keeps the edge when the grammar is upgraded to the real node shape.
    if (node.type === 'receiver_parameter') {
      emitTypeNode(node.childForFieldName('type'));
      return undefined;
    }

    // C# 14 null-conditional assignment `h?.Last = new Order();` on the shipped pre-C# 14 grammar:
    // the parser recovers as `h?.<ERROR Last = new> Order(…)`, a member binding whose name is
    // really the created type. Read that exact recovery shape (an ERROR child ending in the `new`
    // keyword, right before the binding's name) as the `new T()` it is. A grammar that knows the
    // form yields a plain object creation instead.
    if (node.type === 'member_binding_expression') {
      const recoveredNew = node.namedChildren.some(
        (c) => c !== null && c.type === 'ERROR' && c.childCount > 0 && c.child(c.childCount - 1)?.type === 'new',
      );
      const nm = node.childForFieldName('name');
      if (recoveredNew && nm !== null) emitTypeNode(nm);
      return undefined;
    }

    // Member access through a TYPE name (M16): `Guard.NotNull(o)`, `OrderStatus.Paid`,
    // `Shop.Core.Guard.NotNull(o)`. Handled once, at the innermost access (the one whose receiver
    // is the leftmost identifier). A generic receiver `Result<int>.Ok()` is a type position.
    if (node.type === 'member_access_expression') {
      const expr = node.childForFieldName('expression');
      if (expr !== null && expr.type === 'generic_name') {
        emitTypeNode(expr);
      } else if (expr !== null && expr.type === 'identifier' && !declaredNames.has(expr.text) && !insideNameof(node)) {
        const chain = [expr.text];
        let cur = node;
        // Walk outward while this access is itself the receiver of a further access (a member
        // access only ever nests through its `expression`): every name but the outermost accessed
        // member is a receiver segment. A generic segment (`A.B<int>.C`) ends the dotted chain.
        while (cur.parent!.type === 'member_access_expression') {
          const nm = cur.childForFieldName('name')!;
          if (nm.type !== 'identifier') break;
          chain.push(nm.text);
          cur = cur.parent!;
        }
        refs.push({
          kind: 'receiver',
          chain,
          line: expr.startPosition.row + 1,
          enclosingNs: enclosingNamespaceChain(fileNs, node),
        });
      }
      return undefined;
    }

    // Extension-method call on an instance-like receiver (m27): `builder.Services.AddInfrastructure()`.
    if (node.type === 'invocation_expression') {
      const call = extensionCall(node);
      if (call !== undefined && !insideNameof(node)) {
        refs.push({
          kind: 'ext',
          name: call,
          line: node.startPosition.row + 1,
          enclosingNs: enclosingNamespaceChain(fileNs, node),
        });
      }
      return undefined;
    }

    // Bare type identifiers in base_list entries.
    if (node.type === 'base_list') {
      for (let i = 0; i < node.namedChildCount; i++) emitTypeNode(node.namedChild(i));
      return undefined;
    }

    // Bare / generic / qualified type in `new T()`.
    if (node.type === 'object_creation_expression') {
      emitTypeNode(node.childForFieldName('type'));
      return undefined;
    }

    return undefined;
  });

  return { fileNs, scope, refs };
}

/**
 * Assemble the final `DetectedDep[]` from a pure C# extract plus the LIVE project-global scope.
 *
 * This is the live half (design §14 Correction A): it merges the file-local alias map with
 * `options.projectGlobalUsingAliases` (file-local wins, identical to the original `uses`), builds
 * the `usingPrefixes` union (file prefixes ∪ file global-prefixes ∪ `options.projectGlobalUsings`),
 * then replays the extract's descriptors IN ORDER through the `pushRef` / `S::Tail` rewrite /
 * `pushAttribute` candidate-assembly logic — preserving the original emit order (the per-reference
 * group order is load-bearing; it drives the violation-reason order downstream).
 */
export function assembleCsharpCandidates(
  extract: CsharpExtract,
  options: CsharpUsesOptions = {},
): DetectedDep[] {
  const out: DetectedDep[] = [];
  const { scope, refs } = extract;

  // Project-wide `global using` aliases (A12): a `global using Alias = N.Type;` declared in ANY
  // file is usable in EVERY file. Merge the aggregated set BELOW this file's own aliases — a
  // file-local alias of the same name takes precedence (the local directive wins for this file).
  // Copy first so the cached extract's `scope.aliases` is never mutated (it may be reused across
  // option variants / runs).
  //
  // M7: when the project-wide set maps one alias name to 2+ DISTINCT targets (two files of what
  // the pass could only treat as one project each declare `global using Money = …;` with a
  // different right-hand side), no single target is the binding — picking one would be an
  // order-dependent wrong edge. Such a name (unless this file declares its own alias of that name)
  // is AMBIGUOUS: every reference led by it stays silent.
  const aliases = new Map(scope.aliases);
  const projectAliasTargets = new Map<string, Set<string>>();
  for (const [name, fqn] of options.projectGlobalUsingAliases ?? []) {
    let targets = projectAliasTargets.get(name);
    if (!targets) {
      targets = new Set();
      projectAliasTargets.set(name, targets);
    }
    targets.add(fqn);
  }
  const ambiguousAliases = new Set<string>();
  for (const [name, targets] of projectAliasTargets) {
    if (aliases.has(name)) continue;
    if (targets.size === 1) aliases.set(name, [...targets][0]);
    else ambiguousAliases.add(name);
  }

  // The using-import binding level (R2/R9: an UNORDERED set at one scope). File-local plain
  // usings + this file's own `global using` + the project-wide aggregated global usings, all
  // at one tier. Sorted by code point so the candidate display order is deterministic and never
  // load-bearing; the CS0104 set rule (≥2 distinct files → silence) is order-independent.
  const usingPrefixes = [
    ...new Set([
      ...scope.prefixes,
      ...scope.globalPrefixes,
      ...(options.projectGlobalUsings ?? []),
    ]),
  ].sort();

  /** Drop undefined/empty/duplicate keys preserving first-seen order. */
  const dedupKeys = (keys: Array<string | undefined>): string[] => {
    const seen = new Set<string>();
    const out2: string[] = [];
    for (const k of keys) {
      if (k === undefined || k === '') continue;
      if (seen.has(k)) continue;
      seen.add(k);
      out2.push(k);
    }
    return out2;
  };

  /**
   * Build and push ONE ordered candidate group for a reference whose written text is `ref` (a
   * dotted partial name or a bare identifier) with its precomputed `enclosingNs` chain. Candidate
   * order = C# name-binding order:
   *   [alias-expansion?] ++ [enclosing-ns chain innermost→outermost]
   *                       ++ [using-prefix block, sorted] ++ [verbatim / bare top-level]
   * with resolution refinements attached as hint metadata (invisible to the group's display
   * shape, which reads only `symbolKey`):
   *   - the alias candidate carries a CO-DEFINITION set (R8): the alias target plus the same
   *     simple name's enclosing-ns + verbatim readings — if the alias AND a same-named member
   *     both resolve (2+ distinct files), the simple name is ambiguous → silence.
   *   - the using-prefix candidates form ONE CS0104 set (R9): classification resolves the union
   *     of all using-prefix expansions; 2+ distinct files → ambiguous → silence.
   *   - a using-prefix candidate on a MULTI-segment ref is `nestedOnly` (R4): `using A;` + `B.T`
   *     may bind `A.B+T` (B a type, T nested) but NEVER the dotted `A.B.T` (B a sub-namespace).
   */
  const pushRef = (ref: string, enclosingNs: string[], line: number, rooted: boolean): void => {
    // A `global::`-rooted reference (R12) is resolved as a fully-qualified name FROM THE ROOT —
    // no alias, no enclosing-namespace, no using-prefix expansion; the verbatim is the sole
    // candidate.
    if (rooted) {
      out.push({ candidates: [{ kind: 'symbol', symbolKey: ref }], kind: 'import', line });
      return;
    }

    const lead = ref.split('.')[0];
    if (ambiguousAliases.has(lead)) return; // M7: an alias with 2+ project-wide targets → silence
    const multi = ref.includes('.');
    const aliasTarget = aliases.get(lead);
    const enclosing = enclosingNs.map((ns) => `${ns}.${ref}`);

    // The using-prefix expansions (one CS0104 set). A multi-segment ref under a using prefix is
    // nested-split-only (R4); a single-segment ref binds the verbatim namespace.type.
    const usingMembers: SymbolSetMember[] = usingPrefixes.map((p) => ({
      symbolKey: `${p}.${ref}`,
      nestedOnly: multi,
    }));

    const candidates: TargetHint[] = [];
    const pushed = new Set<string>();
    const add = (hint: TargetHint): void => {
      if (hint.kind === 'symbol') {
        if (pushed.has(hint.symbolKey)) return;
        pushed.add(hint.symbolKey);
      }
      candidates.push(hint);
    };

    if (aliasTarget !== undefined) {
      // The alias rewrites the leftmost segment; the dotted tail follows it.
      const tail = ref.slice(lead.length); // leading '.', or '' for a bare ref
      const aliasKey = `${aliasTarget}${tail}`;
      // Co-definition set (R8): the alias target competes with a same-named enclosing-ns member
      // and the verbatim reading — 2+ of these resolving = ambiguous → silence.
      const coDef: SymbolSetMember[] = dedupKeys([aliasKey, ...enclosing, ref]).map((k) => ({
        symbolKey: k,
      }));
      add({ kind: 'symbol', symbolKey: aliasKey, set: coDef });
    }

    for (const k of enclosing) add({ kind: 'symbol', symbolKey: k });

    for (const m of usingMembers) {
      add({ kind: 'symbol', symbolKey: m.symbolKey, nestedOnly: m.nestedOnly, set: usingMembers });
    }

    add({ kind: 'symbol', symbolKey: ref }); // verbatim / bare top-level — LAST

    if (candidates.length === 0) return;
    out.push({ candidates, kind: 'import', line });
  };

  /** Emit a two-reading attribute group (`written` and its `Attribute`-suffixed form) as ONE
   *  ordered group, each reading carrying its own alias/enclosing-ns/using/verbatim candidates,
   *  concatenated so the verbatim short form is reached only when nothing nearer binds. */
  const pushAttribute = (
    written: string,
    suffixed: string | undefined,
    enclosingNs: string[],
    line: number,
  ): void => {
    const before = out.length;
    pushRef(written, enclosingNs, line, false);
    if (suffixed !== undefined) pushRef(suffixed, enclosingNs, line, false);
    // Merge the (at most two) groups just pushed into one ordered group so both readings live
    // in a single reference (an attribute is ONE dependency, resolved by whichever name binds).
    mergeGroupsFrom(before, line);
  };

  /** Merge every group pushed since `before` into ONE ordered group (first-seen key order), so
   *  several readings of one reference resolve as a single dependency: the first reading that
   *  binds wins, and a present-but-ambiguous reading silences the rest. */
  const mergeGroupsFrom = (before: number, line: number): void => {
    if (out.length <= before + 1) return;
    const merged: TargetHint[] = [];
    const seenK = new Set<string>();
    for (const g of out.splice(before)) {
      for (const c of g.candidates) {
        if (c.kind === 'symbol') {
          if (seenK.has(c.symbolKey)) continue;
          seenK.add(c.symbolKey);
        }
        merged.push(c);
      }
    }
    out.push({ candidates: merged, kind: 'import', line });
  };

  /** The extension-method group for a call `value.Name(…)`: the extension keys of the enclosing
   *  namespaces innermost first, then the imported namespaces as ONE set (2+ owners declaring an
   *  in-scope `Name` → ambiguous → silence), then the global namespace. Aliases import no
   *  extension methods, and `using static` is not modelled, so neither contributes. */
  const pushExtension = (name: string, enclosingNs: string[], line: number): void => {
    // Distinct keys by construction: enclosing namespaces are distinct, the using prefixes are a
    // set, and a namespace both enclosing and imported only repeats a key the set already covers.
    const usingSet: SymbolSetMember[] = usingPrefixes
      .filter((p) => !enclosingNs.includes(p))
      .map((p) => ({ symbolKey: extensionKey(p, name) }));
    const candidates: TargetHint[] = [
      ...enclosingNs.map((ns): TargetHint => ({ kind: 'symbol', symbolKey: extensionKey(ns, name) })),
      ...usingSet.map((m): TargetHint => ({ kind: 'symbol', symbolKey: m.symbolKey, set: usingSet })),
      { kind: 'symbol', symbolKey: extensionKey('', name) },
    ];
    out.push({ candidates, kind: 'import', line });
  };

  // Replay the descriptors in original emit order (static targets first, then alias-RHS embedded
  // types, then the main walk) — the order is load-bearing for the downstream reason order.
  for (const r of refs) {
    switch (r.kind) {
      case 'static':
        // `using static N.C;` TARGET edge (A8/A11): resolve verbatim from root, sole candidate.
        out.push({ candidates: [{ kind: 'symbol', symbolKey: r.fqn }], kind: 'import', line: r.line });
        break;
      case 'plain':
        pushRef(r.ref, r.enclosingNs, r.line, r.rooted);
        break;
      case 'alias': {
        // `S::Tail` (B5): rewrite the leftmost alias to its aliased FQN and resolve `N.Tail` from
        // the root (verbatim FQN). Fires ONLY when `S` is a confirmed alias in the MERGED map —
        // an extern/unknown alias (`Lib::A.B`) is dropped (its `::` text cannot collide with a
        // dot-only key → R13 silence-by-luck).
        const aliasFqn = aliases.get(r.aliasName);
        if (aliasFqn !== undefined) {
          pushRef(`${aliasFqn}.${r.tail}`, r.enclosingNs, r.line, true);
        }
        break;
      }
      case 'attr':
        pushAttribute(r.written, r.suffixed, r.enclosingNs, r.line);
        break;
      case 'receiver': {
        // Each dotted prefix of the receiver is one reading, leftmost first, merged into ONE group.
        if (ambiguousAliases.has(r.chain[0])) break;
        const before = out.length;
        for (let i = 1; i <= r.chain.length; i++) pushRef(r.chain.slice(0, i).join('.'), r.enclosingNs, r.line, false);
        mergeGroupsFrom(before, r.line);
        break;
      }
      case 'ext':
        pushExtension(r.name, r.enclosingNs, r.line);
        break;
    }
  }

  return out;
}

/** The C# `uses()` — the delegating composition of the pure extract and the live assemble. The
 *  parity invariant `uses(file, opts) === assembleCsharpCandidates(extractCsharpRefs(file), opts)`
 *  holds by construction (this IS that composition). */
function uses(file: ParsedFile, options: CsharpUsesOptions = {}): DetectedDep[] {
  return assembleCsharpCandidates(extractCsharpRefs(file), options);
}

/** The C# `uses` with the optional cross-file global-using scope — called directly by the
 *  pass-level pre-pass (pass.ts) to inject project-wide `global using` prefixes. The interface
 *  `uses` (1-arg) on `csharpExtractor` delegates here with no options. */
export function csharpUses(file: ParsedFile, options?: CsharpUsesOptions): DetectedDep[] {
  return uses(file, options);
}

export const csharpExtractor: DependencyExtractor = {
  languages: new Set(['csharp']),
  rev: 3,
  declarations,
  uses,
};
