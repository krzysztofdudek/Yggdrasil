/**
 * source/cli/src/roots/extract.ts — spec §6 extraction layer, phase 1 and 3 of
 * the roots engine's three-phase split (partitioning, phase 2, lives in
 * `partitions.ts` so `finalizeUnits` here can consume its output).
 *
 * PHASE 1 — `extractUnits(relPath, source, tree, binding)`: a PURE, SYNCHRONOUS
 * per-file walk over an already-parsed tree. It discovers every named-body
 * scope (`method`/`type`, spec §6.2's scope rule) plus the file's own single
 * `file` scope, and records the RAW ingredients later stages need — never a
 * partitionId, never a stable_id (both are partition-dependent, spec §6.3/6.4,
 * and partitioning runs AFTER this phase — see `partitions.ts`'s header for
 * why). It does NOT compute any of the twelve enumerator surfaces itself
 * (`enumerate.ts` owns all twelve, spec §7.1); this file only collects the
 * observables those enumerators and their sparse-boolean domains (spec §5)
 * need — node types seen, callee texts, statement shapes, declared locals,
 * heritage-matched supertypes, marker-filtered decorators, raw import
 * specifiers — leaving every char-class/shape/token computation to the
 * consumer that also holds the per-partition vocabulary.
 *
 * PHASE 3 — `finalizeUnits(rawScopes, partitions)`: assigns each raw scope its
 * FINAL `partitionId` (from `partitions.ts`'s phase-2 output), synthesizes
 * `module` scopes per spec §6.3's partition-dependent rule, and mints the two
 * production identity keys every downstream stage reads: `skeyR` (the
 * prototype's `rel#kind#name[#ord]` key, `prototype-roots2.mjs:121`) and
 * `stable_id` (spec §6.4's production scheme, sha256hex-truncated).
 *
 * THREADED, NOT CONFIG-FREE (revised from this file's original reading of the
 * plan's Interfaces section): three of spec §4.5's `enumerate.*` keys —
 * `shapeDepth`, `shapeMaxStatements`, `localVarSampleMax` — only have meaning
 * at THIS raw-collection stage (the live AST is gone by the time
 * `enumerate.ts` runs), so `extractUnits` accepts them as an optional,
 * TRAILING `ExtractOptions` parameter rather than the whole `RootsConfig`
 * (keeping this function's "pure, no unrelated coupling" character — it takes
 * exactly the three scalars it needs, nothing else `RootsConfig` carries) —
 * the plan's own threading parenthetical authorizes this signature widening.
 * The real production caller (the mining pipeline) sources these three values
 * from `config.roots.enumerate` and passes them through; every value is
 * OPTIONAL and defaults to spec §4.5's own default (`DEFAULT_ROOTS.enumerate`
 * in `io/config-parser.ts`: shapeDepth 2, shapeMaxStatements 20,
 * localVarSampleMax 20) so a caller with no config override (or an existing
 * test) behaves exactly as before. This is unrelated to spec §7.2's stated
 * tuning surface ("support floors and top-Ks are the product's only tuning
 * surface for the feature space"): those live entirely in `enumerate.ts`'s
 * `buildVocabularies`, which independently receives the full `config`.
 */

import type { SyntaxNode, Tree } from '../ast/types.js';
import type { RootsBinding } from './binding.js';
import { isDecorationMarkerText, isWithinDecorationWindow } from './binding.js';
import { hashString } from '../io/hash.js';
import type { PartitionMap } from './partitions.js';

/** Spec §6.7's fixed per-scope body-walk visit cap — an I1 guard against pathological generated files. */
export const BODY_VISIT_CAP = 4000;

/** Spec §4.5's own defaults for the three raw-collection-time `enumerate.*` knobs — the fallback `ExtractOptions` values below apply when a caller passes none, or omits one. */
const DEFAULT_SHAPE_DEPTH = 2;
const DEFAULT_SHAPE_MAX_STATEMENTS = 20;
const DEFAULT_LOCAL_VAR_SAMPLE_MAX = 20;

/**
 * `extractUnits`'s optional trailing parameter — the three raw-collection-time
 * `enumerate.*` knobs (see this file's header comment). Every field is
 * optional and falls back to spec §4.5's own default; a caller passes
 * `config.roots.enumerate`'s matching fields (or a subset) to make these
 * adopter-configurable, or omits the parameter entirely to get the defaults.
 */
export interface ExtractOptions {
  shapeDepth?: number;
  shapeMaxStatements?: number;
  localVarSampleMax?: number;
}

/** Callee texts longer than this, or containing a newline, are dropped as extraction noise (spec §7.2, fixed). */
const MAX_CALLEE_TEXT_LENGTH = 40;

/** Import-node target-text shape (grammar-generic: a string/string_literal descendant, or an identifier-shaped named child). */
const IMPORT_TARGET_IDENTIFIER_RE = /dotted_name|scoped_identifier|identifier|package/;
const CALL_NODE_TYPE_RE = /call/;
const RETURN_NODE_TYPE_RE = /return/;

export type ScopeKind = 'method' | 'type' | 'file';

