/**
 * source/cli/src/roots/binding.ts — spec §6.2 binding derivation ("the heart
 * of total genericity"): for a single grammar's `node-types.json`, derive
 * which node TYPE NAMES act as scopes, imports, and decorators, purely from
 * the grammar's own declared field shapes and fixed, language-blind regexes
 * — never a per-language keyword list. `deriveBinding` is a PURE function of
 * an already-parsed node-types array; the disk read that produces that array
 * lives in `ast/node-types.ts` (ast-adapter), never here — this file's
 * architecture type (`roots-engine`) forbids importing `node:fs` directly.
 *
 * Also exports the two EXTRACTION-TIME helpers Task 4's `extract.ts` module
 * consumes rather than re-deriving: the lexical decoration-marker predicate
 * and the decoration attribution-window test. Both operate on primitives
 * (source text, row numbers) supplied by a caller that already holds a
 * parsed tree — `deriveBinding` itself never touches a live AST node.
 */

import type { NodeTypeEntry } from '../ast/node-types.js';
import { hashString } from '../io/hash.js';

/**
 * A grammar's derived binding (spec §6.2): the sets of node TYPE NAMES that
 * act as scopes, imports, and decorators for this grammar, plus the fixed
 * heritage-matcher pattern evaluated at extraction time against a scope
 * node's own named children (excluding its `body`). All three sets are
 * SORTED arrays (not `Set`s) so a `RootsBinding` value round-trips through
 * `JSON.stringify`/`bindingHash` and a committed snapshot fixture byte-stably
 * — a `Set` serializes as `{}`.
 *
 * The scope-KIND rule (spec §6.2: `type` when a scope's `body` subtree
 * contains at least one further scope node, `method` otherwise) is NOT a
 * separate field here — it needs a live, parsed `body` subtree to evaluate
 * ("contains"), which this binding does not carry, so it is applied at
 * extraction time (Task 4) by testing a body descendant's `type` for
 * membership in `scope` below. The rule is carried BY this binding in that
 * sense: `scope` is the only data the rule needs.
 */
export interface RootsBinding {
  /** Node type names declaring both a `name` field and a `body` field. */
  scope: string[];
  /** Node type names matching `IMPORT_NODE_TYPE_PATTERN`, not `_`-prefixed. */
  imports: string[];
  /**
   * REWORK R3: every NAMED node type this grammar's `node-types.json`
   * declares at all — the grammar's complete declared node-type vocabulary
   * (spec §7.1 E3's LITERAL domain: "methods in a grammar whose vocabulary
   * holds `<t>`", `v6-spec.md:213`), independent of what extraction ever
   * OBSERVES in any given repository or partition. "Named" excludes the
   * grammar's own anonymous/literal-token entries (punctuation, keywords
   * emitted as bare strings — e.g. `!=`, `{`) via `nodeType.named !== false`,
   * the same distinction tree-sitter's own `named`/`namedChildren` draws, AND
   * excludes `_`-prefixed HIDDEN grammar-internal supertypes (the same
   * exclusion `imports` already applies below, for the identical reason: a
   * hidden type is never emitted as a real node's `.type` in an actual
   * parse). `<t>` values this product ever tests against (statement/
   * expression/declaration/clause-shaped node types) are always named,
   * visible types, so both exclusions only shrink a vocabulary set that
   * would otherwise never be queried, never drop a real `<t>`. Unlike
   * `scope`/`imports`/`decorators`, this set is NOT filtered by any
   * structural rule (no field-shape test, no name-pattern match) — it is
   * the grammar's raw visible-named-type namespace, which is exactly what
   * "a grammar whose vocabulary holds `<t>`" means literally. `enumerate.ts`
   * reads this (via
   * `extract.ts`'s `RawScope.grammarNodeTypeVocabulary`, threaded at
   * extraction time since only extraction knows which grammar produced a
   * given file) to resolve E3's domain WITHOUT an extension-observed proxy —
   * see that file's own header comment for why the proxy this field replaces
   * was a poison risk.
   */
  nodeTypeVocabulary: string[];
  /**
   * Node type names matching `DECORATOR_NODE_TYPE_PATTERN` — the coarse,
   * grammar-NAME-only match. This set alone over-matches (TypeScript's
   * `type_annotation` satisfies it); a candidate counts as a real decoration
   * only when it ALSO passes {@link isDecorationMarkerText} at extraction
   * time, which this set does not encode.
   */
  decorators: string[];
  /**
   * Regex source (no flags) for the heritage-node-type matcher, evaluated at
   * extraction time against a scope node's own named children, excluding its
   * `body` — fixed and identical for every grammar (spec §6.2), carried here
   * as data rather than a module-level constant only so every derivation
   * consumer can read the complete binding from one value. Reconstruct with
   * `new RegExp(binding.heritagePattern)`; a `RegExp` instance is not stored
   * directly because it does not survive `JSON.stringify` (bindingHash) or a
   * committed snapshot fixture.
   */
  heritagePattern: string;
}

