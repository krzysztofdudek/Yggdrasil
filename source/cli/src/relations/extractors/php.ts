import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';
import { single } from './types.js';

/**
 * PHP dependency extractor.
 *
 * v1 scope = EXISTENCE, not relation type. The main unit of an inter-component edge in
 * PHP is the IMPORT: a top-level `namespace_use_declaration` (`use Foo\Bar;`) names a
 * fully-qualified class / interface / trait / enum, and emits one path hint per imported
 * symbol whose specifier is a PHP FULLY-QUALIFIED NAME with `\` separators
 * (`Foo\Bar\Baz`); the resolver maps that FQN → a file via composer autoload maps.
 * Usage sites in class positions add an edge only when they name a class the imports do
 * not already cover (see below); relation type is not enforced.
 *
 * Fully-qualified INLINE references WITH A LEADING BACKSLASH (`new \App\X()`,
 * `\App\X::y()`, `\App\X $param`, `extends \App\X`) ARE emitted. The leading `\` is PHP's
 * absoluteness marker: `\App\X` names the type `App\X` from the GLOBAL namespace, with no
 * dependence on the file's `namespace` or its `use` aliases — so it maps to a file by the
 * SAME PSR-4 rule as an import.
 *
 * NAMESPACE-RELATIVE class names (`Model\Id`, `namespace\Model\Id`, an unqualified `Id`)
 * in the same class positions are resolved with PHP's own compile-time rules, which need
 * nothing but the file itself: a qualified name's first segment goes through the file's
 * class imports (case-insensitively), else the current namespace is prepended; an
 * unqualified name that is imported is skipped (the import line already carries its edge),
 * else it takes the current namespace. PHP has NO global fallback for class names, so this
 * is the only reading — and the resolver still requires the file to exist. A result in the
 * global namespace is dropped (it may name a built-in class, which is never autoloaded).
 * Namespace regions (`namespace A;` runs, `namespace A { }` blocks) each keep their own
 * import table.
 *
 * Class positions only (a type, `new`, `extends` / `implements`, `::` static access, an
 * attribute, `instanceof`, `catch`, an in-class trait `use`). A name in FUNCTION-call
 * position (`\App\f()`, `helper()`) or a bare CONSTANT does NOT trigger class autoloading
 * — PHP keeps functions/constants in separate namespaces resolved at call time, never
 * mapped to a PSR-4 class file — so those positions are excluded.
 *
 * FILE INCLUDES: `require`/`require_once`/`include`/`include_once` whose operand is
 * statically file-relative (`__DIR__ . '/../lib/x.php'`, `dirname(__FILE__) . '/x.php'`,
 * `dirname(__DIR__, 2) . '/x.php'`) emit a path relative to the includer's directory
 * (`./../lib/x.php`), which the resolver tells apart from an FQN by its `/`. A bare
 * `'x.php'` is resolved at runtime through include_path and the working directory, and a
 * dynamic operand is unknowable, so both stay silent.
 *
 * Grammar shapes this extractor reads (verified live against tree-sitter-php_only):
 *   - Plain      `use App\Payment\Gateway;`
 *       namespace_use_declaration > namespace_use_clause > qualified_name
 *       (`.text` = `App\Payment\Gateway`; a single bare `name` for a one-segment import).
 *   - Aliased    `use App\Payment\Gateway as G;`
 *       the clause has qualified_name + a trailing `name` alias. The FQN is the
 *       qualified_name; the alias is the LOCAL binding and is NEVER the target.
 *   - Leading \  `use \App\Payment\Gateway;`
 *       qualified_name's first child is the anonymous `\` token; its `.text` carries a
 *       leading backslash — strip exactly one.
 *   - Grouped    `use App\Payment\{Charge, Refund as R};`
 *       namespace_use_declaration has a leading `namespace_name` child (`App\Payment`)
 *       and a `namespace_use_group` of namespace_use_clause nodes. Each group clause's
 *       symbol is its own qualified_name (nested group) or a bare `name` (`Charge`);
 *       the imported FQN = leading base + `\` + that segment.
 *   - function / const imports — two grammar placements, both SKIPPED (importing a
 *     function or constant, not a class; dropping them costs recall, never a false positive):
 *       * declaration-level `use function App\Util\format;` / `use const App\Util\{A, B};`
 *         — the anonymous `function`/`const` token is a direct child of the declaration;
 *         every clause it introduces is a function/const, so the whole declaration is skipped.
 *       * per-clause inside a group `use App\Pkg\{function format, Gateway};` — the token sits
 *         on the individual namespace_use_clause; ONLY that clause is dropped, sibling class
 *         clauses (here `Gateway`) are still emitted.
 */

