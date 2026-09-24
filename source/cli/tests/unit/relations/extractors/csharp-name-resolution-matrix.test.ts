import { describe, it, expect } from 'vitest';
import type { Node } from 'web-tree-sitter';
import { runCase } from '../reference-case-runner.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { withParsedFile } from '../../../../src/ast/parser.js';

/**
 * C# NAME-RESOLUTION IDENTIFICATION MATRIX — one runCase-backed test per
 * identification case. Every case is now backed by a reference-catalogue doc
 * (reference/relations/csharp/<id>.md): the embedded fixture code + the documented
 * `## Expect` outcome are the single source of truth, asserted end-to-end through the
 * REAL relation pass (extractor + resolver) by runCase. The two relations aspects
 * (reference/relations/case-has-test + case-is-tested) enforce the 1:1 catalogue↔test
 * correspondence, so this file cannot drift from the catalogue.
 *
 * Each case asserts the SPEC-CORRECT outcome (an edge to the right node, or silence).
 * For resolution-bearing cases the FP-trap variant (a same-name type in ANOTHER node
 * that must NOT be chosen) is encoded in the case's `## Files` + `## Expect`.
 *
 * The spec rules (C# language spec / MS Learn) exercised by these cases:
 *  R1  unqualified leading name: walk enclosing ns innermost→outermost→global;
 *      member→type→alias→UNIQUE using-import; STOP at first hit. Nearer wins.
 *  R2  using-imported type binds ONLY when unique; 2+ same-name = CS0104 → SILENCE.
 *  R3  usings/aliases are per-file (or per block-namespace body), non-transitive.
 *  R4  `using N;` imports types of EXACTLY N, NOT its nested namespaces.
 *  R5  `global using` applies PROJECT-WIDE; aggregated before resolving simple names.
 *  R6  using-alias RHS is fully-qualified vs the bare enclosing ns; no alias chaining.
 *  R7  C#12 alias to closed generic/tuple/array → embedded named types are real deps.
 *  R8  co-definition (member I + alias I) → ambiguous → SILENCE.
 *  R9  CS0104 multi-import same-name → SILENCE (type_name AND expression contexts).
 *  R10 nearer-scope hiding: an imported name is hidden by a same-named member; the short
 *      name binds LOCAL, never a same-named top-level type in another namespace.
 *  R11 implicit/SDK usings are invisible to a source-only tool → unresolvable simple
 *      name may legitimately be SDK-imported → SILENCE.
 *  R12 `global::X` searches the global namespace; strip `global::`, resolve from root.
 *  R13 `alias::Type` / extern alias: left of `::` is ONLY an alias, never a type.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — using-import & alias forms', () => {
  it('csharp-plain-using-simple-name', () => runCase('csharp-plain-using-simple-name'));
  it('csharp-using-static-no-namespace-prefix', () => runCase('csharp-using-static-no-namespace-prefix'));
  it('csharp-using-alias', () => runCase('csharp-using-alias'));
  it('csharp-using-alias-to-namespace', () => runCase('csharp-using-alias-to-namespace'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — global usings (project-wide aggregation)', () => {
  it('csharp-global-using-same-file', () => runCase('csharp-global-using-same-file'));
  it('csharp-global-using-sibling-file', () => runCase('csharp-global-using-sibling-file'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — namespace declaration shapes & enclosing-chain resolution', () => {
  it('csharp-file-scoped-namespace-fqn', () => runCase('csharp-file-scoped-namespace-fqn'));
  it('csharp-block-namespace-nested-fqn', () => runCase('csharp-block-namespace-nested-fqn'));
  it('csharp-deep-enclosing-chain-walk', () => runCase('csharp-deep-enclosing-chain-walk'));
  it('csharp-partial-name-enclosing-ns', () => runCase('csharp-partial-name-enclosing-ns'));
  it('csharp-fully-qualified-base-list', () => runCase('csharp-fully-qualified-base-list'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — qualified-reference & nested-type keying', () => {
  it('csharp-nested-type-keying', () => runCase('csharp-nested-type-keying'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — type-reference SYNTACTIC positions (detection)', () => {
  it('csharp-base-interface-list', () => runCase('csharp-base-interface-list'));
  it('csharp-object-creation', () => runCase('csharp-object-creation'));
  it('csharp-qualified-field-type', () => runCase('csharp-qualified-field-type'));
  it('csharp-bare-member-type', () => runCase('csharp-bare-member-type'));
  it('csharp-generic-type-argument', () => runCase('csharp-generic-type-argument'));
  it('csharp-attribute-usage', () => runCase('csharp-attribute-usage'));
  it('csharp-generic-constraint', () => runCase('csharp-generic-constraint'));
  it('csharp-typeof-operand', () => runCase('csharp-typeof-operand'));
  it('csharp-is-as-cast-operand', () => runCase('csharp-is-as-cast-operand'));
  it('csharp-tuple-array-nullable-element', () => runCase('csharp-tuple-array-nullable-element'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — C#12 alias to closed generic / tuple / array', () => {
  it('csharp-alias-closed-generic', () => runCase('csharp-alias-closed-generic'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — extern alias / alias-qualified (`::`)', () => {
  it('csharp-extern-alias-no-bind', () => runCase('csharp-extern-alias-no-bind'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — SILENCE cases (must NOT bind / must silence)', () => {
  it('csharp-nearer-scope-hiding', () => runCase('csharp-nearer-scope-hiding'));
  it('csharp-sdk-simple-name-silence', () => runCase('csharp-sdk-simple-name-silence'));
  it('csharp-verbatim-fqn-ambiguous-silence', () => runCase('csharp-verbatim-fqn-ambiguous-silence'));
  it('csharp-using-subns-binds-top-level', () => runCase('csharp-using-subns-binds-top-level'));
  it('csharp-using-subns-no-misbind', () => runCase('csharp-using-subns-no-misbind'));
  it('csharp-using-import-cs0104-silence', () => runCase('csharp-using-import-cs0104-silence'));
  it('csharp-alias-member-codefinition-silence', () => runCase('csharp-alias-member-codefinition-silence'));
  it('csharp-di-reflection-extension-silence', () => runCase('csharp-di-reflection-extension-silence'));
  it('csharp-per-file-using-no-leak', () => runCase('csharp-per-file-using-no-leak'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — global:: prefix stripping', () => {
  it('csharp-global-qualifier-strip', () => runCase('csharp-global-qualifier-strip'));
});

// ─────────────────────────────────────────────────────────────────────────────
// CATALOGUE GAP-CLOSE — forms the 2026-06-15 research audit found MISSING. Each is
// added with its research example as the fixture and its EDGE/SILENCE verdict as the
// expectation; the runCase result classifies it (GREEN = already handled; a RED EDGE
// is a needs-extractor-code target removed pending Phase 2).
describe('MATRIX — gap-close (research-audited missing forms)', () => {
  it('csharp-nested-type-deep-generic', () => runCase('csharp-nested-type-deep-generic'));
  it('csharp-nameof-no-edge-silence', () => runCase('csharp-nameof-no-edge-silence'));
  it('csharp-pointer-stackalloc-element', () => runCase('csharp-pointer-stackalloc-element'));
  it('csharp-default-sizeof-operand', () => runCase('csharp-default-sizeof-operand'));
  it('csharp-primary-constructor-param-type', () => runCase('csharp-primary-constructor-param-type'));
  it('csharp-record-positional-param-type', () => runCase('csharp-record-positional-param-type'));
  it('csharp-type-pattern-binding', () => runCase('csharp-type-pattern-binding'));
  it('csharp-using-statement-not-import', () => runCase('csharp-using-statement-not-import'));
  it('csharp-target-typed-new-no-site-edge', () => runCase('csharp-target-typed-new-no-site-edge'));
  it('csharp-collection-expression-no-site-edge', () => runCase('csharp-collection-expression-no-site-edge'));
  it('csharp-extension-receiver-type', () => runCase('csharp-extension-receiver-type'));
});

// ─────────────────────────────────────────────────────────────────────────────
// EDGE-FORM LEARNING — the 2026-06-15 correctness pass: one real false positive
// (a C#11 `file`-local type leaking into the cross-file index) FIXED, and 8 edge
// forms the extractor previously missed now LEARNED. Each is a green runCase backed
// by its reference-catalogue doc; every emitted edge is a real, uniquely-bound type
// reference (zero FP), and the file-local fix is asserted as silence.
describe('MATRIX — edge-form learning (file-local FP fix + 8 learned edges)', () => {
  it('csharp-file-local-type-no-cross-file', () => runCase('csharp-file-local-type-no-cross-file'));
  it('csharp-catch-exception-type', () => runCase('csharp-catch-exception-type'));
  it('csharp-generic-attribute', () => runCase('csharp-generic-attribute'));
  it('csharp-localfn-lambda-param-type', () => runCase('csharp-localfn-lambda-param-type'));
  it('csharp-using-static-target-edge', () => runCase('csharp-using-static-target-edge'));
  it('csharp-global-using-static-target-edge', () => runCase('csharp-global-using-static-target-edge'));
  it('csharp-using-alias-colon-colon', () => runCase('csharp-using-alias-colon-colon'));
  it('csharp-alias-anytype-embedded', () => runCase('csharp-alias-anytype-embedded'));
  it('csharp-global-using-alias', () => runCase('csharp-global-using-alias'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-24 LANGUAGES & RELATIONS AUDIT — C# forms the audit found missing or wrong:
// project-scoped global usings (M6/M7), owner-node ambiguity (B4), generic base names (B5),
// member access through a type name (M16), C# 14 forms on the shipped grammar (m2), and the
// statically bound extension-method call (m27).
describe('MATRIX — project-scoped global usings (.csproj)', () => {
  it('csharp-global-using-other-project-no-leak', () => runCase('csharp-global-using-other-project-no-leak'));
  it('csharp-csproj-using-item-edge', () => runCase('csharp-csproj-using-item-edge'));
  it('csharp-global-alias-cross-project-collision-silence', () => runCase('csharp-global-alias-cross-project-collision-silence'));
  it('csharp-global-alias-per-project-edge', () => runCase('csharp-global-alias-per-project-edge'));
});

describe('MATRIX — one type declared across several files (owner-node ambiguity)', () => {
  it('csharp-partial-class-multi-file-edge', () => runCase('csharp-partial-class-multi-file-edge'));
  it('csharp-partial-class-split-across-nodes-silence', () => runCase('csharp-partial-class-split-across-nodes-silence'));
  it('csharp-generic-arity-split-files-edge', () => runCase('csharp-generic-arity-split-files-edge'));
});

describe('MATRIX — generic base names', () => {
  it('csharp-generic-base-class-edge', () => runCase('csharp-generic-base-class-edge'));
  it('csharp-generic-interface-impl-edge', () => runCase('csharp-generic-interface-impl-edge'));
  it('csharp-generic-external-container-silence', () => runCase('csharp-generic-external-container-silence'));
});

describe('MATRIX — member access through a type name', () => {
  it('csharp-static-member-access-edge', () => runCase('csharp-static-member-access-edge'));
  it('csharp-enum-member-access-edge', () => runCase('csharp-enum-member-access-edge'));
  it('csharp-local-shadows-type-name-silence', () => runCase('csharp-local-shadows-type-name-silence'));
});

/** The receiver's AST shape in an extension block: `c14` on a C# 14 grammar (a receiver_parameter
 *  under an extension_declaration), `misparse` on the shipped pre-C# 14 grammar (a parameter of a
 *  constructor named `extension`), `other` for anything else — which must fail loudly. */