/** Spec §6.2's import-node-type matcher (fixed, identical for every grammar). */
const IMPORT_NODE_TYPE_PATTERN = /import|include|use_declaration|require/;

/**
 * Spec §6.2's decorator-node-type matcher (fixed, identical for every
 * grammar) — grammar-NAME-only; see {@link RootsBinding.decorators}'s doc for
 * why this alone over-matches and what closes the gap.
 */
const DECORATOR_NODE_TYPE_PATTERN = /decorator|annotation|attribute_list/;

/**
 * Spec §6.2's heritage-node-type matcher (fixed, identical for every
 * grammar). `argument_list` is included because Python expresses base
 * classes that way; restricting the match to a scope node's own named
 * children EXCLUDING its `body` (applied by the extraction-time caller, not
 * here) is what keeps it from also matching ordinary call arguments deeper
 * inside a method body.
 */
const HERITAGE_NODE_TYPE_PATTERN = /heritage|extends|implements|superclass|super_interfaces|base_|superclasses|argument_list/;

/**
 * Derives a grammar's {@link RootsBinding} from its parsed `node-types.json`
 * (spec §6.2). Pure: same `nodeTypes` array, same binding, every time — no
 * I/O, no randomness. A node type whose name would match more than one rule
 * (e.g. it both declares `name`+`body` AND matches the import pattern) is
 * simply a member of both resulting sets; the rules are independent, not a
 * priority chain.
 */
export function deriveBinding(nodeTypes: NodeTypeEntry[]): RootsBinding {
  const scope = new Set<string>();
  const imports = new Set<string>();
  const decorators = new Set<string>();
  const nodeTypeVocabulary = new Set<string>();

  for (const nodeType of nodeTypes) {
    const fields = nodeType.fields ?? {};
    // Own-property guard: node-types.json is attacker-free (a committed,
    // build-produced file), but `fields`/`nodeType.type` are still parsed
    // JSON keyed by grammar-chosen field names — a field literally named
    // "constructor" must read as absent, not as Object.prototype.constructor.
    if (Object.hasOwn(fields, 'name') && Object.hasOwn(fields, 'body')) {
      scope.add(nodeType.type);
    }
    if (IMPORT_NODE_TYPE_PATTERN.test(nodeType.type) && !nodeType.type.startsWith('_')) {
      imports.add(nodeType.type);
    }
    if (DECORATOR_NODE_TYPE_PATTERN.test(nodeType.type)) {
      decorators.add(nodeType.type);
    }
    // REWORK R3: `named !== false` — an entry with no `named` key at all is
    // treated as named (node-types.json's own schema only ever sets `named`
    // explicitly to `false` for anonymous/literal-token entries; every named
    // entry either omits the key or sets it `true`), matching `nodeTypeVocabulary`'s
    // own doc. `_`-prefixed entries are excluded too, for the SAME reason
    // `imports` above excludes them: an underscore-prefixed type is a HIDDEN
    // grammar-internal supertype (a rule-composition abstraction, e.g. Go's
    // own `_statement`/`_expression`) that tree-sitter never emits as a real
    // node's `.type` in an actual parse — it can never appear in
    // `nodeTypesSeen`, so including it here would only pad the vocabulary
    // with tokens `auto.has:<t>` could never legitimately test.
    if (nodeType.named !== false && !nodeType.type.startsWith('_')) {
      nodeTypeVocabulary.add(nodeType.type);
    }
  }

  return {
    scope: [...scope].sort(),
    imports: [...imports].sort(),
    decorators: [...decorators].sort(),
    nodeTypeVocabulary: [...nodeTypeVocabulary].sort(),
    heritagePattern: HERITAGE_NODE_TYPE_PATTERN.source,
  };
}