/**
 * A single scope's raw, per-file extraction output — every ingredient a later
 * stage needs, computed once here so nothing downstream re-walks the (by then
 * deleted) AST. Fields are grouped: identity, decoration/heritage (both kinds
 * except `file`), file-shared imports, then method-only body observables
 * (defaulted/empty for `type`/`file` scopes, never `undefined` — a plain
 * value is easier for every consumer to fold than an optional one).
 */
export interface RawScope {
  kind: ScopeKind;
  relPath: string;

  /** Raw AST name text, or the literal `'<anon>'` for an unnamed scope (spec §6.4). */
  name: string;
  /**
   * The name AS QUALIFIED for stable-identity purposes: `name` with the
   * occurrence ordinal folded in — spec §6.4 states TWO ordinal-suffix rules
   * (anonymous scopes ALWAYS carry `<anon>` + ordinal; same-name overloads
   * carry `#k`, elided at k = 0) and this field applies both, because spec
   * §6.4's `stable_id` formula (`partitionId ∥ relPath ∥ kind ∥ qualifiedName
   * ∥ arity`) has no separate ordinal slot of its own — folding the ordinal
   * into `qualifiedName` is what keeps two overloads sharing the same arity
   * from colliding on the same stable_id, honoring §6.4's own binding
   * requirement ("the ordinal MUST therefore appear in [every keyed
   * surface]") without adding a field the formula does not name. A DECIDED
   * reading, stated once here since every downstream stable_id consumer
   * relies on it.
   */
  qualifiedName: string;
  /** Occurrence index of this (kind, name) pair within the file, in source order (spec §6.4). */
  ordinal: number;
  /** Parameter-list named-child count for `method` scopes; 0 for `type`/`file`. */
  arity: number;
  /** Whether a `parameters` field node exists at all — E2's domain ("methods with a parameter list"), distinct from arity = 0. */
  hasParameterList: boolean;
  /** 0-based tree-sitter start row — diagnostics and tests only, never a hashed/keyed value. */
  startRow: number;

  /** Heritage-matcher-derived supertype/interface identifier texts (E9 raw; spec §6.2's heritage rule). Not vocabulary-pruned. */
  supertypes: string[];
  /** Marker-filtered decoration names attributed to this scope (E6-deco raw; spec §6.2's window + lexical marker). Not vocabulary-pruned. */
  decorators: string[];
  /** Whether this scope's OWN grammar binding declares any decorator node types at all — E6-deco's domain ("scopes in a grammar with decorator nodes"), independent of whether any were observed on this scope. */
  grammarHasDecoratorTypes: boolean;
  /** Whether this scope's own non-`body` named children included at least one node type matching the heritage pattern (regardless of whether it yielded any identifier) — E9's domain proxy ("scopes in a grammar with heritage nodes"); see this file's `deriveHeritage` for why this is an empirical per-scope proxy rather than a static grammar-level flag. */
  grammarHasHeritageCandidacy: boolean;
  /**
   * REWORK R3: this scope's own grammar's COMPLETE declared named node-type
   * vocabulary (`RootsBinding.nodeTypeVocabulary`, read once per file and
   * shared — same array reference — across every scope of that file, exactly
   * like `fileImports` below) — E3's domain ingredient ("methods in a grammar
   * whose vocabulary holds `<t>`", spec §7.1/`v6-spec.md:213`, read
   * LITERALLY). Threaded here rather than reconstructed in `enumerate.ts`
   * from a file's extension, because `EXT2GRAMMAR` is MANY-to-one (e.g.
   * `.ts`/`.mts`/`.cts` all resolve to the one `typescript` grammar): an
   * extension-keyed reconstruction at enumeration time would wrongly treat
   * two extensions of the SAME grammar as different capability domains,
   * excluding a `.mts` method from E3's domain for a token this partition
   * only happened to observe under `.ts` — undercounting `n_false` in the
   * PERMISSIVE direction (a scope that could legitimately count as a
   * grammar-supported-but-absent "false" instance is silently dropped
   * instead, making a candidate FACT look more universal than the evidence
   * supports). Capturing it HERE, at the exact moment the correct
   * `RootsBinding` for this file's grammar is already in hand, sidesteps the
   * extension/grammar distinction entirely.
   */
  grammarNodeTypeVocabulary: string[];

  /** Raw, UNNORMALIZED import specifier texts for the WHOLE FILE — shared (same array reference) across every scope extracted from this file, so `method`/`type` role-bag ingredients (§8.1's `imp:<seg>`) and the `file` scope's own E8 surface read the same data. */
  fileImports: string[];

  /** E6-call raw candidate callee texts (method only; ≤ 40 chars, no newline). */
  calleeTexts: string[];
  /** Raw node types observed anywhere in the scope's own body walk, not descending into a nested scope (E3 raw; the "statement/expression/declaration/clause" vocabulary-eligibility filter is `enumerate.ts`'s to apply). Method only. */
  nodeTypesSeen: string[];
  /** Raw depth/count-limited statement-shape serializations (E10 raw). Method only. */
  statementShapes: string[];
  /** Raw declared local-variable names, source order, capped at `localVarSampleMax` (E11 raw ingredient). Method only. */
  localVarNames: string[];
  /** Node type of the first body statement (E4 raw), absent when the body has no statements. Method only. */
  firstStatementType?: string;
  /** Node type of the last return statement's expression, or `'bare'` for a valueless return (E5 raw), absent when the body has no return. Method only. */
  lastReturnExprType?: string;
  /** Whether the body contains at least one return statement — E5's domain. Method only. */
  hasReturnStatement: boolean;
  /** Count of the body's own top-level statements — the domain observable several bool surfaces need ("methods with ≥1 body statement"). Method only (0 for `type`/`file`). */
  bodyStatementCount: number;
}

