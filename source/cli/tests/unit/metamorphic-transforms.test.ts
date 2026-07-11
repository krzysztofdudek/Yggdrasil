import { describe, it, expect } from 'vitest';
// The metamorphic probe's PURE transforms are exercised directly here — no reviewer,
// no spawning, fully offline and deterministic. The transforms parse with the built
// tree-sitter grammars (source/cli/dist/grammars) via the CLI's own web-tree-sitter,
// so `npm run build` must have run (the repo quality gate builds before tests).
// @ts-expect-error — plain ESM script at the repo root, no type declarations.
import { autoRename, renameIdentifier, reformat } from '../../../../scripts/metamorphic.mjs';

describe('metamorphic rename — AST-scoped, semantics-preserving alpha-rename', () => {
  it('renames exactly the right token spans of a local parameter (a)', async () => {
    const src = 'export function f(count: number) {\n  return count + 1;\n}\n';
    const r = await autoRename(src, '.ts');
    expect(r.ok).toBe(true);
    // The exported function name `f` and the type `number` are ineligible; the local
    // parameter `count` is the first safe candidate.
    expect(r.from).toBe('count');
    expect(r.to).toBe('count_r');
    expect(r.code).toContain('function f(count_r: number)');
    expect(r.code).toContain('return count_r + 1');
    // Every occurrence of the old name is gone (uniform rename).
    expect(r.code).not.toMatch(/\bcount\b/);
  });

  it('rewrites a reference inside a template substitution as well', async () => {
    const src = 'export function g(n: number) {\n  return `value: ${n}`;\n}\n';
    const r = await autoRename(src, '.ts');
    expect(r.ok).toBe(true);
    expect(r.from).toBe('n');
    expect(r.code).toContain('`value: ${n_r}`');
    expect(r.code).toContain('function g(n_r: number)');
  });

  it('leaves a colliding target UNTOUCHED and reports "no safe rename" (b)', async () => {
    const src = 'const a = 1;\nconst b = 2;\n';
    const r = await renameIdentifier(src, '.ts', 'a', 'b');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no safe rename/);
    // The failure path returns no code — the source is never mutated.
    expect(r.code).toBeUndefined();
  });

  it('renames when the low-level target is fresh', async () => {
    const src = 'const a = 1;\nconst b = 2;\n';
    const r = await renameIdentifier(src, '.ts', 'a', 'zzz');
    expect(r.ok).toBe(true);
    expect(r.code).toContain('const zzz = 1;');
    expect(r.code).toContain('const b = 2;');
  });

  it('refuses to rename an import binding or a public export name', async () => {
    // foo is an import binding (its import occurrence flags it); bar is an exported
    // const. Neither is a safe alpha-rename target, so no candidate remains.
    const src = 'import { foo } from "./x.js";\nexport const bar = foo;\n';
    const r = await autoRename(src, '.ts');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no safe rename/);
  });

  it('refuses to rename a shorthand-fused property name', async () => {
    // `next` is bound as a const AND used as a shorthand property { next } — renaming
    // only the plain-identifier occurrences would desync key and value.
    const src = 'export function h() {\n  const next = 1;\n  return { next };\n}\n';
    const r = await renameIdentifier(src, '.ts', 'next', 'next_r');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/shorthand/);
  });

  it('is deterministic — the same input renames identically twice', async () => {
    const src = 'export function f(count: number) {\n  const total = count + 1;\n  return total;\n}\n';
    const a = await autoRename(src, '.ts');
    const b = await autoRename(src, '.ts');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('metamorphic reformat — deterministic, idempotent, string-safe whitespace normalization', () => {
  it('collapses blank lines and strips trailing whitespace', async () => {
    const src = 'const a = 1;   \n\n\n\nconst b = 2;\n';
    const r = await reformat(src, '.ts');
    expect(r).toBe('const a = 1;\nconst b = 2;\n');
  });

  it('leaves string/template content byte-identical (semantics-preserving)', async () => {
    // Trailing spaces INSIDE a template are content and must survive; blank lines
    // BETWEEN statements are insignificant and must collapse.
    const src = 'const s = `line   \nmore`;\n\n\nconst t = 1;\n';
    const r = await reformat(src, '.ts');
    expect(r).toContain('`line   \nmore`'); // internal whitespace preserved
    expect(r).not.toMatch(/\n\n\n/); // blank-line run collapsed
  });

  it('is deterministic and idempotent (reformat∘reformat === reformat)', async () => {
    const src = 'const a = 1;\r\n\r\n\r\nconst b = 2;\t\n';
    const once = await reformat(src, '.ts');
    const twice = await reformat(src, '.ts');
    const composed = await reformat(once, '.ts');
    expect(once).toBe(twice); // deterministic
    expect(composed).toBe(once); // idempotent
  });

  it('normalizes CRLF to LF', async () => {
    const src = 'const a = 1;\r\nconst b = 2;\r\n';
    const r = await reformat(src, '.ts');
    expect(r).not.toContain('\r');
    expect(r).toBe('const a = 1;\nconst b = 2;\n');
  });
});
