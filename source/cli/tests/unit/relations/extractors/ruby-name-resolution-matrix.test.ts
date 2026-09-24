import { describe, it } from 'vitest';
import { runCase } from '../reference-case-runner.js';

/**
 * RUBY NAME-RESOLUTION IDENTIFICATION MATRIX — one runCase-backed test per
 * identification case. Every case is backed by a reference-catalogue doc
 * (reference/relations/ruby/<id>.md): the embedded fixture code + the documented
 * `## Expect` outcome are the single source of truth, asserted end-to-end through the
 * REAL relation pass (extractor + SymbolTable + owner index + tri-state resolver) by
 * runCase. The two relations aspects (reference/relations/case-has-test +
 * case-is-tested) enforce the 1:1 catalogue↔test correspondence, so this file cannot
 * drift from the catalogue.
 *
 * THE DUAL-AXIS DECISION (.plans/2026-06-15-ruby-name-resolution-research.md): Ruby is
 * the only supported language that emits BOTH hint kinds from one extractor. A PATH hint
 * from `require_relative '<lit>'` resolves relative to the requiring file's directory
 * (the one file-precise static link). SYMBOL hints from constants (superclass / mixins /
 * scope resolution / qualified-call receiver / bare value-use / pattern-match constant)
 * resolve through the shared SymbolTable by lexically-built FQN, unique-or-silence.
 * Class/module REOPENING makes a constant ambiguous (≥2 defs) → silence — the central
 * recall-killer; a bare constant nested in a namespace lexically shadows → suppressed
 * (C1), while a `::`-rooted / `::`-qualified reference is shadow-free → always emitted.
 * The cardinal invariant — ZERO false positives, a hard wall with no adopter waiver —
 * outranks recall; a missed edge is a tolerated false-NEGATIVE, a wrong edge is not.
 *
 * The catalogue covers the research enumeration: the edge-bearing PATH form
 * (require_relative) and the edge-bearing SYMBOL forms (superclass, include/extend/
 * prepend mixins, qualified mixin, scope-resolution value, qualified-call receiver,
 * bare top-level value, compact `class Foo::Bar` definition, pattern-match constant,
 * `::`-rooted reference, assignment-RHS use), and the silences — plain `require`
 * (load-path), reopening ambiguity, the C1 lexical-shadowing suppression, dynamic
 * const_get/autoload, an external/stdlib constant, an unmapped/absent target, and a
 * same-node (intra-node / ancestor) reference. Each case asserts the SPEC-CORRECT,
 * zero-FP outcome: an edge keyed on the verbatim FQN / resolved path, or silence.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — the path-precise link (require_relative is the only file-precise static link)', () => {
  it('ruby-require-relative-path-edge', () => runCase('ruby-require-relative-path-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — structural constant references (superclass / mixins) resolve through the SymbolTable', () => {
  it('ruby-superclass-edge', () => runCase('ruby-superclass-edge'));
  it('ruby-mixin-include-extend-prepend-edge', () => runCase('ruby-mixin-include-extend-prepend-edge'));
  it('ruby-qualified-mixin-edge', () => runCase('ruby-qualified-mixin-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — value-position constant references (scope resolution / receiver / bare value / RHS)', () => {
  it('ruby-scope-resolution-value-edge', () => runCase('ruby-scope-resolution-value-edge'));
  it('ruby-qualified-call-receiver-edge', () => runCase('ruby-qualified-call-receiver-edge'));
  it('ruby-bare-constant-value-edge', () => runCase('ruby-bare-constant-value-edge'));
  it('ruby-assignment-rhs-edge', () => runCase('ruby-assignment-rhs-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — FQN keying & shadow-free positions (compact def / pattern-match / ::-rooted)', () => {
  it('ruby-compact-class-definition-edge', () => runCase('ruby-compact-class-definition-edge'));
  it('ruby-pattern-match-constant-edge', () => runCase('ruby-pattern-match-constant-edge'));
  it('ruby-rooted-constant-edge', () => runCase('ruby-rooted-constant-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — load-path / ambiguity / shadowing silences (the master zero-FP guards)', () => {
  it('ruby-plain-require-silence', () => runCase('ruby-plain-require-silence'));
  it('ruby-reopening-ambiguity-silence', () => runCase('ruby-reopening-ambiguity-silence'));
  it('ruby-lexical-shadowing-bare-silence', () => runCase('ruby-lexical-shadowing-bare-silence'));
  // Root-anchoring: a compact reopening of an EXTERNAL constant (root not in-repo) → silence.
  it('ruby-reopened-external-constant-silence', () => runCase('ruby-reopened-external-constant-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — dynamic / external / coverage silences (const_get/autoload, stdlib, unmapped, intra-node)', () => {
  it('ruby-dynamic-const-get-silence', () => runCase('ruby-dynamic-const-get-silence'));
  it('ruby-external-stdlib-constant-silence', () => runCase('ruby-external-stdlib-constant-silence'));
  it('ruby-unmapped-target-silence', () => runCase('ruby-unmapped-target-silence'));
  it('ruby-intra-node-silence', () => runCase('ruby-intra-node-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Lexical resolution (Module.nesting): an unrooted `A::B` or a bare constant inside a
// namespace is resolved through the nesting candidates, nearest first; a nearer name
// that exists without the member silences the reference.
describe('MATRIX — lexical resolution through Module.nesting', () => {
  it('ruby-qualified-ref-lexical-shadow-edge', () => runCase('ruby-qualified-ref-lexical-shadow-edge'));
  it('ruby-qualified-ref-lexical-ambiguous-silence', () => runCase('ruby-qualified-ref-lexical-ambiguous-silence'));
  it('ruby-bare-constant-in-method-edge', () => runCase('ruby-bare-constant-in-method-edge'));
  it('ruby-zeitwerk-implicit-namespace-edge', () => runCase('ruby-zeitwerk-implicit-namespace-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
// A reopening is not a definition: core classes and the ubiquitous frameworks'
// namespaces are external even when the repo reopens them.
describe('MATRIX — reopenings of core classes and framework namespaces stay external', () => {
  it('ruby-reopened-external-nested-silence', () => runCase('ruby-reopened-external-nested-silence'));
  it('ruby-core-class-reopening-silence', () => runCase('ruby-core-class-reopening-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — Ruby files without the .rb extension', () => {
  it('ruby-rake-file-edge', () => runCase('ruby-rake-file-edge'));
});
