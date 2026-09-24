import { describe, it } from 'vitest';
import { runCase } from '../reference-case-runner.js';

/**
 * TYPESCRIPT / TSX / JAVASCRIPT NAME-RESOLUTION IDENTIFICATION MATRIX — one
 * runCase-backed test per identification case. Every case is backed by a
 * reference-catalogue doc (reference/relations/typescript/<id>.md): the embedded
 * fixture code + the documented `## Expect` outcome are the single source of truth,
 * asserted end-to-end through the REAL relation pass (extractor + path resolver over a
 * materialized project, tsconfig/package.json included) by runCase. The two relations
 * aspects (reference/relations/case-has-test + case-is-tested) enforce the 1:1
 * catalogue↔test correspondence, so this file cannot drift from the catalogue.
 *
 * TS/JS resolves imports to FILES by PATH — a cross-module reference is ALWAYS established
 * by a construct bearing a module SPECIFIER (a string literal). The specifier resolves to a
 * file by relative join, by the package root (root-absolute), by package.json `imports`,
 * by tsconfig `paths`/`baseUrl`, or by an in-repo package's `name` + `exports`/`main`;
 * everything else is external and silent. Type-only references are erased at compile time and
 * silent in every spelling (statement forms and type-position `import()` alike). The cardinal invariant — ZERO false positives — outranks recall:
 * where resolution is ambiguous (two `paths` targets, two packages with one name) the
 * reference stays silent.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — static import forms (the specifier IS the edge; binding form is irrelevant)', () => {
  it('typescript-default-import-edge', () => runCase('typescript-default-import-edge'));
  it('typescript-named-import-edge', () => runCase('typescript-named-import-edge'));
  it('typescript-namespace-import-edge', () => runCase('typescript-namespace-import-edge'));
  it('typescript-side-effect-import-edge', () => runCase('typescript-side-effect-import-edge'));
  it('typescript-default-plus-named-import-edge', () => runCase('typescript-default-plus-named-import-edge'));
  it('typescript-import-defer-edge', () => runCase('typescript-import-defer-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — type-only references (one rule: erased at compile time → SILENT in every spelling) vs runtime-binding keeps', () => {
  it('typescript-import-type-whole-statement-silence', () => runCase('typescript-import-type-whole-statement-silence'));
  it('typescript-import-type-namespace-silence', () => runCase('typescript-import-type-namespace-silence'));
  it('typescript-all-inline-type-import-silence', () => runCase('typescript-all-inline-type-import-silence'));
  it('typescript-mixed-inline-type-import-edge', () => runCase('typescript-mixed-inline-type-import-edge'));
  it('typescript-inline-type-runtime-default-edge', () => runCase('typescript-inline-type-runtime-default-edge'));
  it('typescript-typeof-import-type-query', () => runCase('typescript-typeof-import-type-query'));
  it('typescript-import-type-member-annotation', () => runCase('typescript-import-type-member-annotation'));
  it('typescript-import-type-equals-require', () => runCase('typescript-import-type-equals-require'));
  it('typescript-relative-module-augmentation', () => runCase('typescript-relative-module-augmentation'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — re-exports (value re-exports resolve; type-only re-exports → SILENT)', () => {
  it('typescript-named-reexport-edge', () => runCase('typescript-named-reexport-edge'));
  it('typescript-star-reexport-edge', () => runCase('typescript-star-reexport-edge'));
  it('typescript-namespace-reexport-edge', () => runCase('typescript-namespace-reexport-edge'));
  it('typescript-empty-reexport-edge', () => runCase('typescript-empty-reexport-edge'));
  it('typescript-export-type-whole-statement-silence', () => runCase('typescript-export-type-whole-statement-silence'));
  it('typescript-all-inline-type-reexport-silence', () => runCase('typescript-all-inline-type-reexport-silence'));
  it('typescript-mixed-inline-type-reexport-edge', () => runCase('typescript-mixed-inline-type-reexport-edge'));
  it('typescript-export-type-star-reexport-silence', () => runCase('typescript-export-type-star-reexport-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — require axis (require / import-equals / export-assignment; no-arg + member silences)', () => {
  it('typescript-require-edge', () => runCase('typescript-require-edge'));
  it('typescript-import-equals-require-edge', () => runCase('typescript-import-equals-require-edge'));
  it('typescript-export-equals-require-edge', () => runCase('typescript-export-equals-require-edge'));
  it('typescript-require-no-argument-silence', () => runCase('typescript-require-no-argument-silence'));
  it('typescript-require-resolve-member-silence', () => runCase('typescript-require-resolve-member-silence'));
  it('typescript-cts-cjs-require-edge', () => runCase('typescript-cts-cjs-require-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — dynamic references (string literal resolves; non-literal arguments and mock registrations stay silent)', () => {
  it('typescript-dynamic-import-literal-edge', () => runCase('typescript-dynamic-import-literal-edge'));
  it('typescript-dynamic-import-template-silence', () => runCase('typescript-dynamic-import-template-silence'));
  it('typescript-dynamic-import-non-literal-silence', () => runCase('typescript-dynamic-import-non-literal-silence'));
  it('typescript-import-meta-resolve-silence', () => runCase('typescript-import-meta-resolve-silence'));
  it('typescript-template-no-substitution-dynamic-import-edge', () => runCase('typescript-template-no-substitution-dynamic-import-edge'));
  it('typescript-new-url-import-meta-edge', () => runCase('typescript-new-url-import-meta-edge'));
  it('typescript-vi-mock-silence', () => runCase('typescript-vi-mock-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — relative resolution (relative join pins the directory; extension / package / index probing)', () => {
  it('typescript-relative-resolves-tsx-edge', () => runCase('typescript-relative-resolves-tsx-edge'));
  it('typescript-relative-resolves-js-edge', () => runCase('typescript-relative-resolves-js-edge'));
  it('typescript-nodenext-js-to-ts-edge', () => runCase('typescript-nodenext-js-to-ts-edge'));
  it('typescript-mts-mjs-rewrite-edge', () => runCase('typescript-mts-mjs-rewrite-edge'));
  it('typescript-explicit-ts-extension-edge', () => runCase('typescript-explicit-ts-extension-edge'));
  it('typescript-directory-index-edge', () => runCase('typescript-directory-index-edge'));
  it('typescript-index-mjs-cjs-edge', () => runCase('typescript-index-mjs-cjs-edge'));
  it('typescript-package-main-directory-edge', () => runCase('typescript-package-main-directory-edge'));
  it('typescript-sibling-same-name-trap-edge', () => runCase('typescript-sibling-same-name-trap-edge'));
  it('typescript-unmapped-target-silence', () => runCase('typescript-unmapped-target-silence'));
  it('typescript-intra-node-import-silence', () => runCase('typescript-intra-node-import-silence'));
  it('typescript-import-attribute-json-edge', () => runCase('typescript-import-attribute-json-edge'));
  it('typescript-query-suffix-import-edge', () => runCase('typescript-query-suffix-import-edge'));
  it('typescript-root-absolute-specifier', () => runCase('typescript-root-absolute-specifier'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — project configuration (tsconfig paths/baseUrl/extends, workspace packages, package imports)', () => {
  it('typescript-tsconfig-paths-edge', () => runCase('typescript-tsconfig-paths-edge'));
  it('typescript-tsconfig-baseurl-edge', () => runCase('typescript-tsconfig-baseurl-edge'));
  it('typescript-tsconfig-extends-paths-edge', () => runCase('typescript-tsconfig-extends-paths-edge'));
  it('typescript-tsconfig-paths-multi-target-silence', () => runCase('typescript-tsconfig-paths-multi-target-silence'));
  it('typescript-tsconfig-alias-silence', () => runCase('typescript-tsconfig-alias-silence'));
  it('typescript-workspace-package-edge', () => runCase('typescript-workspace-package-edge'));
  it('typescript-workspace-subpath-exports-edge', () => runCase('typescript-workspace-subpath-exports-edge'));
  it('typescript-workspace-duplicate-name-silence', () => runCase('typescript-workspace-duplicate-name-silence'));
  it('typescript-package-imports-edge', () => runCase('typescript-package-imports-edge'));
  it('typescript-package-subpath-imports-silence', () => runCase('typescript-package-subpath-imports-silence'));
  it('typescript-bare-specifier-silence', () => runCase('typescript-bare-specifier-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — grammar recovery (statements the shipped grammar swallows into ERROR still give their edge)', () => {
  it('typescript-for-await-using-then-import-edge', () => runCase('typescript-for-await-using-then-import-edge'));
  it('typescript-tsx-import-type-args-then-import-edge', () => runCase('typescript-tsx-import-type-args-then-import-edge'));
  it('typescript-export-from-with-attributes-edge', () => runCase('typescript-export-from-with-attributes-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — single-file components (Vue / Svelte script blocks)', () => {
  it('typescript-vue-sfc-script-import-edge', () => runCase('typescript-vue-sfc-script-import-edge'));
  it('typescript-svelte-sfc-script-import-edge', () => runCase('typescript-svelte-sfc-script-import-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — external declarations and usage sites (not a specifier → SILENT)', () => {
  it('typescript-ambient-declare-module-silence', () => runCase('typescript-ambient-declare-module-silence'));
  it('typescript-triple-slash-reference-silence', () => runCase('typescript-triple-slash-reference-silence'));
  it('typescript-usage-site-no-import-silence', () => runCase('typescript-usage-site-no-import-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — JavaScript (no type syntax): the same path forms resolve, no crash', () => {
  it('typescript-javascript-import-require-edge', () => runCase('typescript-javascript-import-require-edge'));
});