/**
 * The lexical decoration-marker predicate (spec §6.2): a candidate decorator
 * node counts as a real decoration only if its OWN source text begins with
 * `@` or `[` after leading whitespace. This is what filters
 * {@link RootsBinding.decorators}'s grammar-name over-match — concretely,
 * TypeScript's `type_annotation` node type satisfies `DECORATOR_NODE_TYPE_PATTERN`
 * (its name contains "annotation"), but a real type annotation's source text
 * (e.g. `: fastq.queueAsPromised<Job>`) never starts with `@`/`[`, so this
 * predicate returns `false` for it and the spurious decoration is dropped —
 * exactly the defect the prototype's verification measured on a real repo
 * (`2026-08-17-yg-roots-prototype-report.md`'s decorator-binding-over-match
 * finding). The marker is LEXICAL, not semantic: Python/TypeScript decorators
 * and Java/Kotlin annotations start with `@`; C# attribute lists start with
 * `[`; annotation-*shaped* grammar names that are really type syntax never do.
 */
export function isDecorationMarkerText(nodeSourceText: string): boolean {
  return /^[@[]/.test(nodeSourceText.trimStart());
}

/**
 * The decoration attribution-window test (spec §6.2): a marker-passing
 * candidate is attributed to a scope only if its own start row lies STRICTLY
 * AFTER `loRow` (the end row of the scope's previous non-decoration,
 * non-comment sibling) and AT OR BEFORE `bodyRow` (the start row of the
 * scope's own `body`) — the half-open-below, closed-above interval
 * `(loRow, bodyRow]`.
 *
 * The window is closed on both sides for two independent reasons. The lower
 * bound is what stops a PRECEDING member's decorators — in a class body,
 * every earlier method's — from being attributed to this later scope; a
 * one-sided "decorator ends at or just above my start row" test would
 * attribute the whole preceding stack, a measured defect. The upper bound at
 * `bodyRow` (rather than at the scope's own start row) is what makes the rule
 * COMPLETE: a decorator stack of any height between the previous sibling and
 * the body is attributed in full, and parameter-level annotations — which sit
 * lexically after the scope's name and before its body — are attributed to
 * the scope that declares them instead of being lost. Comments between
 * decorations do not close the window (the caller never treats a comment
 * sibling as advancing `loRow`); any other sibling does.
 */
export function isWithinDecorationWindow(candidateStartRow: number, loRow: number, bodyRow: number): boolean {
  return candidateStartRow > loRow && candidateStartRow <= bodyRow;
}

/**
 * Serialize any JSON-representable value to a canonical JSON string: object
 * keys sorted in code-point order at every level, `undefined` values
 * dropped. A self-contained copy, not a shared import — `roots/config.ts`
 * keeps its own private copy of the same handful of lines for the identical
 * reason: `roots-engine`'s architecture `calls` allowlist (persistence-adapter,
 * utility) has no edge to wherever a shared canonical-JSON helper would
 * legally live, so the two (now three, counting `io/type-class-cache.ts`'s
 * own private copy) are kept in sync only by intent — the same honest cost
 * each of those files' own header comments names.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * sha256 of the canonical-JSON of a {@link RootsBinding} — the PER-GRAMMAR
 * hash. This is NOT the roots model header's `bindingHash` field: spec
 * §4.4/§4.5 define that header value as the fold over EVERY grammar actually
 * used by a build ("sha256 over the sorted derived binding sets of every
 * grammar used"), computed by the Task-6 mining pipeline from one call to
 * this function per grammar. Nothing in this file writes the header value —
 * say so here because that pipeline is the only other place `bindingHash`
 * (the name) appears, and the two must not be confused.
 */
export function bindingHash(binding: RootsBinding): string {
  return hashString(canonicalJson(binding));
}
