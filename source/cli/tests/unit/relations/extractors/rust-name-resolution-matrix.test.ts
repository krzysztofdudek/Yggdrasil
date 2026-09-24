import { describe, it, expect } from 'vitest';
import { runCase } from '../reference-case-runner.js';
import {
  resolveRustPath,
  type RustResolveDeps,
} from '../../../../src/relations/extractors/rust-resolve.js';

/**
 * RUST NAME-RESOLUTION IDENTIFICATION MATRIX — one runCase-backed test per
 * identification case. Every catalogue-driven case is backed by a reference-catalogue
 * doc (reference/relations/rust/<id>.md): the embedded fixture code + the documented
 * `## Expect` outcome are the single source of truth, asserted end-to-end through the
 * REAL relation pass (extractor + path resolver) by runCase. The two relations aspects
 * (reference/relations/case-has-test + case-is-tested) enforce the 1:1 catalogue↔test
 * correspondence, so the catalogue cannot drift from this file.
 *
 * THE GROUP B (path-based) DECISION (.plans/2026-06-14-import-only-languages-decision.md):
 * Rust resolves a `use`/path through the CRATE MODULE TREE — built by `mod` declarations,
 * not a raw directory walk. `use crate::a::b::C` walks the tree rooted at the crate's `src/`;
 * `super::`/`self::` resolve relative to the importing file's module; a leading
 * `crate`/`super`/`self` (or the crate's own package name) is INTRA-crate, anything else
 * (`std`, `core`, `alloc`, a Cargo dependency like `serde`) is an EXTERNAL crate. It does NOT
 * resolve by namespace-relative simple-NAME binding, so the §-precedence simple-name trap
 * that drives the symbol languages does not apply. The cardinal invariant — ZERO false
 * positives, a hard wall with no adopter waiver — outranks recall; a missed edge is a
 * tolerated false-NEGATIVE.
 *
 * The catalogue covers the research enumeration (.plans/2026-06-15-rust-name-resolution-
 * research.md): every `use` shape that resolves (single / renamed / grouped / glob / pub use),
 * the file-backed `mod foo;` structural edge, the crate/self/super inline TYPE- and
 * EXPRESSION-position edges, and the silence forms (`#[path]` override, inline `mod` body,
 * bare-identifier-rooted inline, external crate incl. the `serde` collision trap, macro
 * token tree). Each catalogue case asserts the SPEC-CORRECT, zero-FP outcome (an edge to the
 * right node, or silence) end-to-end through the real pass.
 *
 * Resolver-level invariants that the runCase harness cannot express stay as DIRECT
 * resolver assertions below (the `R(...)` helper drives `resolveRustPath` over a fixed
 * known file-set): the same-LEAF module-path traps, the `super::` over-climb guards, the
 * no-Cargo.toml-ancestor / empty-specifier silences, and the candidate-parity invariant.
 * The harness materializes a temp project from the catalogue's `## Files` and resolves
 * against THAT layout, so a probe of a fixed in-memory known-set (which the same-leaf and
 * no-crate-root cases need to isolate exactly one variable) is not expressible there.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — crate-relative use (the `::`-path IS the edge; resolves through the module tree)', () => {
  it('rust-use-single-crate-relative-edge', () => runCase('rust-use-single-crate-relative-edge'));
  it('rust-use-renamed-alias-dropped-edge', () => runCase('rust-use-renamed-alias-dropped-edge'));
  it('rust-use-grouped-common-prefix-edge', () => runCase('rust-use-grouped-common-prefix-edge'));
  it('rust-use-glob-prefix-module-edge', () => runCase('rust-use-glob-prefix-module-edge'));
  it('rust-pub-use-reexport-edge', () => runCase('rust-pub-use-reexport-edge'));
  it('rust-use-grouped-crate-root-edge', () => runCase('rust-use-grouped-crate-root-edge'));
  it('rust-use-grouped-nested-subpath-edge', () => runCase('rust-use-grouped-nested-subpath-edge'));
  it('rust-use-crate-root-item-edge', () => runCase('rust-use-crate-root-item-edge'));
  it('rust-raw-identifier-module-edge', () => runCase('rust-raw-identifier-module-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — Cargo targets and packages (bin / test crate roots, in-repo path dependencies, extern crate)', () => {
  it('rust-bin-target-crate-root-edge', () => runCase('rust-bin-target-crate-root-edge'));
  it('rust-integration-test-mod-common-edge', () => runCase('rust-integration-test-mod-common-edge'));
  it('rust-workspace-path-dependency-edge', () => runCase('rust-workspace-path-dependency-edge'));
  it('rust-extern-crate-alias-edge', () => runCase('rust-extern-crate-alias-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — inline modules are a level of the module tree (super/self and mod decls inside `mod x { … }`)', () => {
  it('rust-inline-mod-tests-super-glob-silence', () => runCase('rust-inline-mod-tests-super-glob-silence'));
  it('rust-mod-decl-inside-inline-mod-edge', () => runCase('rust-mod-decl-inside-inline-mod-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — mod declarations & inline crate-relative paths (file-backed mod + crate/self/super inline → EDGE)', () => {
  it('rust-mod-decl-file-backed-edge', () => runCase('rust-mod-decl-file-backed-edge'));
  it('rust-inline-crate-type-position-edge', () => runCase('rust-inline-crate-type-position-edge'));
  it('rust-inline-crate-expression-position-edge', () =>
    runCase('rust-inline-crate-expression-position-edge'));
  it('rust-inline-self-super-relative-edge', () => runCase('rust-inline-self-super-relative-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — silence forms (#[path] override / inline mod body / bare root / external crate / macro token tree)', () => {
  it('rust-mod-path-attribute-override-silence', () =>
    runCase('rust-mod-path-attribute-override-silence'));
  it('rust-inline-mod-body-silence', () => runCase('rust-inline-mod-body-silence'));
  it('rust-inline-bare-root-silence', () => runCase('rust-inline-bare-root-silence'));
  it('rust-use-external-crate-silence', () => runCase('rust-use-external-crate-silence'));
  it('rust-macro-invocation-path-silence', () => runCase('rust-macro-invocation-path-silence'));
  it('rust-macro-export-silence', () => runCase('rust-macro-export-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVER-LEVEL assertions — verified directly against `resolveRustPath` over a fixed
// known file-set. These pin module-tree mechanics that the catalogue/runCase harness
// cannot express (it materializes the EXACT `## Files` layout, whereas these isolate one
// variable by probing a curated in-memory known-set). Kept as direct assertions, mirroring
// the way the Kotlin matrix keeps one non-catalogue resolver assertion.
//
// A reusable resolver-deps fixture: crate `mycrate`, `src/` as the module-tree root, with a
// concrete in-repo module layout. Existence is checked against a fixed known-set keyed by
// repo-relative POSIX path. The same-LEAF traps are baked in:
//   crate::x  → src/x.rs        vs  crate::a::x → src/a/x.rs   (top-level vs nested, leaf `x`)
//   crate::a::sib → src/a/sib.rs vs crate::sib → src/sib.rs    (sibling vs top-level, leaf `sib`)
// `src/serde.rs` exists ON PURPOSE so the external-crate guard is proven NOT to be a file probe.
const KNOWN = new Set<string>([
  'src/lib.rs', // crate root module
  'src/a.rs', // module crate::a (file form)
  'src/a/b.rs', // module crate::a::b
  'src/a/b/deep.rs', // module crate::a::b::deep (submodule of b)
  'src/a/sib.rs', // module crate::a::sib (sibling of b)
  'src/a/x.rs', // module crate::a::x (leaf `x`, nested)
  'src/x.rs', // module crate::x (leaf `x`, top-level — the trap twin of a::x)
  'src/sib.rs', // module crate::sib (leaf `sib`, top-level — the trap twin of a::sib)
  'src/serde.rs', // an in-repo module NAMED like the external crate `serde` (FP trap)
]);
const baseDeps: RustResolveDeps = {
  crateRootFor: () => ({ srcDir: 'src', crateName: 'mycrate' }),
};
const exists = (p: string) => KNOWN.has(p);
const R = (specifier: string, fromFile: string, deps: RustResolveDeps = baseDeps) =>
  resolveRustPath(specifier, fromFile, exists, deps);

describe('RESOLVER — same-LEAF different-module-path traps (the FULL path pins the file)', () => {
  it('`crate::x::Y` → `src/x.rs`, NEVER the nested `src/a/x.rs` (leaf `x` collision)', () => {
    expect(R('crate::x::Y', 'src/lib.rs')).toBe('src/x.rs');
  });

  it('`crate::a::x::Y` → `src/a/x.rs`, NEVER the top-level `src/x.rs` (twin)', () => {
    expect(R('crate::a::x::Y', 'src/lib.rs')).toBe('src/a/x.rs');
  });

  it('the crate own NAME root `mycrate::a::b::C` is treated like `crate` → `src/a/b.rs`', () => {
    expect(R('mycrate::a::b::C', 'src/lib.rs')).toBe('src/a/b.rs');
  });

  it('the external-crate guard is NOT a file probe: `serde::Foo` → SILENCE even though `src/serde.rs` EXISTS', () => {
    expect(R('serde::Foo', 'src/lib.rs')).toBeUndefined();
  });

  it('the in-repo twin IS reachable — only via `crate::`: `crate::serde::Foo` → `src/serde.rs`', () => {
    expect(R('crate::serde::Foo', 'src/lib.rs')).toBe('src/serde.rs');
  });
});

describe('RESOLVER — super:: / self:: relative climbs (mis-climb / over-climb → SILENCE)', () => {
  it('`super::sib::Y` from `src/a/b.rs` → `src/a/sib.rs` (one climb to module a, sibling sib)', () => {
    expect(R('super::sib::Y', 'src/a/b.rs')).toBe('src/a/sib.rs');
  });

  it('`super::super::sib::Y` from `src/a/b.rs` → top-level `src/sib.rs` (two climbs select the twin)', () => {
    expect(R('super::super::sib::Y', 'src/a/b.rs')).toBe('src/sib.rs');
  });

  it('`self::deep::Z` from `src/a/b.rs` → `src/a/b/deep.rs` (submodule of the own module)', () => {
    expect(R('self::deep::Z', 'src/a/b.rs')).toBe('src/a/b/deep.rs');
  });

  it('over-climb guard: `super::super::super::X` from `src/a/b.rs` → SILENCE (above the crate root)', () => {
    expect(R('super::super::super::X', 'src/a/b.rs')).toBeUndefined();
  });

  it('root-module climb guard: `super::X` from `src/lib.rs` → SILENCE (crate root has no parent module)', () => {
    expect(R('super::X', 'src/lib.rs')).toBeUndefined();
  });
});

describe('RESOLVER — no-crate-root / malformed (no Cargo.toml ancestor or unrenderable path → SILENCE)', () => {
  it('a crate path with NO Cargo.toml ancestor → SILENCE (no module-tree root to anchor)', () => {
    const noCrate: RustResolveDeps = { crateRootFor: () => undefined };
    expect(R('crate::a::b::C', 'src/lib.rs', noCrate)).toBeUndefined();
  });

  it('a `super::` path with NO Cargo.toml ancestor → SILENCE (relative resolution still needs src/)', () => {
    const noCrate: RustResolveDeps = { crateRootFor: () => undefined };
    expect(R('super::sib::Y', 'src/a/b.rs', noCrate)).toBeUndefined();
  });

  it('an empty specifier → SILENCE (no path segments to resolve)', () => {
    expect(R('', 'src/lib.rs')).toBeUndefined();
  });
});