/** Strip a single leading backslash from a PHP FQN: `\App\X` → `App\X`. */
function stripLeadingBackslash(fqn: string): string {
  return fqn.startsWith('\\') ? fqn.slice(1) : fqn;
}

/** The FQN text of a clause's name node: its `qualified_name`, or a bare `name`.
 *  Returns the raw `.text` (backslashes preserved) or undefined when neither is present. */
function clauseNameText(clause: Node): string | undefined {
  for (let i = 0; i < clause.namedChildCount; i++) {
    const child = clause.namedChild(i);
    if (child === null) continue;
    if (child.type === 'qualified_name' || child.type === 'name') return child.text;
  }
  return undefined;
}

/** True when a `use` declaration imports a FUNCTION or CONST at the DECLARATION level
 *  (`use function Base\X;`, `use const Base\{A, B};`) — the anonymous `function` / `const`
 *  token sits directly under the declaration, so EVERY clause it introduces is a
 *  function/constant, not a class. Such declarations are skipped wholesale — out of v1
 *  class-dependency scope. A grouped use that carries the token on an INDIVIDUAL clause
 *  instead (`use Base\{function f, Klass};`) is NOT caught here; that is guarded per clause
 *  by clauseIsFunctionOrConst during expansion. */
function isFunctionOrConstUse(decl: Node): boolean {
  for (let j = 0; j < decl.childCount; j++) {
    const c = decl.child(j);
    if (c !== null && !c.isNamed && (c.type === 'function' || c.type === 'const')) return true;
  }
  return false;
}

/** True when a single `namespace_use_clause` carries its OWN `function` / `const` token
 *  (the per-clause form inside a grouped use, e.g. `{function format, Gateway}` — only the
 *  `function format` clause is a function import). Such a clause imports a function/constant,
 *  not a class, and is dropped while its sibling class clauses are kept. */
function clauseIsFunctionOrConst(clause: Node): boolean {
  for (let k = 0; k < clause.childCount; k++) {
    const c = clause.child(k);
    if (c !== null && !c.isNamed && (c.type === 'function' || c.type === 'const')) return true;
  }
  return false;
}

/** The leading base namespace of a grouped `use Base\{A, B};` declaration, or undefined.
 *  It is the `namespace_name` child sitting directly under the declaration (NOT inside a
 *  clause), present only in the grouped form. */
function groupBase(decl: Node): string | undefined {
  for (let i = 0; i < decl.namedChildCount; i++) {
    const child = decl.namedChild(i);
    if (child !== null && child.type === 'namespace_name') return child.text;
  }
  return undefined;
}

