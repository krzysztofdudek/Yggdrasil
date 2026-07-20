import { walk, report } from '@chrisdudek/yg/ast';

/**
 * Owner-resolution single-source boundary — AST-based, alias-proof, binding-specific.
 *
 * The child-precedence comparator `isBetterMappingOwner` (exported from
 * utils/mapping-path) encodes the hierarchy-first ownership rule: a descendant
 * node wins regardless of mapping length; length only breaks a sibling tie. A
 * pre-release sweep found that rule re-implemented in FOUR independent resolvers
 * that had drifted apart — one of them length-first and buggy, naming the wrong
 * node when a descendant mapped a broader pattern than its ancestor. The fix
 * consolidated everything onto ONE canonical resolver, relations/owner-index.ts,
 * whose `ownerOf` / `ownerEntryOf` are the only owner-resolution API. This aspect
 * keeps it that way: the comparator may be imported or called ONLY from
 * relations/owner-index.ts; every other first-party module must resolve ownership
 * through ownerOf / ownerEntryOf, never by pulling the comparator out and
 * re-hand-rolling the selection.
 *
 * This aspect is intended to cascade from the cli root node onto every descendant,
 * so each mapped source file is a subject of exactly one pair and EVERY potential
 * importer is seen. The check is self-contained — it inspects only its own subject
 * files (ctx.files), no cross-node reads.
 *
 * A hit is one of, all judged from the parse tree (a string literal that merely
 * contains the text is never a hit):
 *   - a static `import { isBetterMappingOwner } from '<mapping-path>'` (judged by
 *     ORIGINAL name — an `as` alias is still caught; an inline `type` specifier is
 *     erased and skipped);
 *   - a static `export { isBetterMappingOwner } from '<mapping-path>'` re-export
 *     (same original-name rule);
 *   - a namespace-member reference `ns.isBetterMappingOwner` where `ns` was bound
 *     by `import * as ns from '<mapping-path>'` (the laundering vector a bare
 *     namespace import opens — the bare `import * as ns` itself is NOT a hit, only
 *     a reference that resolves specifically to the comparator).
 *
 * Deliberately NOT a hit (errs: under — zero false positives): importing a
 * DIFFERENT symbol from mapping-path (mappingEntryMatchesFile, isGlobPattern, …),
 * a statement-level type-only import (`import type … from`, erased at compile), a
 * dynamic `import()`, or any reference not statically bound to the mapping-path
 * comparator. A wildcard `export * from 'mapping-path'` is also not treated as a
 * hit — it binds no specific name, so it is outside the "binding resolves to
 * isBetterMappingOwner" definition; a brand-new length-first resolver written
 * from scratch (which never touches the comparator) is likewise out of scope by
 * construction. Both are covered by the resolver's regression tests, not here.
 *
 * Test code is outside the enforcement engine and may reference either freely.
 */

/** The single canonical home for the comparator (matches the real repo path and a drill fixture replicating it). */
const OWNER_INDEX_RE = /(^|\/)relations\/owner-index\.ts$/;
/** Resolves a module specifier to the mapping-path module, bare or relative, with or without `.js`. */
const MAPPING_PATH_RE = /(^|\/)mapping-path(\.js)?$/;
/** The fenced comparator binding. */
const COMPARATOR_SYMBOL = 'isBetterMappingOwner';

/**
 * Test code is outside the enforcement engine, so it may import or call the
 * comparator freely (the resolver's own tests must). The boundary protects the
 * production ownership path, never the test tree.
 */
function isTestFile(filePath) {
  return filePath.startsWith('source/cli/tests/') || /\.(test|spec)\.[cm]?tsx?$/.test(filePath);
}

/**
 * A statement-level type-only import/export (`import type … from`, `export type …
 * from`) is fully erased at compile — it creates NO runtime dependency. The `type`
 * modifier surfaces as a direct child token of the statement; an inline
 * `import { type X, y }` keeps `type` inside the specifier (not a direct child),
 * so a value import is never mistakenly skipped.
 */
function isTypeOnly(node) {
  return node.children.some((c) => c.type === 'type');
}

/** Extract the literal string value of an import/export `source` node (no template substitutions). */
function stringValue(node) {
  if (!node) return undefined;
  if (node.type !== 'string' && node.type !== 'template_string') return undefined;
  if (
    node.type === 'template_string' &&
    node.namedChildren.some((c) => c.type === 'template_substitution')
  ) {
    return undefined;
  }
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  if (frag) return frag.text;
  const t = node.text;
  return t.length >= 2 ? t.slice(1, -1) : '';
}

