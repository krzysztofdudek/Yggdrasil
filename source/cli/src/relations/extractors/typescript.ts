import type { Node } from 'web-tree-sitter';
import path from 'node:path';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';
import { single } from './types.js';

/**
 * TypeScript / TSX / JavaScript dependency extractor.
 *
 * v1 scope = EXISTENCE, not relation type. A dependency edge is established
 * ONLY by a module-specifier-bearing construct: a static import, a re-export
 * with a source, `import x = require(...)`, a `require(...)` call, an
 * `import(...)` with a string-literal specifier (in a value or a type position),
 * a module augmentation `declare module '<spec>' { … }`,
 * or `new URL('<lit>', import.meta.url)`. Usage-site nodes (extends, implements, calls,
 * JSX, type references) would only REFINE the relation type of an
 * already-imported binding, and v1 does not enforce relation type — so this
 * extractor performs NO usage-site refinement. It emits exactly one path hint
 * per import-bearing statement.
 *
 * TYPE-ONLY REFERENCES ARE EDGES — ONE RULE FOR EVERY SPELLING. A relation
 * edge records that one node's code depends on another's, and a file that
 * compiles only because another module declares a type depends on that module
 * as much as a file that loads it: change or remove the type and the importer
 * breaks. So a type-only reference gives its edge exactly like a value import:
 * `import type { T } from`, an all-inline `import { type A } from`,
 * `export type { X } from`, `export type * [as ns] from`,
 * `import type X = require(…)`, an `import('…')` in a TYPE position
 * (`typeof import('./x')`, `let v: import('./x').T`, the type side of
 * `as`/`satisfies`, a type argument). A module augmentation
 * `declare module '<spec>' { … }` extends the declarations of the module it
 * names and compiles only against it, so it gives an edge too — when it IS an
 * augmentation: a relative name (TypeScript accepts a relative name only as an
 * augmentation), or any name without a `*` wildcard in a file that is itself a
 * module (a top-level import or export). The same header in a script file is
 * an ambient module declaration: it declares a module's shape instead of
 * depending on one, and stays silent, as does a wildcard pattern
 * (`declare module '*.css'`). Before 6.1.0 the statement forms were silent
 * while the type-position forms emitted; 6.1.0 makes every spelling an edge.
 *
 * Every non-empty specifier is emitted — relative ('./', '../'), root-absolute
 * ('/src/…'), package-internal ('#…') and bare ('@scope/pkg', 'lib/x'). The
 * resolver decides: a bare specifier becomes an edge only when the repository
 * itself defines it (a tsconfig `paths`/`baseUrl` mapping, or an in-repo
 * package.json `name`), and stays silent for an external package. A specifier
 * carrying a URL scheme (`node:path`, `https:`, `virtual:`) is never in-repo
 * and is dropped here.
 *
 * GRAMMAR RECOVERY. A grammar can turn valid modern syntax into an ERROR
 * region that swallows a statement. On the shipped TS/TSX/JS grammars the known
 * case is a re-export with import attributes (`export … from '…' with { … }`),
 * which disappears as a statement in all three; older builds also swallowed the
 * statements after `for (await using …)` and, in .tsx, after an
 * `import('x').T<U>` annotation, and the palette pins that those imports keep
 * their edge. A swallowed import is a real dependency with no edge, so every
 * source line an ERROR node touches is rescanned for a line-anchored
 * import/re-export statement (see `recoverFromErrors`); a recovered type-only
 * statement gives its edge like any other.
 */

/** Strip the surrounding quotes from a `string` node by reading its `string_fragment` child. */
function specifierFromStringNode(stringNode: Node | null): string | undefined {
  if (stringNode === null || stringNode.type !== 'string') return undefined;
  for (let i = 0; i < stringNode.namedChildCount; i++) {
    const child = stringNode.namedChild(i);
    if (child !== null && child.type === 'string_fragment') return child.text;
  }
  // Empty string literal ('') has no string_fragment child.
  return '';
}

/** Read the specifier from a node that carries a `source` field (import/export/import_require_clause). */
function specifierFromSource(node: Node): string | undefined {
  return specifierFromStringNode(node.childForFieldName('source'));
}

