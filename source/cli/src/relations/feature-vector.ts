/**
 * feature-vector.ts — a per-file STRUCTURAL FINGERPRINT computed from the AST.
 *
 * ## What this is
 *
 * `countFeatures` walks the tree-sitter parse tree the relation pass already produced
 * for a file and reduces it to a tiny fixed-shape vector of RAW integer counts:
 *
 *   - `nodeCount`      — number of NAMED AST nodes (anonymous punctuation excluded)
 *   - `depthQuartiles` — the 25th / 50th / 75th percentile of NAMED-node nesting depth
 *   - `categories`     — six raw counts, one per cross-language structural category
 *
 * These ten numbers are a cheap, deterministic "shape" of the file. A later layer
 * z-scores them across a file's neighbours to flag structurally-unusual files. This
 * module produces the RAW counts only — NO normalization, ratios, or z-scoring here.
 *
 * ## Speed-only, outside every hash
 *
 * The vector rides inside the content-addressed AST fact cache (a gitignored, rebuildable
 * speed cache). It is NEVER an ingredient of any verdict hash (`computeLlmInputHash` /
 * `computeDetInputHash` fold subject CONTENT, aspect, references, and tier name — never
 * a feature vector). Recomputing, changing, or corrupting a feature vector can therefore
 * never invalidate a verdict or change a relation-conformance result. It is pure
 * instrumentation.
 *
 * ## Per-language NON-comparability (important)
 *
 * The six CATEGORIES are a language-independent CONTRACT (below), but the per-language
 * node-type STRINGS that realize each category differ per grammar, and grammars carve the
 * same source into wildly different node counts. A Python `function-like` count is NOT
 * comparable to a Java one; a Go `nodeCount` is not comparable to a Ruby one. The anomaly
 * layer that consumes these vectors MUST z-score ONLY within a single family (same
 * extractor language) — never across languages.
 *
 * ## The six-category CONTRACT (pinned, language-independent)
 *
 *   - function-like — function / method / closure / lambda declarations & definitions.
 *   - class-like    — class / struct / interface / trait / enum / record / namespace-like
 *                     type declarations.
 *   - import-like   — the top-level import / require / use / include / using STATEMENT node
 *                     (the statement, not its inner specifiers: `import {a,b,c}` counts 1).
 *   - branch-like   — runtime control flow: if / for / while / do / switch / case / match /
 *                     try / catch (preprocessor conditionals like C's `preproc_if` are NOT
 *                     control flow and are excluded — this stays runtime-structural).
 *   - call-like     — call / invocation / construction expression nodes (all of them).
 *   - literal-like  — string / number / boolean / null literal nodes.
 *
 * ## Versioned WITH the cache schema
 *
 * `FEATURE_VOCAB` is versioned together with `CACHE_SCHEMA_VERSION` in `facts-cache.ts`:
 * ANY edit to this table (adding/removing a node-type string, a category, or a language)
 * changes what a warm shard would carry, so it is a cache-format change and REQUIRES a
 * `CACHE_SCHEMA_VERSION` bump. The bump orphans older shards (a one-time cold re-parse of
 * a gitignored cache — benign) and guarantees no shard ever mixes two vocab revisions.
 *
 * ## Derivation discipline — "derive and verify, never hardcode"
 *
 * Every node-type string below was grounded against the REAL shipped grammars, not memory:
 *   (a) parsed from real per-language fixtures (see `feature-vector.test.ts`, whose
 *       node-dump helper prints each fixture's named-node-type frequency map), AND
 *   (b) cross-checked to exist as a NAMED node type in the grammar's own
 *       `dist/grammars/<grammar>.node-types.json` catalog.
 * A handful of dominant-but-fixture-absent types (e.g. Go `select_statement` /
 * `type_switch_statement`, Rust `macro_invocation`, C++ `lambda_expression`) are included
 * from the grammar catalog under the same category contract — each is a real named node
 * type, verified present in the catalog. Rare/secondary constructs a grammar happens to
 * spell unusually are omitted rather than guessed; a category with no distinct node type
 * in a grammar is declared EMPTY with an inline reason (see Ruby `import-like`).
 */