async function extensionBlockShape(code: string): Promise<'c14' | 'misparse' | 'other'> {
  ensureLoaderRegistered();
  return withParsedFile('x.cs', code, (tree) => {
    let shape: 'c14' | 'misparse' | 'other' = 'other';
    const visit = (n: Node): void => {
      if (n.type === 'receiver_parameter' && n.parent?.type === 'extension_declaration') shape = 'c14';
      if (n.type === 'constructor_declaration' && n.childForFieldName('name')?.text === 'extension') {
        const params = n.childForFieldName('parameters');
        if (params?.namedChildren.some((c) => c !== null && c.type === 'parameter')) shape = 'misparse';
      }
      for (const c of n.namedChildren) if (c !== null) visit(c);
    };
    visit(tree.rootNode);
    return shape;
  });
}

describe('MATRIX — C# 14 forms on the shipped grammar', () => {
  it('csharp-extension-block-receiver-edge', async () => {
    await runCase('csharp-extension-block-receiver-edge');
    // AST-shape assertion: the edge above must come from one of the two KNOWN shapes. A grammar
    // upgrade that yields a third shape fails here instead of silently losing the edge.
    const shape = await extensionBlockShape('static class E { extension(Order order) { public int X() => 0; } }');
    expect(['c14', 'misparse']).toContain(shape);
  });
  it('csharp-null-conditional-assignment-rhs-edge', () => runCase('csharp-null-conditional-assignment-rhs-edge'));
});

describe('MATRIX — extension-method calls (bound at compile time)', () => {
  it('csharp-extension-via-owned-namespace', () => runCase('csharp-extension-via-owned-namespace'));
  it('csharp-extension-not-in-scope-silence', () => runCase('csharp-extension-not-in-scope-silence'));
});
