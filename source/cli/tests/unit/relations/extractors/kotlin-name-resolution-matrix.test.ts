import { describe, it, expect } from 'vitest';
import { runCase } from '../reference-case-runner.js';
import { kotlinExtractor } from '../../../../src/relations/extractors/kotlin.js';
import { SymbolTable } from '../../../../src/relations/symbol-table.js';
import { makeResolver } from '../../../../src/relations/resolver.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { withParsedFile } from '../../../../src/ast/parser.js';

/**
 * KOTLIN NAME-RESOLUTION IDENTIFICATION MATRIX — one runCase-backed test per
 * identification case. Every case is backed by a reference-catalogue doc
 * (reference/relations/kotlin/<id>.md): the embedded fixture code + the documented
 * `## Expect` outcome are the single source of truth, asserted end-to-end through the
 * REAL relation pass (extractor + resolver) by runCase. The two relations aspects
 * (reference/relations/case-has-test + case-is-tested) enforce the 1:1 catalogue↔test
 * correspondence, so this file cannot drift from the catalogue.
 *
 * THE GOVERNING DECISION (.plans/2026-06-14-import-only-languages-decision.md): the Kotlin
 * extractor is and STAYS IMPORT-ONLY. A dependency edge is established ONLY by an `import`,
 * whose operand is a fully-qualified symbol resolved through the shared SymbolTable. Adding
 * usage-site / same-package / wildcard-expansion / bare-simple-name resolution is FORBIDDEN —
 * it would reintroduce the precedence trap (explicit-import > same-package > star > stdlib) and
 * the stdlib-collision trap (a project `Result`/`Pair`/`List` colliding with an invisible
 * stdlib name). The cardinal invariant — ZERO false positives, a hard wall with no adopter
 * waiver — outranks recall; a missed edge is a tolerated false-NEGATIVE.
 *
 * The catalogue covers the full research enumeration (.plans/2026-06-15-kotlin-name-resolution-
 * research.md): import forms (A1/A3/A4/A5/A6/A7/A8/A9), implicit stdlib (B1), nested/JVM
 * keying (C1/C2), every usage-site recall gap (D1–D18), and the newer 2.0→2.4 forms
 * (E5 context parameters, E6 context-sensitive resolution, E7 nested type aliases, E8
 * use-site-target keywords). Each case asserts the SPEC-CORRECT, zero-FP outcome (an edge to
 * the right node, or silence); for every resolving form the same-name FP-trap variant sits in
 * the case's `## Files` + `## Expect`.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — import forms that resolve (FQN edge; binds the EXACT FQN, never a sibling same-name)', () => {
  it('kotlin-plain-import-fqn-edge', () => runCase('kotlin-plain-import-fqn-edge'));
  it('kotlin-plain-import-sibling-same-name-trap', () => runCase('kotlin-plain-import-sibling-same-name-trap'));
  it('kotlin-multi-import-one-edge-each', () => runCase('kotlin-multi-import-one-edge-each'));
  it('kotlin-package-header-keying-edge', () => runCase('kotlin-package-header-keying-edge'));
  it('kotlin-root-package-bare-keys-edge', () => runCase('kotlin-root-package-bare-keys-edge'));
  it('kotlin-top-level-fun-import-exact-fqn', () => runCase('kotlin-top-level-fun-import-exact-fqn'));
  it('kotlin-top-level-fun-sibling-same-name-trap', () => runCase('kotlin-top-level-fun-sibling-same-name-trap'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — alias import (`import a.b.C as D`): target is the FQN before `as`; `D` is never a key)', () => {
  it('kotlin-alias-import-fqn-before-as', () => runCase('kotlin-alias-import-fqn-before-as'));
  it('kotlin-alias-import-name-not-a-target', () => runCase('kotlin-alias-import-name-not-a-target'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — enum / companion / object member imports (resolve at the declared-TYPE boundary, else SILENCE)', () => {
  it('kotlin-enum-member-import-verbatim-silence', () => runCase('kotlin-enum-member-import-verbatim-silence'));
  it('kotlin-enum-entry-import-not-indexed-silence', () => runCase('kotlin-enum-entry-import-not-indexed-silence'));
  it('kotlin-member-chain-not-subpackage-silence', () => runCase('kotlin-member-chain-not-subpackage-silence'));
  it('kotlin-companion-member-import-plus-split', () => runCase('kotlin-companion-member-import-plus-split'));
  it('kotlin-object-member-import-plus-split', () => runCase('kotlin-object-member-import-plus-split'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — wildcard import (`import a.b.*`): emits the PACKAGE hint → SILENCE (expansion FORBIDDEN)', () => {
  it('kotlin-wildcard-import-package-hint-silence', () => runCase('kotlin-wildcard-import-package-hint-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — default / implicit stdlib (Form 3): unimported names → SILENCE (the collision trap)', () => {
  it('kotlin-implicit-stdlib-no-import-silence', () => runCase('kotlin-implicit-stdlib-no-import-silence'));
  it('kotlin-stdlib-collision-project-result-silence', () => runCase('kotlin-stdlib-collision-project-result-silence'));
  it('kotlin-explicit-stdlib-import-absent-silence', () => runCase('kotlin-explicit-stdlib-import-absent-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — nested / inner types (Form 4): split at a declared-TYPE boundary, NEVER deeper packages', () => {
  it('kotlin-nested-flat-key-fp-sealed', () => runCase('kotlin-nested-flat-key-fp-sealed'));
  it('kotlin-nested-import-plus-split-edge', () => runCase('kotlin-nested-import-plus-split-edge'));
  it('kotlin-deep-nested-import-plus-split-edge', () => runCase('kotlin-deep-nested-import-plus-split-edge'));
  it('kotlin-nested-vs-subpackage-ambiguous-silence', () => runCase('kotlin-nested-vs-subpackage-ambiguous-silence'));
  it('kotlin-nested-plus-key-not-dollar-edge', () => runCase('kotlin-nested-plus-key-not-dollar-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
// INLINE FULLY-QUALIFIED TYPE references (no import). A multi-segment user_type written
// inline in a TYPE position — parameter/return/property type, supertype list, is/as type,
// generic argument, type-alias RHS, extension-receiver type, annotation class — is
// SHADOW-FREE: a fully-qualified name has exactly one meaning, so it resolves through the
// shared SymbolTable EXACTLY like an import and produces a real cross-node edge. Each case
// puts the referenced type IN-GRAPH and asserts the edge to its node.
describe('MATRIX — inline fully-qualified TYPE reference (no import): the FQN is shadow-free → real edge', () => {
  it('kotlin-supertype-list-edge', () => runCase('kotlin-supertype-list-edge'));
  it('kotlin-generic-argument-where-edge', () => runCase('kotlin-generic-argument-where-edge'));
  it('kotlin-is-as-test-cast-edge', () => runCase('kotlin-is-as-test-cast-edge'));
  it('kotlin-param-return-property-edge', () => runCase('kotlin-param-return-property-edge'));
  it('kotlin-annotation-use-edge', () => runCase('kotlin-annotation-use-edge'));
  it('kotlin-annotation-use-site-target-edge', () => runCase('kotlin-annotation-use-site-target-edge'));
  it('kotlin-context-sensitive-resolution-edge', () => runCase('kotlin-context-sensitive-resolution-edge'));
  it('kotlin-typealias-rhs-edge', () => runCase('kotlin-typealias-rhs-edge'));
  it('kotlin-extension-receiver-edge', () => runCase('kotlin-extension-receiver-edge'));
  it('kotlin-delegation-by-edge', () => runCase('kotlin-delegation-by-edge'));
  it('kotlin-when-subject-smartcast-edge', () => runCase('kotlin-when-subject-smartcast-edge'));
  it('kotlin-pair-to-tuple-edge', () => runCase('kotlin-pair-to-tuple-edge'));
  it('kotlin-nullable-array-vararg-edge', () => runCase('kotlin-nullable-array-vararg-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESSION-POSITION / grammar-limited SILENCES (deliberate tolerated false-NEGATIVE:
// SILENT, not a bug). The inline-FQN edge above fires ONLY in TYPE position. A reference in
// EXPRESSION position — a constructor call `com.x.Y()`, a `::class` literal, a `::member`
// callable reference — parses as a navigation_expression / member-access chain that is
// syntactically indistinguishable from `localVariable.field.method`, so binding it could pick
// the wrong target; it is DELIBERATELY left silent (zero-FP boundary). Context-parameter types
// stay silent because the shipped tree-sitter-kotlin grammar predates Kotlin 2.2 context
// parameters (the `context(...)` clause parses as an ERROR node → invisible to a source-only
// tool → tolerated recall gap). The bare top-level call documents the same expression-position
// silence: only its IMPORT is the edge, the bare call adds nothing.
describe('MATRIX — expression-position / grammar-limited silences (deliberate tolerated false-NEGATIVE: SILENT, not a bug)', () => {
  it('kotlin-class-literal-callable-ref-usage-silence', () => runCase('kotlin-class-literal-callable-ref-usage-silence'));
  it('kotlin-constructor-call-usage-silence', () => runCase('kotlin-constructor-call-usage-silence'));
  it('kotlin-fully-qualified-inline-ref-usage-silence', () => runCase('kotlin-fully-qualified-inline-ref-usage-silence'));
  it('kotlin-context-parameter-type-silent', () => runCase('kotlin-context-parameter-type-silent'));
  it('kotlin-bare-top-level-call-only-import-edge', () => runCase('kotlin-bare-top-level-call-only-import-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — JVM artifacts (Form 8): no `<File>Kt` facade / `@file:JvmName` key for Kotlin resolution', () => {
  it('kotlin-jvmname-no-facade-key-edge', () => runCase('kotlin-jvmname-no-facade-key-edge'));
  it('kotlin-multiple-top-level-decls-one-key-each', () => runCase('kotlin-multiple-top-level-decls-one-key-each'));
});

// ─────────────────────────────────────────────────────────────────────────────
// NEWER-VERSION forms (Kotlin 2.0→2.4) the 2026-06-15 research audit found MISSING. The
// context-parameter type is a grammar-limited SILENCE (it lives in the expression-position /
// grammar-limited block above). The context-sensitive-resolution and use-site-target cases
// now EDGE on their inline fully-qualified TYPE reference (they live in the inline-FQN block
// above). What remains here is the nested type alias — a declaration-keying EDGE the existing
// enclosing-type-chain logic already handles (pinned here).
describe('MATRIX — newer forms (Kotlin 2.0→2.4): nested type alias declaration-keying edge', () => {
  it('kotlin-nested-type-alias-plus-keyed', () => runCase('kotlin-nested-type-alias-plus-keyed'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — ambiguity collapses to SILENCE (never an arbitrary edge)', () => {
  it('kotlin-same-fqn-two-files-ambiguous-silence', () => runCase('kotlin-same-fqn-two-files-ambiguous-silence'));

  // Resolver-level case that the runCase harness cannot express: the harness maps EVERY
  // embedded file to its parent-directory node, so a declared-but-UNMAPPED in-graph file
  // (ownerOf → undefined → `absent`) is unreachable here. The form — "a resolved FQN whose
  // file has no owning node is a coverage matter, never a relation violation → absent →
  // silence" — is verified generically at the resolver level (resolver.test.ts: "a UNIQUE but
  // UNMAPPED definition is `absent`"). Kept as a direct extractor+resolver assertion (no
  // catalogue .md) so the Kotlin-specific path is still pinned and nothing is dropped.
  it('UNMAPPED in-graph file → absent (coverage matter, never a violation; not expressible in runCase)', async () => {
    ensureLoaderRegistered();
    const code = 'package com.acme\nclass Order\n';
    // The declarations are plain data — the WASM tree lives only inside this call.
    const decls = await withParsedFile('src/a/Order.kt', code, (tree) =>
      kotlinExtractor.declarations({ path: 'src/a/Order.kt', content: code, tree, language: 'kotlin' as const }),
    );
    const st = new SymbolTable();
    for (const d of decls) st.declare('kotlin', d.symbolKey, 'src/a/Order.kt');
    // ownerOf returns undefined → the mapped file has no owning node → absent (silence).
    const r = makeResolver({
      ownerIndex: { ownerOf: () => undefined } as never,
      symbolTable: st,
      resolvePathToFile: () => undefined,
    });
    expect(r.classify({ kind: 'symbol', symbolKey: 'com.acme.Order' }, 'src/c/Use.kt', 'kotlin')).toEqual({ kind: 'absent' });
  });
});