import type { Node } from 'web-tree-sitter';

/** The six fixed, cross-language structural categories (pinned final). */
export type FeatureCategory =
  | 'function-like'
  | 'class-like'
  | 'import-like'
  | 'branch-like'
  | 'call-like'
  | 'literal-like';

/** Canonical order of the six categories — the single source of truth for iteration,
 *  zero-init, and validation. Every `FeatureVector.categories` object carries ALL six. */
export const ALL_FEATURE_CATEGORIES: readonly FeatureCategory[] = [
  'function-like',
  'class-like',
  'import-like',
  'branch-like',
  'call-like',
  'literal-like',
];

/**
 * RAW integer per-file counts. No normalization at write time — z-scoring is the anomaly
 * layer's job. Depth quartiles are integer NAMED-node depths (root = 0); `nodeCount` + the
 * six category counts round out the ten deviation dimensions the anomaly layer reads.
 */
export interface FeatureVector {
  /** Count of NAMED AST nodes (anonymous tokens excluded). */
  nodeCount: number;
  /** Integer NAMED-node depth q25 / q50 / q75 (nearest-rank percentile). */
  depthQuartiles: [number, number, number];
  /** ALL six category keys always present (0 when a category has no nodes in this file). */
  categories: Record<FeatureCategory, number>;
}

/** Convenience: a per-language category → node-type-set map. */
type LanguageVocab = Record<FeatureCategory, ReadonlySet<string>>;

const set = (...xs: string[]): ReadonlySet<string> => new Set(xs);

/**
 * The tree-sitter-typescript grammar is a superset of tree-sitter-javascript, and `.tsx` uses
 * the sibling tree-sitter-tsx grammar with the SAME node-type names (plus JSX, which is not in
 * any category). So `typescript` and `tsx` share this full vocab. `javascript` shares every
 * category EXCEPT class-like — the tree-sitter-javascript grammar has NO interface / enum /
 * type-alias / namespace / abstract-class node types (those are TypeScript-only) — and so gets
 * its own class-like subset in `JS_FAMILY` below. Each family is grounded per-grammar: every
 * string is a real named type in its own grammar's catalog, enforced by a standing test.
 *
 * NOTE on import-like: `export_statement` is deliberately EXCLUDED. The contract counts the
 * import STATEMENT only; an export is OUTBOUND linkage, not an import. `export_statement`
 * covers both re-exports (`export … from '…'`, which are inbound-ish) AND local
 * declaration-exports (`export const` / `export function` / `export class`, which are the
 * dominant form in real TS/JS and are NOT imports). Because `countFeatures` works purely on
 * `node.type`, it cannot isolate the re-export subset — so counting `export_statement` would
 * let exported-declaration counts dominate the import-like dimension and stop it measuring
 * what the pinned contract says. The only contract-faithful choice is to count
 * `import_statement` alone.
 */
const TS_FAMILY: LanguageVocab = {
  'function-like': set(
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'generator_function_declaration',
  ),
  'class-like': set(
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'enum_declaration',
    'type_alias_declaration',
    'internal_module', // `namespace X {}` / `module X {}`
  ),
  'import-like': set('import_statement'),
  'branch-like': set(
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'switch_case',
    'switch_default',
    'try_statement',
    'catch_clause',
    'ternary_expression',
  ),
  'call-like': set('call_expression', 'new_expression'),
  'literal-like': set('string', 'template_string', 'number', 'true', 'false', 'null', 'regex'),
};

/**
 * JavaScript: identical to the TS family in every category except class-like. The
 * tree-sitter-javascript grammar has no interface / enum / type-alias / namespace /
 * abstract-class node types (TypeScript-only), so JS class-like is just `class_declaration`.
 * Every string here exists in the tree-sitter-javascript catalog (standing test enforces it).
 */
const JS_FAMILY: LanguageVocab = {
  ...TS_FAMILY,
  'class-like': set('class_declaration'),
};

/**
 * Per-extractor-language node-type vocabulary. Keyed by the extractor language id
 * (`record.language`), which is what `countFeatures` is called with.
 *
 * Versioned WITH `CACHE_SCHEMA_VERSION` — see the module doc: any edit here is a cache
 * format change and requires a schema bump.
 */