/**
 * The PARENT node types under which a leading-backslash `qualified_name` is a CLASS
 * reference that PHP autoloads via PSR-4 — the sound allowlist that keeps inline detection
 * false-positive-free. Verified against tree-sitter-php_only:
 *   - object_creation_expression     `new \App\X()`
 *   - named_type                     a type hint (param/return/property), incl. inside a
 *                                    union_type / intersection_type / optional_type and a
 *                                    catch `type_list` (which wraps each type in named_type)
 *   - base_clause                    `extends \App\Base`
 *   - class_interface_clause         `implements \App\Iface`
 *   - scoped_call_expression         `\App\X::method()`  (the qualified_name is the scope)
 *   - scoped_property_access_expression `\App\X::$prop`
 *   - class_constant_access_expression  `\App\X::CONST`, `\App\X::class`
 *   - attribute                      `#[\App\Route]`
 *   - use_declaration                an IN-BODY trait use `use \App\Mixin\Trait;` (a class's
 *                                    `use_declaration`, distinct from the top-level namespace
 *                                    import `namespace_use_declaration`) — a real trait dependency
 * `instanceof` (`$x instanceof \App\Y`) parses as a binary_expression and is handled
 * separately (isInstanceofClassRef) — its right operand is a class reference, but a
 * binary_expression is not a class context in general, so it is NOT in this set.
 */
const CLASS_REF_PARENTS = new Set([
  'object_creation_expression',
  'named_type',
  'base_clause',
  'class_interface_clause',
  'scoped_call_expression',
  'scoped_property_access_expression',
  'class_constant_access_expression',
  'attribute',
  'use_declaration',
]);

/** True when `qn` is the right operand of an `instanceof` binary expression
 *  (`$x instanceof \App\Y`) — a class reference. Detected by an anonymous `instanceof`
 *  token child on the binary_expression parent. */
function isInstanceofClassRef(qn: Node): boolean {
  const parent = qn.parent;
  if (parent === null || parent.type !== 'binary_expression') return false;
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (c !== null && !c.isNamed && c.type === 'instanceof') return true;
  }
  return false;
}

/** True when a leading-backslash `qualified_name` sits in a class-autoload position — the
 *  only positions an inline FQN is emitted from (see CLASS_REF_PARENTS / isInstanceofClassRef).
 *  A function-call (`\App\f()`) parent is `function_call_expression`; a bare constant parent
 *  is a generic expression — neither is in scope, so both are excluded. */
function isClassReferenceContext(qn: Node): boolean {
  const parent = qn.parent;
  if (parent === null) return false;
  if (CLASS_REF_PARENTS.has(parent.type)) return true;
  return isInstanceofClassRef(qn);
}

/**
 * Class names that are never autoloaded: the relative scope keywords and the built-in type
 * names a type hint can spell as a plain `name` (`self`, `static`, `parent`, `mixed`, …).
 * Compared case-insensitively, as PHP does.
 */
const NON_CLASS_NAMES = new Set([
  'self', 'static', 'parent', 'array', 'bool', 'boolean', 'callable', 'false', 'float', 'double',
  'int', 'integer', 'iterable', 'mixed', 'never', 'null', 'object', 'string', 'true', 'void',
]);

/** One namespace region of a file: its byte range, its namespace (no leading/trailing `\`,
 *  '' = global) and its class-import table (lower-cased alias → FQN). */
interface NamespaceScope { start: number; end: number; ns: string; aliases: Map<string, string> }

/** Add the CLASS imports of one `use` declaration to an alias table. Function and constant
 *  imports are skipped (declaration-level and per-clause), exactly as for emission. */
function collectAliases(decl: Node, aliases: Map<string, string>): void {
  if (isFunctionOrConstUse(decl)) return;
  const base = groupBase(decl);
  const addClause = (clause: Node, prefix: string | undefined): void => {
    if (clauseIsFunctionOrConst(clause)) return;
    const nameText = clauseNameText(clause);
    if (nameText === undefined) return;
    const seg = stripLeadingBackslash(nameText);
    const fqn = prefix !== undefined && prefix !== '' ? `${prefix}\\${seg}` : seg;
    const aliasNode = clause.childForFieldName('alias');
    const alias = aliasNode !== null ? aliasNode.text : fqn.slice(fqn.lastIndexOf('\\') + 1);
    if (alias !== '') aliases.set(alias.toLowerCase(), fqn);
  };
  for (let i = 0; i < decl.namedChildCount; i++) {
    const child = decl.namedChild(i);
    if (child === null) continue;
    if (child.type === 'namespace_use_clause') addClause(child, undefined);
    else if (child.type === 'namespace_use_group') {
      for (let g = 0; g < child.namedChildCount; g++) {
        const clause = child.namedChild(g);
        if (clause !== null && clause.type === 'namespace_use_clause') addClause(clause, base);
      }
    }
  }
}

