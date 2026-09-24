import { describe, it } from 'vitest';
import { runCase } from '../reference-case-runner.js';

/**
 * PYTHON NAME-RESOLUTION IDENTIFICATION MATRIX — one runCase-backed test per
 * identification case. Every case is backed by a reference-catalogue doc
 * (reference/relations/python/<id>.md): the embedded fixture code + the documented
 * `## Expect` outcome are the single source of truth, asserted end-to-end through the
 * REAL relation pass (extractor + module-path resolver) by runCase. The two relations
 * aspects (reference/relations/case-has-test + case-is-tested) enforce the 1:1
 * catalogue↔test correspondence, so this file cannot drift from the catalogue.
 *
 * THE GROUP B (path-axis) DECISION (.plans/2026-06-14-import-only-languages-decision.md):
 * Python resolves an import to a FILE by module-path = file-path, NOT by namespace-relative
 * simple-NAME binding. There is no §-precedence simple-name trap (that drives the symbol
 * languages). A cross-module reference is ALWAYS established by an `import` /
 * `from … import` statement whose operand is a MODULE PATH; usage-site references (class
 * bases, decorators, calls, type hints) carry no new edge — the import already established
 * the dependency. The local binding form — plain, aliased, star, relative — is irrelevant
 * to the edge; every form names the same real module path. The cardinal invariant — ZERO
 * false positives, a hard wall with no adopter waiver — outranks recall; a missed edge is a
 * tolerated false-NEGATIVE.
 *
 * The catalogue covers the research enumeration (.plans/2026-06-15-python-name-resolution-
 * research.md): the edge-bearing import forms — plain/aliased/multi `import` (A1–A3), the
 * `from M import x` module + longest-match submodule candidate (B1, both the name-in-module
 * and the submodule-file half), relative sibling and parent climb (C1–C3), star (E1),
 * conditional / function-local / TYPE_CHECKING placements (F1–F3), the PEP 420 namespace
 * SUBMODULE (D3a), and the re-export chain (E3) — and the silences: `from __future__` (E4),
 * dynamic importlib/__import__ (E5), the namespace PACKAGE OBJECT (D3b), stdlib (PY6) and
 * external (PY6) resolution misses, an unmapped module (PY7 coverage gap), an intra-node
 * sibling, the relative climb-above-root escape (C4), and the `__all__` assignment (E2).
 * Each case asserts the SPEC-CORRECT, zero-FP outcome: an edge to the file the module path
 * names, or silence.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — absolute import forms (module-path = file-path; the operand is the edge)', () => {
  it('python-plain-import-edge', () => runCase('python-plain-import-edge'));
  it('python-aliased-import-edge', () => runCase('python-aliased-import-edge'));
  it('python-multi-name-import-edge', () => runCase('python-multi-name-import-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — from-import (module + longest-match submodule candidate, never a phantom)', () => {
  it('python-from-import-absolute-edge', () => runCase('python-from-import-absolute-edge'));
  it('python-from-import-submodule-edge', () => runCase('python-from-import-submodule-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — relative imports (directory-pinned climb by dot-count)', () => {
  it('python-relative-sibling-import-edge', () => runCase('python-relative-sibling-import-edge'));
  it('python-relative-parent-import-edge', () => runCase('python-relative-parent-import-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — star / placement variants (whole-tree walk catches every placement)', () => {
  it('python-star-import-edge', () => runCase('python-star-import-edge'));
  it('python-conditional-import-edge', () => runCase('python-conditional-import-edge'));
  it('python-function-local-import-edge', () => runCase('python-function-local-import-edge'));
  it('python-type-checking-import-edge', () => runCase('python-type-checking-import-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
// PEP 420 namespace packages: a SUBMODULE inside one resolves (the file is probed
// directly, __init__-independently); the namespace PACKAGE OBJECT itself silences (no
// single backing file). Plus the re-export chain (each end resolved by file path,
// the chain deliberately not traced).
describe('MATRIX — namespace packages and re-exports (submodule edge / package-object silence)', () => {
  it('python-namespace-submodule-edge', () => runCase('python-namespace-submodule-edge'));
  it('python-reexport-chain-edge', () => runCase('python-reexport-chain-edge'));
  it('python-namespace-package-object-silence', () =>
    runCase('python-namespace-package-object-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — dynamic / future / external (resolution miss or non-import → SILENCE)', () => {
  it('python-future-import-silence', () => runCase('python-future-import-silence'));
  it('python-dynamic-importlib-silence', () => runCase('python-dynamic-importlib-silence'));
  it('python-stdlib-import-silence', () => runCase('python-stdlib-import-silence'));
  it('python-external-import-silence', () => runCase('python-external-import-silence'));
  it('python-all-export-silence', () => runCase('python-all-export-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — coverage / granularity / escape silences (zero false positives)', () => {
  it('python-unmapped-module-silence', () => runCase('python-unmapped-module-silence'));
  it('python-intra-node-import-silence', () => runCase('python-intra-node-import-silence'));
  it('python-relative-escape-silence', () => runCase('python-relative-escape-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Source roots: only directories outside a regular package are sys.path-like roots
// (an ancestor package's same-named module never shadows the stdlib or an installed
// library), and roots are also discovered repo-wide from project manifests (src
// layout, uv/Poetry workspace members) without letting them shadow the stdlib.
describe('MATRIX — source roots (ancestor packages are not roots; discovered project roots)', () => {
  it('python-stdlib-shadowed-by-ancestor-module-silence', () =>
    runCase('python-stdlib-shadowed-by-ancestor-module-silence'));
  it('python-src-layout-tests-edge', () => runCase('python-src-layout-tests-edge'));
  it('python-workspace-member-edge', () => runCase('python-workspace-member-edge'));
  it('python-workspace-stdlib-name-silence', () => runCase('python-workspace-stdlib-name-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — newer import syntax and report shape', () => {
  it('python-lazy-import-edge', () => runCase('python-lazy-import-edge'));
  it('python-from-import-single-report', () => runCase('python-from-import-single-report'));
});