export const FEATURE_VOCAB: Record<string, LanguageVocab> = {
  typescript: TS_FAMILY,
  tsx: TS_FAMILY,
  javascript: JS_FAMILY,

  python: {
    'function-like': set('function_definition'),
    'class-like': set('class_definition'),
    'import-like': set('import_statement', 'import_from_statement', 'future_import_statement'),
    'branch-like': set(
      'if_statement',
      'for_statement',
      'while_statement',
      'try_statement',
      'except_clause',
      'with_statement',
      'match_statement',
      'case_clause',
      'conditional_expression',
    ),
    'call-like': set('call'),
    'literal-like': set('string', 'integer', 'float', 'true', 'false', 'none'),
  },

  go: {
    'function-like': set('function_declaration', 'method_declaration'),
    'class-like': set('type_spec', 'type_alias'),
    // Go groups imports as `import ( … )` but the per-package `import_spec` is the meaningful
    // unit (and what the extractor keys on): one count per imported package.
    'import-like': set('import_spec'),
    'branch-like': set(
      'if_statement',
      'for_statement',
      'expression_switch_statement',
      'type_switch_statement',
      'expression_case',
      'type_case',
      'default_case',
      'communication_case',
      'select_statement',
    ),
    'call-like': set('call_expression'),
    'literal-like': set(
      'int_literal',
      'float_literal',
      'interpreted_string_literal',
      'raw_string_literal',
      'true',
      'false',
      'nil',
    ),
  },

  java: {
    'function-like': set('method_declaration'),
    'class-like': set(
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'record_declaration',
    ),
    'import-like': set('import_declaration'),
    'branch-like': set(
      'if_statement',
      'for_statement',
      'enhanced_for_statement', // for-each
      'while_statement',
      'do_statement',
      'switch_expression',
      'switch_block_statement_group', // one per case/default group
      'try_statement',
      'catch_clause',
    ),
    'call-like': set('method_invocation', 'object_creation_expression'),
    'literal-like': set(
      'decimal_integer_literal',
      'hex_integer_literal',
      'decimal_floating_point_literal',
      'string_literal',
      'character_literal',
      'true',
      'false',
      'null_literal',
    ),
  },

  csharp: {
    'function-like': set('method_declaration'),
    // `record struct` parses as `record_declaration` in the shipped grammar — there is no
    // distinct `record_struct_declaration` named node type here, so it is not listed.
    'class-like': set(
      'class_declaration',
      'interface_declaration',
      'struct_declaration',
      'record_declaration',
      'enum_declaration',
    ),
    'import-like': set('using_directive'),
    'branch-like': set(
      'if_statement',
      'for_statement',
      'foreach_statement',
      'while_statement',
      'do_statement',
      'switch_statement',
      'switch_section', // one per case/default group
      'try_statement',
      'catch_clause',
    ),
    'call-like': set('invocation_expression', 'object_creation_expression'),
    'literal-like': set(
      'integer_literal',
      'real_literal',
      'string_literal',
      'verbatim_string_literal',
      'character_literal',
      'boolean_literal', // covers both true and false
      'null_literal',
    ),
  },

  php: {
    'function-like': set('function_definition', 'method_declaration'),
    'class-like': set(
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
      'enum_declaration',
    ),
    'import-like': set('namespace_use_declaration'),
    'branch-like': set(
      'if_statement',
      'for_statement',
      'foreach_statement',
      'while_statement',
      'do_statement',
      'switch_statement',
      'case_statement',
      'try_statement',
      'catch_clause',
    ),
    'call-like': set(
      'function_call_expression',
      'member_call_expression', // $obj->m()
      'scoped_call_expression', // Foo::bar()
      'object_creation_expression',
    ),
    'literal-like': set('integer', 'float', 'string', 'encapsed_string', 'boolean', 'null'),
  },

  kotlin: {
    'function-like': set('function_declaration'),
    // `interface` and `enum class` are both spelled `class_declaration` in this grammar;
    // `object` declarations are `object_declaration`.
    'class-like': set('class_declaration', 'object_declaration'),
    'import-like': set('import'),
    'branch-like': set(
      'if_expression',
      'for_statement',
      'while_statement',
      'do_while_statement',
      'when_expression',
      'when_entry',
      'try_expression',
      'catch_block',
    ),
    'call-like': set('call_expression', 'constructor_invocation'),
    // This grammar has no distinct boolean/null literal node types (true/false/null are not
    // named literal nodes), so literal-like covers the numeric/string/char literals it does
    // spell out.
    'literal-like': set(
      'number_literal',
      'float_literal',
      'string_literal',
      'multiline_string_literal',
      'character_literal',
    ),
  },

  rust: {
    'function-like': set('function_item'),
    'class-like': set('struct_item', 'enum_item', 'trait_item', 'mod_item', 'union_item', 'type_item'),
    'import-like': set('use_declaration'),
    'branch-like': set(
      'if_expression',
      'for_expression',
      'while_expression',
      'loop_expression',
      'match_expression',
      'match_arm',
    ),
    'call-like': set('call_expression', 'macro_invocation'),
    'literal-like': set(
      'integer_literal',
      'float_literal',
      'string_literal',
      'raw_string_literal',
      'char_literal',
      'boolean_literal', // covers both true and false
    ),
  },

  c: {
    'function-like': set('function_definition'),
    'class-like': set('struct_specifier', 'enum_specifier', 'union_specifier', 'type_definition'),
    // Preprocessor conditionals (`preproc_if`/`preproc_ifdef`) are deliberately NOT branch-like:
    // they are compile-time, not runtime control flow. `preproc_include` IS the C import statement.
    'import-like': set('preproc_include'),
    'branch-like': set(
      'if_statement',
      'for_statement',
      'while_statement',
      'do_statement',
      'switch_statement',
      'case_statement',
    ),
    'call-like': set('call_expression'),
    'literal-like': set('number_literal', 'string_literal', 'char_literal', 'true', 'false'),
  },

  cpp: {
    'function-like': set('function_definition', 'lambda_expression'),
    'class-like': set(
      'class_specifier',
      'struct_specifier',
      'enum_specifier',
      'union_specifier',
      'namespace_definition',
      'type_definition',
    ),
    'import-like': set('preproc_include'),
    'branch-like': set(
      'if_statement',
      'for_statement',
      'for_range_loop',
      'while_statement',
      'do_statement',
      'switch_statement',
      'case_statement',
      'try_statement',
      'catch_clause',
    ),
    'call-like': set('call_expression', 'new_expression'),
    'literal-like': set('number_literal', 'string_literal', 'char_literal', 'true', 'false', 'null'),
  },

  ruby: {
    'function-like': set('method', 'singleton_method'),
    'class-like': set('class', 'module', 'singleton_class'),
    // Ruby has no distinct import/require STATEMENT node: `require_relative "x"` is a bare
    // `call` (a method invocation), indistinguishable by node TYPE from any other call. It is
    // therefore counted under call-like, and import-like is intentionally EMPTY for Ruby.
    'import-like': set(),
    'branch-like': set('if', 'for', 'while', 'until', 'case', 'when', 'begin', 'rescue'),
    'call-like': set('call'),
    'literal-like': set('string', 'integer', 'float', 'true', 'false', 'nil', 'simple_symbol'),
  },
};