/**
 * Specifier from a dynamic-import / require ARGUMENT. Accepts a plain `string`
 * literal, OR a no-substitution `template_string` (a backtick literal with no
 * `${…}`) — both are static and statically resolvable, and TS/esbuild/Node treat
 * them identically. An INTERPOLATED template literal is genuinely non-static and
 * yields undefined (skipped), as do identifiers and other non-literal expressions.
 */
function specifierFromCallArg(arg: Node): string | undefined {
  if (arg.type === 'string') return specifierFromStringNode(arg);
  if (arg.type !== 'template_string') return undefined;
  let fragment: string | undefined;
  for (let i = 0; i < arg.namedChildCount; i++) {
    const child = arg.namedChild(i);
    if (child === null) continue;
    if (child.type === 'template_substitution') return undefined; // interpolated → non-static
    if (child.type === 'string_fragment') fragment = child.text;
  }
  // Empty template (``) has no string_fragment → ''. emit() ignores ''.
  return fragment ?? '';
}

/** A specifier with a URL scheme (`node:fs`, `https://…`, `virtual:x`, `data:…`) never names a repository file. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** True when a specifier may name a repository file (relative, root-absolute, `#imports` or bare). */
function isCandidateSpecifier(specifier: string): boolean {
  return specifier !== '' && !URL_SCHEME.test(specifier);
}

/** First argument of a call_expression / new_expression, or null. */
function argumentAt(call: Node, index: number): Node | null {
  const args = call.childForFieldName('arguments');
  if (args === null) return null;
  let seen = 0;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg === null || arg.type === 'comment') continue;
    if (seen === index) return arg;
    seen++;
  }
  return null;
}

/** True for the expression `import.meta.url`. */
function isImportMetaUrl(node: Node | null): boolean {
  if (node === null || node.type !== 'member_expression') return false;
  const object = node.childForFieldName('object');
  const property = node.childForFieldName('property');
  return object !== null && object.type === 'meta_property' && object.text.replace(/\s+/g, '') === 'import.meta'
    && property !== null && property.text === 'url';
}

/**
 * Line-anchored statement forms rescanned inside ERROR regions. The clause
 * between the keyword and `from` is restricted to the characters an import or
 * re-export clause can hold (identifiers, braces, commas, `*`, whitespace), so
 * an expression or a string that merely contains the word `from` never matches.
 */