/** The namespace regions of a file, in source order. Unbracketed `namespace A;` runs to the
 *  next namespace declaration; bracketed `namespace A { … }` covers its own node. Code before
 *  any declaration is the global namespace. Imports belong to the region they appear in. */
function namespaceScopes(root: Node): NamespaceScope[] {
  let current: NamespaceScope = { start: 0, end: Number.POSITIVE_INFINITY, ns: '', aliases: new Map() };
  const scopes: NamespaceScope[] = [current];
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child === null) continue;
    if (child.type === 'namespace_definition') {
      const ns = stripLeadingBackslash(child.childForFieldName('name')?.text ?? '');
      const body = child.childForFieldName('body');
      if (body !== null) {
        const scope: NamespaceScope = { start: child.startIndex, end: child.endIndex, ns, aliases: new Map() };
        for (let j = 0; j < body.namedChildCount; j++) {
          const stmt = body.namedChild(j);
          if (stmt !== null && stmt.type === 'namespace_use_declaration') collectAliases(stmt, scope.aliases);
        }
        scopes.push(scope);
      } else {
        current.end = child.startIndex;
        current = { start: child.startIndex, end: Number.POSITIVE_INFINITY, ns, aliases: new Map() };
        scopes.push(current);
      }
    } else if (child.type === 'namespace_use_declaration') {
      collectAliases(child, current.aliases);
    }
  }
  return scopes;
}

function scopeAt(scopes: NamespaceScope[], index: number): NamespaceScope {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const sc = scopes[i];
    if (index >= sc.start && index < sc.end) return sc;
  }
  return scopes[0];
}

/**
 * Is this `name` / `qualified_name` / `relative_name` node the CLASS operand of a
 * class-autoload position? Unlike the leading-backslash check (parent type only), this also
 * checks the node's place under its parent, because a plain `name` also spells member names
 * (`X::method`, `X::CONST`), function names and constants.
 */
function isClassOperand(node: Node): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  const first = parent.namedChild(0);
  const isFirst = first !== null && first.id === node.id;
  switch (parent.type) {
    case 'object_creation_expression':
    case 'named_type':
    case 'class_constant_access_expression':
    case 'attribute':
      return isFirst;
    case 'base_clause':
    case 'class_interface_clause':
    case 'use_declaration':
      return true;
    case 'scoped_call_expression':
    case 'scoped_property_access_expression': {
      const scope = parent.childForFieldName('scope');
      return scope !== null && scope.id === node.id;
    }
    case 'binary_expression': {
      const right = parent.childForFieldName('right');
      return right !== null && right.id === node.id && isInstanceofClassRef(node);
    }
    default:
      return false;
  }
}

/**
 * Resolve a namespace-relative class name the way PHP does at compile time, or undefined
 * when it must not produce an edge:
 *   - `namespace\A\B` → current namespace + `A\B`;
 *   - a qualified `A\B` → the import aliased `A` + `\B` when there is one (case-insensitive),
 *     else current namespace + `A\B`;
 *   - an unqualified `A` → undefined when it is IMPORTED (the import line already carries
 *     that edge) or is a keyword/built-in type; else current namespace + `A`.
 * A result in the global namespace (no `\`) is dropped: a global class name may be a PHP
 * built-in, which is never autoloaded, so an in-repo file of that name proves nothing.
 */