// Per-language reverse lookup (node-type → category), built lazily once per language. Safe
// to memoize: FEATURE_VOCAB is a module constant. An unknown language yields an empty map,
// so a hypothetical extractor language not listed above degrades to an all-zero vector
// rather than throwing (every current extractor language IS covered).
const reverseCache = new Map<string, Map<string, FeatureCategory>>();

function reverseLookupFor(language: string): Map<string, FeatureCategory> {
  const cached = reverseCache.get(language);
  if (cached !== undefined) return cached;
  const lookup = new Map<string, FeatureCategory>();
  // Own-property guard: a reserved key inherited from Object.prototype
  // ('constructor', 'toString', '__proto__', …) resolves to an inherited value
  // on FEATURE_VOCAB, which would slip past the `!== undefined` check and then
  // throw when iterated as a LanguageVocab. Treat a non-own key as absent — the
  // same empty-lookup degradation an unlisted extractor language already gets.
  const vocab = Object.hasOwn(FEATURE_VOCAB, language) ? FEATURE_VOCAB[language] : undefined;
  if (vocab !== undefined) {
    for (const category of ALL_FEATURE_CATEGORIES) {
      for (const nodeType of vocab[category]) lookup.set(nodeType, category);
    }
  }
  reverseCache.set(language, lookup);
  return lookup;
}