/**
 * True when an `import … from '<mapping-path>'` pulls the comparator VALUE binding
 * into scope via a named specifier: `{ isBetterMappingOwner }` or
 * `{ isBetterMappingOwner as x }` (judged by ORIGINAL name — alias-proof; an
 * inline `type` modifier on the specifier is erased and does not count). A
 * namespace import (`* as ns`) is handled separately (member-reference), and a
 * pure different-symbol import is not a hit.
 */
function namedImportPullsComparator(importNode) {
  const clause = importNode.namedChildren.find((c) => c.type === 'import_clause');
  if (!clause) return false; // side-effect `import '<mapping-path>'` — no binding
  for (const child of clause.namedChildren) {
    if (child.type !== 'named_imports') continue;
    for (const spec of child.namedChildren) {
      if (spec.type !== 'import_specifier') continue;
      if (spec.children.some((c) => c.type === 'type')) continue; // inline `type X` — erased
      const name = spec.childForFieldName('name');
      if (name && name.text === COMPARATOR_SYMBOL) return true;
    }
  }
  return false;
}

/**
 * True when an `export { isBetterMappingOwner } from '<mapping-path>'` re-export
 * republishes the comparator by name (judged by ORIGINAL name — alias-proof).
 * A wildcard `export *` binds no specific name and is intentionally not a hit.
 */
function reexportPullsComparator(exportNode) {
  const clause = exportNode.namedChildren.find((c) => c.type === 'export_clause');
  if (!clause) return false;
  for (const spec of clause.namedChildren) {
    if (spec.type !== 'export_specifier') continue;
    const name = spec.childForFieldName('name');
    if (name && name.text === COMPARATOR_SYMBOL) return true;
  }
  return false;
}

/** The local name bound by `import * as ns from '<mapping-path>'`, or undefined. */
function namespaceBindingOf(importNode) {
  const clause = importNode.namedChildren.find((c) => c.type === 'import_clause');
  if (!clause) return undefined;
  for (const child of clause.namedChildren) {
    if (child.type !== 'namespace_import') continue;
    const id = child.namedChildren.find((c) => c.type === 'identifier');
    return id ? id.text : undefined;
  }
  return undefined;
}

function comparatorViolation(file, node, how) {
  return report(
    file,
    node,
    `${file.path} ${how} the child-precedence comparator '${COMPARATOR_SYMBOL}' (from utils/mapping-path) — ` +
      `hierarchy-first file ownership must live in exactly ONE place, relations/owner-index.ts, because a ` +
      `pre-release sweep found it re-implemented in four scattered resolvers that had drifted apart (one ` +
      `length-first and buggy, naming the wrong node when a descendant mapped a broader pattern than its ` +
      `ancestor). Resolve ownership via ownerOf / ownerEntryOf from relations/owner-index instead; the ` +
      `comparator must not be imported, re-exported, or called outside its single canonical home.`,
  );
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (isTestFile(file.path)) continue;
    if (OWNER_INDEX_RE.test(file.path)) continue; // the single canonical home — allowed

    // Pass 1 — collect the namespace bindings of the mapping-path module
    // (`import * as ns from '<mapping-path>'`), so a `ns.isBetterMappingOwner`
    // reference in the body can be resolved back to the comparator.
    const namespaceBindings = new Set();
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'import_statement') return;
      if (isTypeOnly(node)) return;
      const spec = stringValue(node.childForFieldName('source'));
      if (typeof spec !== 'string' || !MAPPING_PATH_RE.test(spec)) return;
      const ns = namespaceBindingOf(node);
      if (ns) namespaceBindings.add(ns);
    });

    // Pass 2 — report every provable static reference to the comparator.
    walk(file.ast.rootNode, (node) => {
      const isImport = node.type === 'import_statement';
      const isExportFrom = node.type === 'export_statement';

      if (isImport || isExportFrom) {
        if (isTypeOnly(node)) return; // erased at compile — no runtime binding
        const spec = stringValue(node.childForFieldName('source'));
        if (typeof spec !== 'string' || !MAPPING_PATH_RE.test(spec)) return;
        const pulls = isImport ? namedImportPullsComparator(node) : reexportPullsComparator(node);
        if (pulls) violations.push(comparatorViolation(file, node, isImport ? 'imports' : 're-exports'));
        return;
      }

      // Namespace-member reference: `ns.isBetterMappingOwner` where `ns` is a
      // mapping-path namespace import. Catches a call, an alias assignment, or a
      // callback pass — anything that resolves specifically to the comparator.
      if (node.type === 'member_expression') {
        const obj = node.childForFieldName('object');
        const prop = node.childForFieldName('property');
        if (
          obj &&
          prop &&
          obj.type === 'identifier' &&
          namespaceBindings.has(obj.text) &&
          prop.text === COMPARATOR_SYMBOL
        ) {
          violations.push(comparatorViolation(file, node, 'references'));
        }
      }
    });
  }

  return violations;
}