function resolveRelativeClassName(node: Node, scope: NamespaceScope): string | undefined {
  const text = node.text.replace(/\s+/g, '');
  const prefixNs = (rest: string): string => (scope.ns === '' ? rest : `${scope.ns}\\${rest}`);
  let fqn: string;
  if (node.type === 'relative_name') {
    const rest = text.replace(/^namespace\\/i, '');
    if (rest === text || rest === '') return undefined;
    fqn = prefixNs(rest);
  } else if (node.type === 'qualified_name') {
    const segs = text.split('\\');
    const alias = scope.aliases.get(segs[0].toLowerCase());
    fqn = alias !== undefined ? [alias, ...segs.slice(1)].join('\\') : prefixNs(text);
  } else {
    const lower = text.toLowerCase();
    if (NON_CLASS_NAMES.has(lower) || scope.aliases.has(lower)) return undefined;
    fqn = prefixNs(text);
  }
  return fqn.includes('\\') ? fqn : undefined;
}

/** Magic constants are case-insensitive in PHP. */
function isMagic(node: Node | null, name: string): boolean {
  return node !== null && node.type === 'name' && node.text.toUpperCase() === name;
}

/**
 * The file-relative path of a `require`/`include` operand, as a specifier the resolver joins
 * to the includer's directory (`./../lib/x.php`), or undefined when it is not statically
 * file-relative. Accepted: `<base> . '<literal starting with />'` where `<base>` is
 * `__DIR__` (0 levels up), `dirname(__FILE__[, n])` (n − 1 levels) or `dirname(__DIR__[, n])`
 * (n levels), n an integer literal ≥ 1, and the literal a single-quoted or double-quoted
 * string with no interpolation. Anything else — a bare `'x.php'` (resolved through
 * include_path and the working directory), a variable, another function — is undefined.
 */
function staticIncludePath(operand: Node | null): string | undefined {
  let expr = operand;
  while (expr !== null && expr.type === 'parenthesized_expression') expr = expr.namedChild(0);
  if (expr === null || expr.type !== 'binary_expression') return undefined;
  let isConcat = false;
  for (let i = 0; i < expr.childCount; i++) {
    const c = expr.child(i);
    if (c !== null && !c.isNamed && c.type === '.') isConcat = true;
  }
  if (!isConcat) return undefined;
  const left = expr.childForFieldName('left');
  const right = expr.childForFieldName('right');
  if (left === null || right === null) return undefined;
  if (right.type !== 'string' && right.type !== 'encapsed_string') return undefined;
  if (right.namedChildCount !== 1 || right.namedChild(0)?.type !== 'string_content') return undefined;
  const literal = right.namedChild(0)!.text;
  if (!literal.startsWith('/') || literal.includes('\\')) return undefined;

  let levels: number;
  if (isMagic(left, '__DIR__')) {
    levels = 0;
  } else if (left.type === 'function_call_expression' && left.childForFieldName('function')?.text.toLowerCase() === 'dirname') {
    const args = left.childForFieldName('arguments');
    const argNodes: Node[] = [];
    for (let i = 0; i < (args?.namedChildCount ?? 0); i++) {
      const a = args!.namedChild(i);
      if (a !== null && a.type === 'argument') argNodes.push(a);
    }
    if (argNodes.length < 1 || argNodes.length > 2) return undefined;
    let n = 1;
    if (argNodes.length === 2) {
      const lit = argNodes[1].namedChild(0);
      if (lit === null || lit.type !== 'integer' || !/^[1-9][0-9]*$/.test(lit.text)) return undefined;
      n = Number(lit.text);
    }
    const target = argNodes[0].namedChild(0);
    if (isMagic(target, '__DIR__')) levels = n;
    else if (isMagic(target, '__FILE__')) levels = n - 1;
    else return undefined;
  } else {
    return undefined;
  }
  return `./${'../'.repeat(levels)}${literal.slice(1)}`;
}