/**
 * A scope after phase 2 (partitioning, `partitions.ts`) and phase 3
 * (`finalizeUnits`, this file): every `RawScope` field, plus the FINAL
 * partition-dependent identity fields. `module` joins the kind union here —
 * module scopes are SYNTHESIZED by `finalizeUnits`, never produced by
 * `extractUnits` (spec §6.3's module rule is partition-dependent, so it
 * cannot be evaluated until phase 2 has run — see this file's header).
 */
export interface ScopeUnit extends Omit<RawScope, 'kind'> {
  kind: ScopeKind | 'module';
  /** The FINAL (post 300-scope-floor, post `_repo`-merge) partition id this scope belongs to (spec §6.8). */
  partitionId: string;
  /** The prototype's scope-identity key, production-shaped: `relPath#kind#qualifiedName` (the ordinal already lives inside `qualifiedName` — see that field's own doc). Mirrors `prototype-roots2.mjs:121`'s `skeyR`. */
  skeyR: string;
  /** Spec §6.4's production stable identity: `sha256hex(partitionId ∥ relPath ∥ kind ∥ qualifiedName ∥ arity)[:16]`. */
  stableId: string;
}

/** Grammar-generic import-target text extraction: prefers a string literal descendant, falls back to an identifier-shaped named child. Mirrors `prototype-roots2.mjs:75-77`. */
function importTargetText(importNode: SyntaxNode): string | undefined {
  const stringDescendants = importNode.descendantsOfType(['string', 'string_literal']);
  if (stringDescendants.length > 0) {
    return stringDescendants[0].text.replace(/^["'`]|["'`]$/g, '');
  }
  const identifierChild = importNode.namedChildren.find((c) => IMPORT_TARGET_IDENTIFIER_RE.test(c.type));
  return identifierChild?.text;
}

/** Spec §6.2's heritage rule: identifiers found under a scope's own named children (excluding `body`) whose type matches `heritagePattern`. Mirrors `prototype-roots2.mjs:83-84`. */
function deriveHeritage(
  scopeNode: SyntaxNode,
  bodyNode: SyntaxNode | null,
  heritageRe: RegExp,
): { supertypes: string[]; grammarHasHeritageCandidacy: boolean } {
  const supertypes: string[] = [];
  let sawHeritageShapedChild = false;
  const superclassesField = scopeNode.childForFieldName('superclasses');
  if (superclassesField) {
    for (const id of [
      ...superclassesField.descendantsOfType('identifier'),
      ...superclassesField.descendantsOfType('attribute'),
    ]) {
      supertypes.push(id.text);
    }
  }
  for (const child of scopeNode.namedChildren) {
    if (child === bodyNode) continue;
    if (heritageRe.test(child.type)) {
      sawHeritageShapedChild = true;
      for (const id of [
        ...child.descendantsOfType('identifier'),
        ...child.descendantsOfType('type_identifier'),
        ...child.descendantsOfType('scoped_type_identifier'),
      ]) {
        supertypes.push(id.text);
      }
    }
  }
  return { supertypes: [...new Set(supertypes)], grammarHasHeritageCandidacy: sawHeritageShapedChild };
}

/**
 * Spec §6.2's decoration attribution window, applied to a scope node: finds
 * every marker-passing, window-eligible decoration candidate among the
 * scope's PARENT's descendants (never just its immediate siblings — a decorator
 * stack's own internal shape can nest, spec's "any height" clause) and
 * attributes it if it falls in `(loRow, bodyRow]` (`isWithinDecorationWindow`,
 * `binding.ts`). Mirrors `prototype-roots2.mjs:87-91`.
 */
function deriveDecorations(
  scopeNode: SyntaxNode,
  bodyNode: SyntaxNode | null,
  decoratorTypes: string[],
): string[] {
  const decos: string[] = [];
  const parent = scopeNode.parent;
  if (!parent || decoratorTypes.length === 0) return decos;

  const decoTypeSet = new Set(decoratorTypes);
  let loRow = -1;
  for (const sibling of parent.namedChildren) {
    if (sibling.id === scopeNode.id) break;
    if (!decoTypeSet.has(sibling.type) && sibling.type !== 'comment') {
      loRow = Math.max(loRow, sibling.endPosition.row);
    }
  }
  const bodyRow = bodyNode ? bodyNode.startPosition.row : scopeNode.endPosition.row;

  for (const candidate of parent.descendantsOfType(decoratorTypes)) {
    if (!isWithinDecorationWindow(candidate.startPosition.row, loRow, bodyRow)) continue;
    if (!isDecorationMarkerText(candidate.text)) continue;
    const match = /@?([\w.]+)/.exec(candidate.text.trimStart());
    if (match) decos.push(match[1]);
  }
  return [...new Set(decos)];
}

/** Depth-limited statement-shape serialization: `type(child,child,child)`, children truncated to 3 (spec §7.1 E10). Mirrors `prototype-roots2.mjs:99`. */
function serializeShape(node: SyntaxNode, depth: number): string {
  if (depth <= 0) return node.type;
  const children = node.namedChildren.slice(0, 3).map((c) => serializeShape(c, depth - 1));
  return `${node.type}(${children.join(',')})`;
}

/**
 * The bounded body-feature walk (spec §6.7's extraction contract): visits
 * every descendant of `bodyNode`, never more than `BODY_VISIT_CAP` nodes
 * total. Mirrors `prototype-roots2.mjs:93-100`.
 *
 * §6.7's OWN "never descend into a nested scope" clause needs no explicit
 * guard here (REWORK F3, deleted rather than kept as unreachable dead code):
 * this function is only ever called with a non-null `bodyNode` for a
 * `method`-kind scope, and `scopeKindOf` (above) classifies a scope `method`
 * EXACTLY when its body contains ZERO scope-type descendants — the two rules
 * compose to make "a nested scope is its own instance, discovered separately
 * by the structural walk" true by construction: there is never a scope-type
 * node inside a method's own body for this walk to descend into in the first
 * place, so a conditional skip of one would be dead code (confirmed by a
 * mutation probe: flipping such a guard's condition changed no observable
 * output).
 */
function collectBodyFeatures(
  bodyNode: SyntaxNode | null,
  shapeDepth: number,
  shapeMaxStatements: number,
  localVarSampleMax: number,
) {
  const stmts = bodyNode ? bodyNode.namedChildren : [];
  const nodeTypesSeen = new Set<string>();
  const calleeTexts = new Set<string>();
  const localVarNames: string[] = [];
  const stack: SyntaxNode[] = [...stmts];
  let visited = 0;

  while (stack.length > 0 && visited < BODY_VISIT_CAP) {
    const node = stack.pop() as SyntaxNode;
    visited++;
    nodeTypesSeen.add(node.type);

    if (CALL_NODE_TYPE_RE.test(node.type)) {
      const fn = node.childForFieldName('function');
      if (fn && fn.text.length <= MAX_CALLEE_TEXT_LENGTH && !fn.text.includes('\n')) {
        calleeTexts.add(fn.text);
      }
    }
    if (
      node.type === 'variable_declarator' ||
      (node.type === 'assignment' && node.childForFieldName('left')?.type === 'identifier')
    ) {
      const nameNode = node.childForFieldName('name') ?? node.childForFieldName('left');
      if (nameNode) localVarNames.push(nameNode.text);
    }
    // REWORK F3 (mutation-surviving rule, deleted rather than kept
    // unreachable): §6.7's "never descend into a nested scope" clause is
    // ALREADY subsumed by the kind rule above (`scopeKindOf`) before this
    // function is ever called — `collectBodyFeatures` only ever runs for a
    // `method`-kind scope's body (the caller passes `bodyNode` here only
    // when `kind === 'method'`), and a scope is classified `method` EXACTLY
    // when its body contains ZERO scope-type descendants (`scopeKindOf`'s
    // own rule: `type` otherwise, precisely because it DOES contain one). A
    // `scopeTypeSet` guard here would therefore be dead code: no node
    // reachable from a method's own body can ever match `scopeTypeSet`, by
    // that construction, so the branch it would skip could never fire. The
    // reviewer's mutation probe confirmed this directly — flipping the
    // guard's condition changed no test outcome, because nothing ever took
    // the skipped branch. `scopeTypeSet` stays a real parameter (still used
    // by `scopeKindOf`'s own caller) even though this function no longer
    // reads it itself.
    for (const child of node.namedChildren) stack.push(child);
  }

  const statementShapes = new Set<string>();
  for (const stmt of stmts.slice(0, shapeMaxStatements)) {
    statementShapes.add(serializeShape(stmt, shapeDepth));
  }
  const returnStatements = stmts.filter((s) => RETURN_NODE_TYPE_RE.test(s.type));
  const lastReturn = returnStatements.length > 0 ? returnStatements[returnStatements.length - 1] : undefined;

  return {
    nodeTypesSeen: [...nodeTypesSeen],
    calleeTexts: [...calleeTexts],
    localVarNames: localVarNames.slice(0, localVarSampleMax),
    statementShapes: [...statementShapes],
    firstStatementType: stmts.length >= 1 ? stmts[0].type : undefined,
    lastReturnExprType: lastReturn ? (lastReturn.namedChildren[0]?.type ?? 'bare') : undefined,
    hasReturnStatement: returnStatements.length > 0,
    bodyStatementCount: stmts.length,
  };
}

/**
 * Spec §6.2's scope-kind rule: `type` when the scope's own body subtree
 * contains at least one further scope node, `method` otherwise —
 * container/leaf, derived from `binding.scope` membership, never a keyword
 * list (`binding.ts`'s `RootsBinding.scope` doc: "the rule is carried BY this
 * binding" — this is where it is applied).
 */
function scopeKindOf(bodyNode: SyntaxNode | null, scopeTypes: string[]): ScopeKind {
  if (!bodyNode) return 'method';
  return bodyNode.descendantsOfType(scopeTypes).length > 0 ? 'type' : 'method';
}

/**
 * Extracts every scope from one already-parsed file: `extractUnits`'s own
 * structural walk (finds scope/import nodes anywhere in the tree, recursing
 * into a discovered scope's body to find NESTED scopes as separate
 * instances), building each `RawScope` via the per-scope helpers above, then
 * appending the one `file` scope (spec §6.3: exactly one per file) and
 * assigning occurrence ordinals in the same pass (spec §6.4: "ordinals
 * computed DURING extraction").
 *
 * §6.1's error tolerance is applied at the ERRONEOUS NODE ITSELF, never at an
 * ancestor merely containing one (see the walk's own inline comment below for
 * why `isError`/`isMissing`, not `hasError`, is the guard): a node whose OWN
 * type is tree-sitter's synthetic `ERROR`, or which the parser's error
 * recovery inserted as `MISSING`, is skipped — neither extracted as a scope
 * nor descended into — while every clean sibling and every clean subtree
 * nested inside a broken ancestor is still discovered, matching spec's
 * "error-free subtrees only" literally (`v6-spec.md:222`). A totally garbled
 * file (whose root's only child is itself an `ERROR` node, or where every
 * top-level child is) therefore degrades naturally to the file scope alone,
 * with zero method/type scopes discovered — the same outcome the spec names
 * as "root error ⇒ file granularity," reached here without a separate
 * special-cased branch: the file scope is ALWAYS appended regardless of how
 * many (if any) named-body scopes the walk found.
 */
export function extractUnits(relPath: string, source: string, tree: Tree, binding: RootsBinding, options: ExtractOptions = {}): RawScope[] {
  const shapeDepth = options.shapeDepth ?? DEFAULT_SHAPE_DEPTH;
  const shapeMaxStatements = options.shapeMaxStatements ?? DEFAULT_SHAPE_MAX_STATEMENTS;
  const localVarSampleMax = options.localVarSampleMax ?? DEFAULT_LOCAL_VAR_SAMPLE_MAX;

  const scopeTypeSet = new Set(binding.scope);
  const importTypeSet = new Set(binding.imports);
  const heritageRe = new RegExp(binding.heritagePattern);
  const grammarHasDecoratorTypes = binding.decorators.length > 0;

  const rawScopes: RawScope[] = [];
  const fileImportsRaw: string[] = [];

  const walk = (node: SyntaxNode): void => {
    for (const child of node.namedChildren) {
      // §6.1's "error-free subtrees only" is enforced at the ERRONEOUS NODE
      // ITSELF, never at an ancestor merely CONTAINING one: `isError` (this
      // node's own type is tree-sitter's synthetic `ERROR`) and `isMissing`
      // (a token the parser's error recovery inserted, never real source)
      // both mean "this specific node is not real code," so it is skipped —
      // neither extracted as a scope nor descended into. `hasError` (true
      // for this node OR ANY descendant) is deliberately NOT the guard here:
      // a class containing one malformed method has `hasError = true` on the
      // class node itself, propagated up from that one broken descendant: an
      // `hasError`-gated skip would prune the ENTIRE class — every sibling
      // method along with the broken one — which is exactly backwards from
      // "error-free SUBTREES only" (spec `v6-spec.md:222`): a clean sibling
      // subtree nested inside a broken ancestor is still error-free on its
      // own terms and must be recovered. Skipping only `isError`/`isMissing`
      // nodes lets the walk descend PAST a contaminated ancestor and keep
      // discovering every clean scope underneath; only the literal ERROR/
      // MISSING region itself is ever excluded.
      if (child.isError || child.isMissing) continue;

      if (importTypeSet.has(child.type)) {
        const target = importTargetText(child);
        if (target) fileImportsRaw.push(target);
        // Spec §6.2's import-node-type regex intentionally matches BOTH a
        // whole import statement AND its own internal fragments (e.g.
        // TypeScript's `import_specifier`, `named_imports`, `import_clause`
        // all contain "import" too) — real, verified against this grammar's
        // own node-types.json, not a hypothetical. Once we have extracted
        // ONE target from this node, its children are internal structure of
        // the SAME logical import, never a second one: stop here rather than
        // falling through to the scope/non-scope walk below, which would
        // otherwise independently re-match a nested fragment (e.g. an
        // `import_specifier`'s own name falling back to the identifier
        // fallback in `importTargetText`) as a spurious second import.
        if (!scopeTypeSet.has(child.type)) continue;
      }

      if (scopeTypeSet.has(child.type)) {
        const nameField = child.childForFieldName('name');
        const name = nameField?.text ?? '<anon>';
        const bodyNode = child.childForFieldName('body');
        const kind = scopeKindOf(bodyNode, binding.scope);
        const { supertypes, grammarHasHeritageCandidacy } = deriveHeritage(child, bodyNode, heritageRe);
        const decorators = deriveDecorations(child, bodyNode, binding.decorators);
        const paramsField = child.childForFieldName('parameters');
        const body = collectBodyFeatures(kind === 'method' ? bodyNode : null, shapeDepth, shapeMaxStatements, localVarSampleMax);

        rawScopes.push({
          kind,
          relPath,
          name,
          qualifiedName: name, // ordinal folded in below, once every scope's occurrence index is known
          ordinal: 0,
          arity: kind === 'method' ? (paramsField?.namedChildren.length ?? 0) : 0,
          hasParameterList: paramsField !== null,
          startRow: child.startPosition.row,
          supertypes,
          decorators,
          grammarHasDecoratorTypes,
          grammarHasHeritageCandidacy,
          grammarNodeTypeVocabulary: binding.nodeTypeVocabulary,
          fileImports: fileImportsRaw, // shared reference; finalized (deduped) once the whole file is walked
          calleeTexts: kind === 'method' ? body.calleeTexts : [],
          nodeTypesSeen: kind === 'method' ? body.nodeTypesSeen : [],
          statementShapes: kind === 'method' ? body.statementShapes : [],
          localVarNames: kind === 'method' ? body.localVarNames : [],
          firstStatementType: kind === 'method' ? body.firstStatementType : undefined,
          lastReturnExprType: kind === 'method' ? body.lastReturnExprType : undefined,
          hasReturnStatement: kind === 'method' ? body.hasReturnStatement : false,
          bodyStatementCount: kind === 'method' ? body.bodyStatementCount : 0,
        });
        // Recurse into the scope's own body (or itself, if bodyless) to find
        // NESTED scopes as their own instances — this is the STRUCTURAL walk,
        // distinct from collectBodyFeatures' bounded, non-descending one above.
        walk(bodyNode ?? child);
      } else {
        walk(child);
      }
    }
  };

  walk(tree.rootNode);

  // De-duplicate the file's import list once, in first-seen order, and freeze
  // it onto every scope extracted from this file (all currently share the
  // same array reference from the walk above; replace with the final,
  // deduped array so every consumer of `fileImports` sees the same value).
  const dedupedImports = [...new Set(fileImportsRaw)];
  for (const scope of rawScopes) scope.fileImports = dedupedImports;

  // Occurrence ordinals, assigned in walk (push) order — a depth-first
  // pre-order traversal, which visits sibling scopes in source order and a
  // parent before its own nested children, matching spec §6.4's "occurrence
  // index ... in source order" for every (kind, name) pair. Computed here,
  // during extraction, per §6.4's own requirement — never post-hoc.
  const occurrence = new Map<string, number>();
  for (const scope of rawScopes) {
    const key = `${scope.kind} ${scope.name}`;
    const ordinal = occurrence.get(key) ?? 0;
    occurrence.set(key, ordinal + 1);
    scope.ordinal = ordinal;
    // A DELIBERATE divergence from the prototype's own `skeyR` convention
    // (`prototype-roots2.mjs:121`: `name + (ord ? '#'+ord : '')`, elided at
    // ordinal 0 UNIFORMLY for every scope, named or anonymous), stated once
    // here since it is easy to miss reading this line against that file.
    // Spec §6.4's OWN literal text (`v6-spec.md:245`) states two DIFFERENT
    // rules, not one: "Overloads beyond arity: `#k` by source order.
    // Anonymous: `<anon>` + ordinal" — the overload rule is elided at k = 0
    // (no qualifier text says otherwise, and §6.4's own binding note calls
    // elision "so single-occurrence keys stay readable"), but the anonymous
    // rule is stated flatly as "`<anon>` + ordinal" with no elision clause at
    // all, which is why `<anon>0` (not bare `<anon>`) is qualifiedName's
    // first anonymous occurrence in every file — production's text overrides
    // the prototype's uniform convention specifically for the anonymous case.
    scope.qualifiedName = scope.name === '<anon>' ? `<anon>${ordinal}` : ordinal > 0 ? `${scope.name}#${ordinal}` : scope.name;
  }

  // The one FILE scope (spec §6.3: exactly one per file), appended after
  // every named-body scope so its ordinal (always 0 — one `file` scope per
  // relPath by construction) never collides with a same-named method/type.
  rawScopes.push({
    kind: 'file',
    relPath,
    name: basenameOf(relPath),
    qualifiedName: basenameOf(relPath),
    ordinal: 0,
    arity: 0,
    hasParameterList: false,
    startRow: 0,
    supertypes: [],
    decorators: [],
    grammarHasDecoratorTypes,
    grammarHasHeritageCandidacy: false,
    grammarNodeTypeVocabulary: binding.nodeTypeVocabulary,
    fileImports: dedupedImports,
    calleeTexts: [],
    nodeTypesSeen: [],
    statementShapes: [],
    localVarNames: [],
    firstStatementType: undefined,
    lastReturnExprType: undefined,
    hasReturnStatement: false,
    bodyStatementCount: 0,
  });

  // `source` is genuinely unused: every observable this phase collects reads
  // off the parsed `tree` (text spans via each node's own `.text`, never by
  // slicing `source` ourselves, so no byte-offset arithmetic here can drift
  // from the tree's). It stays a real parameter anyway — not folded away or
  // made optional — because it is part of this function's stable, documented
  // public signature (the plan's dictated shape: `extractUnits(relPath,
  // source, tree, binding)`) and every caller already holds it having just
  // parsed `tree` FROM it, so accepting it costs nothing at call sites while
  // keeping the signature self-describing ("a file's source, already
  // parsed") without forcing a caller to pass `tree` alone and lose that
  // context. `void source` documents the deliberate non-use rather than
  // leaving an unexplained unused-parameter lint suppression.
  void source;

  return rawScopes;
}

/**
 * The prototype's scope-identity key, production-shaped (spec §6.4's ordinal
 * already folded into `qualifiedName`). Mirrors `prototype-roots2.mjs:121`
 * STRUCTURALLY (`rel#kind#name[#ord]`), but NOT byte-for-byte for an
 * anonymous scope's first occurrence: the prototype elides `#0` uniformly
 * (`s.ord ? '#'+s.ord : ''`, true for every scope including `<anon>`), so its
 * first anonymous scope's key ends `#<anon>` with no ordinal at all, while
 * this function always reads `qualifiedName`, which — per spec `v6-spec.md:245`'s
 * own literal "Anonymous: `<anon>` + ordinal" (no elision clause) — already
 * carries `<anon>0` for that same first occurrence (see the `qualifiedName`
 * assignment above for the full divergence rationale). Stated once here
 * because this is the one place the divergence is visible byte-for-byte
 * against the prototype's own key format.
 */
function skeyROf(relPath: string, kind: string, qualifiedName: string): string {
  return `${relPath}#${kind}#${qualifiedName}`;
}

/**
 * Spec §6.4's production stable identity. The five folded fields are joined
 * with a single space character, DELIBERATELY, not naive concatenation: a
 * delimiter is what keeps `relPath="a"` + `kind="bmethod"` from hashing
 * identically to `relPath="ab"` + `kind="method"` (concatenation alone is
 * ambiguous at field boundaries; a shared separator is not). Space is safe
 * here specifically because none of the five fields can realistically
 * contain one: `relPath` is a POSIX repo-relative path (no grammar-registered
 * source file has a space in its own relPath in this product's file-walk
 * conventions), `kind` is one of the fixed words `method`/`type`/`file`/
 * `module`, `qualifiedName` is an identifier (or `<anon>`) plus an optional
 * `#`-prefixed ordinal — none of which tree-sitter ever tokenizes with an
 * embedded space — and `arity` is `String(number)`. A future field whose
 * alphabet could plausibly include a space would need a different delimiter
 * or explicit escaping; none of today's five do.
 */
function stableIdOf(partitionId: string, relPath: string, kind: string, qualifiedName: string, arity: number): string {
  return hashString(`${partitionId} ${relPath} ${kind} ${qualifiedName} ${arity}`).slice(0, 16);
}

/** Spec §6.3's fixed "≥ 3 code files" module threshold — also `enumerate.ts`'s E12 domain test (a resolved module directory with fewer than this many DIRECT code files is not "a directory with ≥ 3 code files," even when it exists as someone's partition-root fallback target). */
export const MIN_MODULE_CODE_FILES = 3;

/**
 * Synthesizes one `module`-kind `ScopeUnit` per resolved module directory
 * (spec §6.3's partition-dependent rule: "nearest of partition root or first
 * directory with ≥ 3 code files"), and re-emits every non-module `RawScope`
 * as a `ScopeUnit` carrying its final `partitionId`, `skeyR`, and
 * `stableId`.
 *
 * MODULE RESOLUTION, per file: walk from the file's own containing directory
 * UP toward its (final) partition's module-root directory (inclusive at both
 * ends), and take the NEAREST directory that either IS the module-root or has
 * `MIN_MODULE_CODE_FILES` (3) code files DIRECTLY inside it (spec §6.3
 * `v6-spec.md:242`; "code files" = files that produced a `file`-kind raw
 * scope at all — extraction only ever sees registered-grammar files, so this
 * COUNTS registered data-grammar files (json/yaml/toml) toward the ≥3 rule, a
 * stated decision: design §5.4 gives data grammars module-level (E12)
 * surfaces, which requires they be countable as module members in the first
 * place).
 *
 * "Module root" is the file's PRE-merge partition-root directory — EXCEPT for
 * a file whose partition merged into `_repo` (spec §6.8's 300-scope floor),
 * where the module-root arm of the nearest-of rule is the REPO ROOT
 * (`''`) instead: a merged partition has no directory of its own to serve as
 * that arm, and the repo root is the only ancestor every one of its member
 * files still shares. `PartitionMap.moduleRootDirOfFile` already encodes this
 * substitution (`partitions.ts` computes it) — this function only walks it.
 *
 * DROPPED SCOPES ARE EXCLUDED ENTIRELY (spec §6.8's 300-floor, `partitions.ts`'s
 * own contract): a raw scope whose file has no entry in
 * `partitions.partitionOfFile` belongs to a partition that was merged into an
 * under-floor `_repo` and DROPPED — never mined, exactly like the prototype's
 * own `bucket.length < 300` case (`prototype-roots2.mjs:432`'s merge loop,
 * which never adds a still-under-floor bucket to `merged` at all). Such a
 * scope produces NO `ScopeUnit` here — not even with a fallback `'_repo'`
 * partitionId — because emitting one would silently mine a scope the
 * partitioning layer decided was silent. (An EARLIER version of this function
 * defaulted a missing partitionId to `'_repo'` on the theory that "identity
 * minting must never fail"; that theory conflated the wholesale-silent case
 * (spec's J4, where `_repo` genuinely still stands as an assigned id for
 * every file) with the per-bucket-dropped case this comment now documents,
 * where `_repo` is not even reached.)
 */
export function finalizeUnits(rawScopes: RawScope[], partitions: PartitionMap): ScopeUnit[] {
  // Scopes whose file was DROPPED (see this function's own header) never
  // reach any stage below — not the module-resolution file count, not the
  // ScopeUnit emission loop. Filtering once, up front, keeps both loops
  // simple and keeps a dropped file from ever counting toward a resolved
  // module's own ≥3-files population.
  const survivingRawScopes = rawScopes.filter((scope) => partitions.partitionOfFile.has(scope.relPath));

  // Direct (non-recursive) code-file count per directory, and the set of
  // relPaths of those files — used both for the ≥3-files module-resolution
  // test and, later, to compute each resolved module's own moddirshape/
  // modfileshape/modsize population (`enumerate.ts` reads `ScopeUnit.relPath`
  // for `module`-kind units it did not itself create the population of, so
  // this function records that population implicitly via which FILE units'
  // moduleOfFile point at a given module directory).
  const directFileCountByDir = new Map<string, number>();
  for (const scope of survivingRawScopes) {
    if (scope.kind !== 'file') continue;
    const dir = dirnameOf(scope.relPath);
    directFileCountByDir.set(dir, (directFileCountByDir.get(dir) ?? 0) + 1);
  }

  const resolvedModuleDirCache = new Map<string, string | undefined>();
  const resolveModuleDir = (fileDir: string, moduleRootDir: string): string | undefined => {
    const cacheKey = `${moduleRootDir} ${fileDir}`;
    if (resolvedModuleDirCache.has(cacheKey)) return resolvedModuleDirCache.get(cacheKey);

    let dir = fileDir;
    for (;;) {
      if (dir === moduleRootDir) {
        resolvedModuleDirCache.set(cacheKey, dir);
        return dir;
      }
      if ((directFileCountByDir.get(dir) ?? 0) >= MIN_MODULE_CODE_FILES) {
        resolvedModuleDirCache.set(cacheKey, dir);
        return dir;
      }
      const parent = dirnameOf(dir);
      if (parent === dir) {
        // No further progress possible (only reachable at `dir === ''`,
        // `dirnameOf('') === ''`) without having matched `moduleRootDir`
        // above — can only happen if `moduleRootDir` itself is unreachable
        // upward from `fileDir`, which `derivePartitions` never produces
        // (`moduleRootDir` is always an ancestor of every file it governs,
        // and every ancestor chain terminates at `''`). Fail safe to the
        // current directory rather than throwing: a file otherwise fully
        // extracted must never lose its module-nearest-of outcome to an
        // internal inconsistency here.
        resolvedModuleDirCache.set(cacheKey, dir);
        return dir;
      }
      dir = parent;
    }
  };

  const units: ScopeUnit[] = [];
  const moduleUnitByDir = new Map<string, ScopeUnit>();

  for (const raw of survivingRawScopes) {
    // Always defined here: `survivingRawScopes` was filtered to exactly the
    // relPaths `partitionOfFile` has an entry for (see this function's
    // header) — the `as string` documents that guarantee rather than
    // re-deriving a fallback the filter has already made unreachable.
    const partitionId = partitions.partitionOfFile.get(raw.relPath) as string;
    const stableId = stableIdOf(partitionId, raw.relPath, raw.kind, raw.qualifiedName, raw.arity);
    units.push({
      ...raw,
      partitionId,
      skeyR: skeyROf(raw.relPath, raw.kind, raw.qualifiedName),
      stableId,
    });

    if (raw.kind === 'file') {
      const moduleRootDir = partitions.moduleRootDirOfFile.get(raw.relPath) ?? '';
      const moduleDir = resolveModuleDir(dirnameOf(raw.relPath), moduleRootDir);
      if (moduleDir !== undefined && !moduleUnitByDir.has(moduleDir)) {
        const moduleQualifiedName = moduleDir === '' ? '.' : (moduleDir.split('/').pop() ?? moduleDir);
        moduleUnitByDir.set(moduleDir, {
          kind: 'module',
          relPath: moduleDir,
          name: moduleQualifiedName,
          qualifiedName: moduleQualifiedName,
          ordinal: 0,
          arity: 0,
          hasParameterList: false,
          startRow: 0,
          supertypes: [],
          decorators: [],
          grammarHasDecoratorTypes: false,
          grammarHasHeritageCandidacy: false,
          grammarNodeTypeVocabulary: [], // a synthesized `module` scope has no grammar of its own — E3 never applies to module-kind units
          fileImports: [],
          calleeTexts: [],
          nodeTypesSeen: [],
          statementShapes: [],
          localVarNames: [],
          firstStatementType: undefined,
          lastReturnExprType: undefined,
          hasReturnStatement: false,
          bodyStatementCount: 0,
          partitionId,
          skeyR: skeyROf(moduleDir, 'module', moduleQualifiedName),
          stableId: stableIdOf(partitionId, moduleDir, 'module', moduleQualifiedName, 0),
        });
      }
    }
  }

  units.push(...moduleUnitByDir.values());
  return units;
}

/**
 * POSIX relPath directory name, with the repo root as `''` (not `'.'` — unlike
 * `node:path`'s `dirname`, which returns `'.'` for a root-level path; every
 * roots module treats `''` as the repo-root directory sentinel, so this
 * shared helper is exported for `partitions.ts`/`enumerate.ts` to reuse rather
 * than each re-deriving the same one-line rule with a different sentinel by
 * accident).
 */
export function dirnameOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

/** POSIX relPath basename (the final `/`-separated segment). */
export function basenameOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}
