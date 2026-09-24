import { describe, it } from 'vitest';
import { runCase } from '../reference-case-runner.js';

/**
 * C / C++ NAME-RESOLUTION IDENTIFICATION MATRIX — one runCase-backed test per
 * identification case. Every case is backed by a reference-catalogue doc
 * (reference/relations/cpp/<id>.md): the embedded fixture code + the documented
 * `## Expect` outcome are the single source of truth, asserted end-to-end through the
 * REAL relation pass (the shared C/C++ include extractor + the canonical quoted-include
 * resolver) by runCase. The two relations aspects (reference/relations/case-has-test +
 * case-is-tested) enforce the 1:1 catalogue↔test correspondence, so this file cannot
 * drift from the catalogue.
 *
 * ONE combined suite for BOTH languages: C and C++ share the include mechanism end to end
 * (the `preproc_include` node, its `path` field, and the canonical join are identical
 * across tree-sitter-c and tree-sitter-cpp). The `.c`/`.h` extensions bind the C grammar
 * and `.cpp`/`.hpp`/… bind the C++ grammar, but both route through the SAME `includeUses`
 * and the SAME extension-agnostic resolver — so C-grammar behaviour is exercised by cases
 * whose `## Files` embed `.c`/`.h` fixtures. The cases that are about C itself live under
 * `c/` with their own matrix suite (c-name-resolution-matrix.test.ts).
 *
 * THE GROUP B (path-based) DECISION (.plans/2026-06-14-import-only-languages-decision.md,
 * widened in 6.1.0): C/C++ has NO namespace-based module resolution — a translation unit
 * depends on another file PURELY by `#include` PATH. A quoted include resolves next to the
 * includer first, then under the include roots: a compile_commands.json's -iquote/-I roots
 * when one exists, else a conservative probe (repository root + every `include/` directory,
 * multi-segment names without `.`/`..` only). An angle include resolves only under a database's
 * -I roots. Across roots exactly one hit resolves; 2+ is silence. Nothing binds by name. The
 * C/C++-shaped false-positive surfaces — a same-basename header in the wrong directory, an
 * angle/system include mapped to an in-repo same-name file, a bare-name decoy under an
 * include/ dir, a header under two roots, an over-climb above the repo root, and an include in
 * a statically dead preprocessor group (a condition that evaluates to 0 from literals alone,
 * or a later group of a chain whose earlier condition is a known non-zero) — are each pinned
 * below. The cardinal invariant — ZERO false positives — outranks recall; a missed edge is a
 * tolerated false-NEGATIVE. C-specific forms live in c-name-resolution-matrix.test.ts.
 *
 * C++20 modules are DELIBERATE-SILENCE on two independent walls (research PART B): a module
 * NAME is decoupled from any file PATH (the name→file map lives in the build system, not in
 * source), AND the bundled tree-sitter-cpp@0.23.4 misparses every module form into ordinary
 * declarations or ERROR nodes — so `import std;`, `export module foo;`, `import "header.h";`
 * (the one path-naming form, misparsed as a string expression), and module partitions all
 * stay silent.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — quoted includes that resolve (the header PATH is the edge → node by canonical join)', () => {
  it('cpp-quoted-subpath-include-edge', () => runCase('cpp-quoted-subpath-include-edge'));
  it('cpp-quoted-uppath-include-edge', () => runCase('cpp-quoted-uppath-include-edge'));
  it('cpp-same-basename-cross-dir-edge', () => runCase('cpp-same-basename-cross-dir-edge'));
  it('cpp-live-conditional-include-edge', () => runCase('cpp-live-conditional-include-edge'));
  it('cpp-backslash-include-edge', () => runCase('cpp-backslash-include-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — same-directory include (intra-node → SILENCE, never a cross-node edge)', () => {
  it('cpp-quoted-same-dir-intra-node-silence', () => runCase('cpp-quoted-same-dir-intra-node-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — angle / macro / non-existent includes (emission gate + resolver miss → SILENCE)', () => {
  it('cpp-angle-system-include-silence', () => runCase('cpp-angle-system-include-silence'));
  it('cpp-macro-operand-include-silence', () => runCase('cpp-macro-operand-include-silence'));
  it('cpp-nonexistent-quoted-include-silence', () => runCase('cpp-nonexistent-quoted-include-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SEAL: an `#include` in the dead body of a literal `#if 0` is statically-known-dead;
// emitting an edge for code the compiler discards is a genuine false positive, so it is
// skipped at emission even when the target header really exists.
describe('MATRIX — dead `#if 0` include (statically-known-dead → SILENCE; the sealed FP)', () => {
  it('cpp-dead-if-zero-include-silence', () => runCase('cpp-dead-if-zero-include-silence'));
  // Branch precision: the LIVE `#else` of a dead `#if 0` is kept (only the dead body is skipped).
  it('cpp-dead-if-zero-else-live-edge', () => runCase('cpp-dead-if-zero-else-live-edge'));
  // Constant conditions beyond the bare `0`: `false`, and the `#else` of a taken `#if 1`.
  it('cpp-if-false-silence', () => runCase('cpp-if-false-silence'));
  it('cpp-if-one-else-dead-silence', () => runCase('cpp-if-one-else-dead-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Include roots. With a compile_commands.json (repo root or build/) its -iquote/-I roots are
// the whole truth; without one, a multi-segment quoted path is probed under the repository
// root and every `include/` directory. Either way exactly one hit resolves; 2+ is silence.
describe('MATRIX — include roots (compile database, else a conservative probe; exactly one hit)', () => {
  it('cpp-include-root-via-compile-db-edge', () => runCase('cpp-include-root-via-compile-db-edge'));
  it('cpp-in-repo-angle-include-via-I-edge', () => runCase('cpp-in-repo-angle-include-via-I-edge'));
  it('cpp-header-under-two-roots-silence', () => runCase('cpp-header-under-two-roots-silence'));
  it('cpp-compile-db-authoritative-silence', () => runCase('cpp-compile-db-authoritative-silence'));
  it('cpp-root-relative-google-style-edge', () => runCase('cpp-root-relative-google-style-edge'));
  it('cpp-include-dir-probe-edge', () => runCase('cpp-include-dir-probe-edge'));
  it('cpp-include-dir-probe-ambiguous-silence', () => runCase('cpp-include-dir-probe-ambiguous-silence'));
  it('cpp-bare-name-no-probe-silence', () => runCase('cpp-bare-name-no-probe-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
// File kinds: template implementation files, module interface units, and a C++ header named .h.
describe('MATRIX — C++ file kinds (.ipp/.cppm parsed as C++; a .h with C++ siblings parsed as C++)', () => {
  it('cpp-ipp-source-include-edge', () => runCase('cpp-ipp-source-include-edge'));
  it('cpp-cppm-global-module-fragment-edge', () => runCase('cpp-cppm-global-module-fragment-edge'));
  it('cpp-cpp-header-named-h', () => runCase('cpp-cpp-header-named-h'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — include escaping the repo root (path normalization rejects → SILENCE)', () => {
  it('cpp-include-escapes-repo-root-silence', () => runCase('cpp-include-escapes-repo-root-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
// C++20 modules: name-decoupled-from-path AND grammar-unsupported (tree-sitter-cpp@0.23.4
// misparses every form) → SILENCE on every module form.
describe('MATRIX — C++20 modules (name≠path + grammar-unsupported → SILENCE on every form)', () => {
  it('cpp-module-import-std-silence', () => runCase('cpp-module-import-std-silence'));
  it('cpp-export-module-decl-silence', () => runCase('cpp-export-module-decl-silence'));
  it('cpp-import-header-unit-silence', () => runCase('cpp-import-header-unit-silence'));
  it('cpp-module-partition-silence', () => runCase('cpp-module-partition-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — usage sites (call / inheritance / `ns::Type` / `using` bind by NAME → SILENCE)', () => {
  it('cpp-usage-site-silence', () => runCase('cpp-usage-site-silence'));
});