const INCLUDE_TYPES = new Set([
  'include_expression',
  'include_once_expression',
  'require_expression',
  'require_once_expression',
]);

function uses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();

  const emit = (specifier: string | undefined, node: Node): void => {
    if (specifier === undefined || specifier === '') return;
    const cleaned = stripLeadingBackslash(specifier);
    if (cleaned === '') return;
    const line = node.startPosition.row + 1;
    const dedupKey = `${cleaned} ${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push(single({ kind: 'path', specifier: cleaned }, 'import', line));
  };

  const scopes = namespaceScopes(file.tree.rootNode);

  walk(file.tree.rootNode, (node) => {
    // A statically file-relative require/include (`__DIR__ . '/../lib/x.php'`).
    if (INCLUDE_TYPES.has(node.type)) {
      const spec = staticIncludePath(node.namedChild(0));
      if (spec !== undefined) emit(spec, node);
      return undefined;
    }

    // A namespace-relative class name in a class-autoload position (no leading `\`):
    // resolved with PHP's own compile-time rules from the file's namespace and imports.
    if (
      (node.type === 'name' || node.type === 'relative_name' ||
        (node.type === 'qualified_name' && !node.text.startsWith('\\'))) &&
      isClassOperand(node)
    ) {
      emit(resolveRelativeClassName(node, scopeAt(scopes, node.startIndex)), node);
      return undefined;
    }

    // Inline class reference: a leading-backslash `qualified_name` in a class-autoload
    // position. The leading `\` is the absoluteness marker (resolved from the global
    // namespace, shadow-free); the position allowlist excludes function/constant FQNs.
    // An import's qualified_name sits under namespace_use_clause (not a class context) and
    // is never matched here, so imports are handled solely by the branch below.
    if (node.type === 'qualified_name') {
      if (node.text.startsWith('\\') && isClassReferenceContext(node)) emit(node.text, node);
      return undefined;
    }

    if (node.type !== 'namespace_use_declaration') return undefined;
    // Skip function/const imports — they bind a function/constant, not a class.
    if (isFunctionOrConstUse(node)) return undefined;

    const base = groupBase(node);

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child === null) continue;

      if (child.type === 'namespace_use_clause') {
        // Plain / aliased clause directly under the declaration.
        if (clauseIsFunctionOrConst(child)) continue;
        const name = clauseNameText(child);
        emit(name, child);
      } else if (child.type === 'namespace_use_group') {
        // Grouped form: prepend the leading base namespace to each group clause.
        for (let g = 0; g < child.namedChildCount; g++) {
          const clause = child.namedChild(g);
          if (clause === null || clause.type !== 'namespace_use_clause') continue;
          if (clauseIsFunctionOrConst(clause)) continue;
          const seg = clauseNameText(clause);
          if (seg === undefined) continue;
          const segClean = stripLeadingBackslash(seg);
          const fqn =
            base !== undefined && base !== '' ? `${base}\\${segClean}` : segClean;
          emit(fqn, clause);
        }
      }
    }
    return undefined;
  });

  return out;
}

const DECLARATION_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'trait_declaration',
  'enum_declaration',
]);

/**
 * Declared top-level types — a thin parity layer (PHP v1 resolves dependencies by
 * PATH via composer.json PSR-4, not by symbol, so a PHP SymbolTable is not
 * load-bearing). Emits the names of `class` / `interface` / `trait` / `enum`
 * declarations (field `name`).
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  walk(file.tree.rootNode, (node) => {
    if (!DECLARATION_TYPES.has(node.type)) return undefined;
    const nameNode = node.childForFieldName('name');
    if (nameNode !== null) {
      out.push({ symbolKey: nameNode.text, line: node.startPosition.row + 1 });
    }
    return undefined;
  });
  return out;
}

export const phpExtractor: DependencyExtractor = {
  languages: new Set(['php']),
  rev: 2,
  declarations,
  uses,
};