const RECOVERY_PATTERNS: RegExp[] = [
  // import x from '…' · import { a, type B } from '…' · import * as ns from '…' · import type … · import defer * as …
  // export { a } from '…' · export * from '…' · export * as ns from '…' · export type { … } from '…'
  /^[ \t]*(?:import|export)\b([\w$\s{},*]*?)\bfrom[ \t]*(['"])([^'"\r\n]+)\2/gm,
  // import './side-effect'
  /^[ \t]*import()[ \t]*(['"])([^'"\r\n]+)\2/gm,
  // import x = require('…') · export import x = require('…') · import type x = require('…')
  /^[ \t]*(?:export[ \t]+)?import([ \t]+(?:type[ \t]+)?)[\w$]+[ \t]*=[ \t]*require[ \t]*\([ \t]*(['"])([^'"\r\n]+)\2/gm,
];

/** Zero-based rows touched by any ERROR node in the tree (empty for an error-free parse). */
function errorRows(root: Node): Set<number> {
  const rows = new Set<number>();
  if (!root.hasError) return rows;
  walk(root, (node) => {
    if (node.type !== 'ERROR') return undefined;
    for (let r = node.startPosition.row; r <= node.endPosition.row; r++) rows.add(r);
    return undefined;
  });
  return rows;
}

/**
 * Re-find import/re-export statements the grammar swallowed into an ERROR
 * region. A match counts only when one of the rows it spans is touched by an
 * ERROR node, so a clean parse (the common case) never runs a regex at all and
 * a regex never second-guesses a statement the grammar parsed. Returns
 * (specifier, 1-based line of the statement keyword) pairs.
 */
function recoverFromErrors(file: ParsedFile): Array<{ specifier: string; line: number }> {
  const rows = errorRows(file.tree.rootNode);
  if (rows.size === 0) return [];
  const out: Array<{ specifier: string; line: number }> = [];
  const content = file.content;
  // Row of every offset, computed lazily from newline positions.
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const rowOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  for (const pattern of RECOVERY_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const keywordOffset = m.index + (m[0].length - m[0].trimStart().length);
      const first = rowOf(keywordOffset);
      const last = rowOf(m.index + m[0].length - 1);
      let touched = false;
      for (let r = first; r <= last && !touched; r++) touched = rows.has(r);
      if (!touched) continue;
      out.push({ specifier: m[3], line: first + 1 });
    }
  }
  return out;
}

/** True for a pattern ambient module name (`*.css`, `virtual:*`), which names no module. */
function isWildcardModuleName(name: string): boolean {
  return name.includes('*');
}

/** True when the file is an ES module: a top-level import or export statement. */
function isModuleFile(root: Node): boolean {
  return root.namedChildren.some((c) => c !== null && (c.type === 'import_statement' || c.type === 'export_statement'));
}

/**
 * The specifier of a module augmentation `declare module '<spec>' { … }`, or
 * undefined when the header is an ambient module declaration instead. A relative
 * name is always an augmentation (TypeScript rejects a relative ambient name); any
 * other non-wildcard name is an augmentation only inside a module file.
 */
function augmentationSpecifier(moduleNode: Node, inModuleFile: boolean): string | undefined {
  const name = moduleNode.childForFieldName('name');
  if (name === null || name.type !== 'string') return undefined;
  const spec = specifierFromStringNode(name);
  if (spec === undefined || isWildcardModuleName(spec)) return undefined;
  if (spec.startsWith('.') || inModuleFile) return spec;
  return undefined;
}

function uses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();

  const emitAt = (specifier: string | undefined, line: number): void => {
    if (specifier === undefined || !isCandidateSpecifier(specifier)) return;
    const dedupKey = `${specifier}\n${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push(single({ kind: 'path', specifier }, 'import', line));
  };
  const emit = (specifier: string | undefined, node: Node): void =>
    emitAt(specifier, node.startPosition.row + 1);

  const inModuleFile = isModuleFile(file.tree.rootNode);

  walk(file.tree.rootNode, (node) => {
    switch (node.type) {
      case 'import_statement': {
        // Every form gives its edge, type-only ones included (`import type …`,
        // `import { type A }`, `import type x = require('./e')`).
        // `import x = require('./e')` — the source sits on import_require_clause. Every
        // other form carries its source on the statement itself.
        const requireClause = node.namedChildren.find(
          (c): c is Node => c !== null && c.type === 'import_require_clause',
        );
        if (requireClause) {
          emit(specifierFromSource(requireClause), node);
          break;
        }
        emit(specifierFromSource(node), node);
        break;
      }
      case 'export_statement': {
        // A `source` field is present ONLY on re-exports (`export ... from '...'`,
        // `export * from '...'`). A local export has none. `export type { … } from`,
        // `export type * from` and an all-inline-type clause give their edge too.
        emit(specifierFromSource(node), node);
        break;
      }
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn === null) break;
        // Dynamic import: callee is a node of type `import` (not an identifier).
        // Require: callee is an identifier whose text is `require`.
        const isDynamicImport = fn.type === 'import';
        const isRequire = fn.type === 'identifier' && fn.text === 'require';
        if (!isDynamicImport && !isRequire) break;
        // An import type (`typeof import('./x')`, `let v: import('./x').T`) is a
        // dependency like a value-position import() and gives the same edge.
        const arg = argumentAt(node, 0);
        if (arg === null) break;
        // A plain string literal OR a no-substitution template literal yields a
        // static specifier; an interpolated template literal / identifier / other
        // expression is non-literal and skipped (specifierFromCallArg returns undefined).
        emit(specifierFromCallArg(arg), node);
        break;
      }
      case 'module': {
        // `declare module './x' { … }` augments ./x (see augmentationSpecifier).
        emit(augmentationSpecifier(node, inModuleFile), node);
        break;
      }
      case 'new_expression': {
        // `new URL('./worker.js', import.meta.url)` — the asset/worker reference form
        // bundlers (Vite, webpack 5, Parcel, esbuild) resolve relative to the module.
        // URL resolution treats a plain 'worker.js' as relative too, so it is emitted
        // as './worker.js'. Only a literal first argument AND a literal
        // `import.meta.url` base count; any other base is a runtime URL.
        const ctor = node.childForFieldName('constructor');
        if (ctor === null || ctor.type !== 'identifier' || ctor.text !== 'URL') break;
        if (!isImportMetaUrl(argumentAt(node, 1))) break;
        const first = argumentAt(node, 0);
        const spec = first === null ? undefined : specifierFromCallArg(first);
        if (spec === undefined || spec === '' || URL_SCHEME.test(spec) || spec.startsWith('//')) break;
        emit(spec.startsWith('.') || spec.startsWith('/') ? spec : `./${spec}`, node);
        break;
      }
      default:
        break;
    }
    return undefined;
  });

  for (const { specifier, line } of recoverFromErrors(file)) emitAt(specifier, line);

  return out;
}

const TOP_LEVEL_DECLARATION_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'function_declaration',
  'enum_declaration',
]);

/** True when the declaration sits at module top level — directly under `program`,
 * or wrapped in an `export_statement` that is itself directly under `program`. */
function isTopLevel(node: Node): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.type === 'program') return true;
  if (parent.type === 'export_statement') {
    const grandparent = parent.parent;
    return grandparent !== null && grandparent.type === 'program';
  }
  return false;
}

function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  walk(file.tree.rootNode, (node) => {
    if (!TOP_LEVEL_DECLARATION_TYPES.has(node.type)) return undefined;
    if (!isTopLevel(node)) return undefined;
    const nameNode = node.childForFieldName('name');
    if (nameNode === null) return undefined;
    out.push({ symbolKey: nameNode.text, line: node.startPosition.row + 1 });
    return undefined;
  });
  return out;
}

export const typescriptExtractor: DependencyExtractor = {
  languages: new Set(['typescript', 'tsx', 'javascript']),
  // rev 3: every type-only reference gives its edge (statement forms, type-position
  // import(), `import type = require`) and a module augmentation names its module.
  // rev 2: bare/`#`/root-absolute specifiers emit (the resolver decides);
  // `new URL(…, import.meta.url)`; ERROR-region recovery.
  rev: 3,
  declarations,
  uses,
};

/** The script view of a single-file component the relation pass parses in place of its raw bytes. */
export interface SfcScriptView {
  /** Extractor language of the script blocks: `typescript`, `tsx` or `javascript`. */
  language: string;
  /** Path handed to the parser — the component's own path plus the grammar's extension. */
  parsePath: string;
  /** The component with every byte outside its `<script>` bodies blanked (newlines kept). */
  content: string;
}

const SFC_EXTENSIONS = new Set(['.vue', '.svelte']);
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * Vue and Svelte single-file components carry their imports in `<script>` blocks
 * (`<script>`, `<script setup lang="ts">`, `<script context="module">`). No shipped
 * grammar parses a whole component, so the relation pass parses a VIEW of it: every
 * byte outside a script body becomes a space (newlines are kept, so every line
 * number is the component's own), and the view is parsed with the TS, TSX or JS
 * grammar the blocks' `lang` names (`ts`/`typescript` → TS, `tsx` → TSX, otherwise
 * JS). Returns null for any other file, or a component with no script block.
 */
export function sfcScriptView(filePath: string, content: string): SfcScriptView | null {
  if (!SFC_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase())) return null;
  const keep: Array<[number, number]> = [];
  let language = 'javascript';
  SCRIPT_BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_BLOCK.exec(content)) !== null) {
    const lang = /\blang\s*=\s*["']?([\w-]+)/i.exec(m[1])?.[1]?.toLowerCase();
    if (lang === 'tsx') language = 'tsx';
    else if ((lang === 'ts' || lang === 'typescript') && language !== 'tsx') language = 'typescript';
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    keep.push([bodyStart, bodyStart + m[2].length]);
  }
  if (keep.length === 0) return null;
  let view = '';
  let cursor = 0;
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  for (const [start, end] of keep) {
    view += blank(content.slice(cursor, start)) + content.slice(start, end);
    cursor = end;
  }
  view += blank(content.slice(cursor));
  const ext = language === 'typescript' ? '.ts' : language === 'tsx' ? '.tsx' : '.js';
  return { language, parsePath: filePath + ext, content: view };
}