/** Nearest-rank percentile of a pre-sorted ascending array. `rank = ceil(p·n)` (1-indexed),
 *  clamped into range; for n=1 every percentile is the sole element (well-defined). */
function nearestRank(sortedAsc: number[], p: number): number {
  const rank = Math.ceil(p * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

function depthQuartilesOf(depths: number[]): [number, number, number] {
  // Defensive: a parsed tree always has a NAMED root, so `countFeatures` records at least
  // one depth and never reaches here with an empty array. Guarded so the percentile math
  // stays well-defined (no negative index) if ever called on an empty set.
  /* v8 ignore next */
  if (depths.length === 0) return [0, 0, 0];
  const sorted = [...depths].sort((a, b) => a - b);
  return [nearestRank(sorted, 0.25), nearestRank(sorted, 0.5), nearestRank(sorted, 0.75)];
}

/**
 * Compute the structural feature vector for a parsed file, in a SINGLE deterministic
 * named-node DFS over the tree the extractor already parsed (no second parse).
 *
 * Depth is measured over NAMED nodes only (root = 0): descending through an anonymous node
 * does not increase depth, so the metric is a pure function of the named-node skeleton and
 * is resilient to how a grammar tokenizes punctuation. Only `node.isNamed` nodes are counted
 * toward `nodeCount`, `depthQuartiles`, and the category tallies — anonymous punctuation is
 * excluded (deterministic and structural). Child iteration mirrors `ast/walk.ts`
 * (`node.child(i)` over `childCount`).
 */
export function countFeatures(root: Node, language: string): FeatureVector {
  const lookup = reverseLookupFor(language);
  const categories: Record<FeatureCategory, number> = {
    'function-like': 0,
    'class-like': 0,
    'import-like': 0,
    'branch-like': 0,
    'call-like': 0,
    'literal-like': 0,
  };
  let nodeCount = 0;
  const depths: number[] = [];

  const visit = (node: Node, depth: number): void => {
    let childDepth = depth;
    if (node.isNamed) {
      nodeCount++;
      depths.push(depth);
      const category = lookup.get(node.type);
      if (category !== undefined) categories[category]++;
      childDepth = depth + 1;
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) visit(child, childDepth);
    }
  };
  visit(root, 0);

  return { nodeCount, depthQuartiles: depthQuartilesOf(depths), categories };
}

/**
 * Structural validator for a persisted feature vector. A v2 shard MUST carry a well-formed
 * `features` field; a missing or malformed one is a whole-shard cache MISS (fail-closed to
 * re-parse), NEVER a silent zero-vector that could feed a false "typical" reading into the
 * anomaly layer. Guards: `nodeCount` a finite number, `depthQuartiles` a length-3 numeric
 * tuple, `categories` an object carrying ALL six literal keys as finite numbers.
 */
export function isValidFeatureVector(value: unknown): value is FeatureVector {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<FeatureVector>;
  if (typeof v.nodeCount !== 'number' || !Number.isFinite(v.nodeCount)) return false;
  if (
    !Array.isArray(v.depthQuartiles) ||
    v.depthQuartiles.length !== 3 ||
    !v.depthQuartiles.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    return false;
  }
  if (v.categories === null || typeof v.categories !== 'object') return false;
  const cats = v.categories as Record<string, unknown>;
  for (const key of ALL_FEATURE_CATEGORIES) {
    const c = cats[key];
    if (typeof c !== 'number' || !Number.isFinite(c)) return false;
  }
  return true;
}
