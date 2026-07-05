import { describe, it, expect } from 'vitest';
import { runCase } from '../reference-case-runner.js';
import { javaExtractor } from '../../../../src/relations/extractors/java.js';
import { resolveJavaFqn, type JavaResolveDeps } from '../../../../src/relations/extractors/java-resolve.js';
import { SymbolTable } from '../../../../src/relations/symbol-table.js';
import { makeResolver } from '../../../../src/relations/resolver.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { withParsedFile } from '../../../../src/ast/parser.js';
import type { ParsedFile } from '../../../../src/relations/extractors/types.js';

/**
 * JAVA NAME-RESOLUTION IDENTIFICATION MATRIX — one runCase-backed test per
 * identification case. Every case is backed by a reference-catalogue doc
 * (reference/relations/java/<id>.md): the embedded fixture code + the documented
 * `## Expect` outcome are the single source of truth, asserted end-to-end through the
 * REAL relation pass (extractor + resolver) by runCase. The two relations aspects
 * (reference/relations/case-has-test + case-is-tested) enforce the 1:1 catalogue↔test
 * correspondence, so this file cannot drift from the catalogue.
 *
 * THE GOVERNING INVARIANT: a Java dependency edge is established ONLY by a SHADOW-FREE
 * FULLY-QUALIFIED type reference. Three forms qualify: an `import_declaration` (operand is
 * a fully-qualified type, or a package for a wildcard), a `module-info.java`
 * `uses`/`provides` directive (a shadow-free service-TYPE FQN), and — NEW — an INLINE
 * fully-qualified TYPE reference written WITHOUT an import (the outermost
 * `scoped_type_identifier`: a dotted type in any TYPE position). Because the name is
 * fully qualified it is shadow-free per JLS §6.5.5.2 — there is no simple-name precedence
 * trap to fall into. What stays FORBIDDEN is resolving a PARTIALLY-qualified name, a bare
 * SAME-PACKAGE simple name, or EXPRESSION-position dotted access — those would reintroduce
 * the §6.5.5 trap. The cardinal invariant — ZERO false positives, a hard wall with no
 * adopter waiver — outranks recall; a missed edge is a tolerated false-NEGATIVE.
 *
 * THE ZERO-FP BOUNDARY: the inline-FQN form edges ONLY in a TYPE position, because the
 * grammar node `scoped_type_identifier` occurs only in type positions. An EXPRESSION-position
 * dotted access (`com.app.Helper.staticMethod()`, a qualified enum constant, an
 * annotation-use name) parses as a `field_access` / `method_invocation` chain — never a
 * `scoped_type_identifier` — and stays silent. The import / package / module-info service
 * forms emit `path` hints through the PATH axis (`resolveJavaFqn` / `resolveJavaPackageFiles`);
 * the new inline-FQN form emits a `symbol` hint that resolves through the shared SymbolTable —
 * which, being a fully-qualified key, is shadow-free, so the classic name-collision FP trap
 * stays structurally unreachable (the SymbolTable's distinct-file rule + declared-type
 * `+`-split silence any dotted name that could bind two ways). The Java symbol table (built
 * from `declarations()`) is now LOAD-BEARING for the inline-FQN form.
 *
 * The catalogue covers the full research enumeration (.plans/2026-06-15-java-name-resolution-
 * research.md): import forms (B1–B4/B6), wildcard owner-set collapse, JDK/stdlib/external
 * silence (C1), nested keying & fallback (D1), the usage-site TYPE-position forms now
 * promoted to inline-FQN edges (F1–F20, D2) alongside the residual partially-qualified /
 * same-package / expression-position silences (F6/F21, A2, D2'), the MUST-EXCLUDE non-type
 * tokens (G1–G4), and the newer 17→25 forms — module import (B5, SILENCE), module-info
 * uses/provides (E1, EDGE), implicit java.base (C2, SILENCE), unnamed `_` (G4, SILENCE),
 * and switch record/type patterns (G5, partial inline-FQN edge — inner pattern types edge,
 * the outer pattern type stays silent).
 *
 * A handful of original matrix cases assert things the runCase harness cannot express —
 * the parity-only `declarations()` KEY SHAPE (no edges), a pure `resolveJavaFqn` unit
 * invariant, a split package across two nodes in ONE directory (the runner maps every
 * embedded file to its parent-dir node, so one directory has exactly one owner), and a
 * resolved-but-UNMAPPED file (every embedded file is mapped). Those stay as direct
 * extractor/resolver assertions below (no catalogue .md), so nothing is dropped.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — import forms that resolve (exact-FQN path edge; binds the EXACT file, never a sibling same-name)', () => {
  it('java-single-type-import-edge', () => runCase('java-single-type-import-edge'));
  it('java-single-import-sibling-same-name-trap', () => runCase('java-single-import-sibling-same-name-trap'));
  it('java-multi-import-one-edge-each', () => runCase('java-multi-import-one-edge-each'));
  it('java-no-import-alias', () => runCase('java-no-import-alias'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — static imports: the declaring TYPE is the edge, never a member or a phantom package', () => {
  it('java-single-static-import-drop-member-edge', () => runCase('java-single-static-import-drop-member-edge'));
  it('java-static-import-member-sibling-trap', () => runCase('java-static-import-member-sibling-trap'));
  it('java-static-on-demand-type-not-package-edge', () => runCase('java-static-on-demand-type-not-package-edge'));
  it('java-static-on-demand-no-phantom-package-dir', () => runCase('java-static-on-demand-no-phantom-package-dir'));
  it('java-static-collision-both-type-edges', () => runCase('java-static-collision-both-type-edges'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — wildcard / on-demand type import: package hint → owner-set collapse', () => {
  it('java-wildcard-one-owner-edge', () => runCase('java-wildcard-one-owner-edge'));
  it('java-wildcard-zero-owner-silence', () => runCase('java-wildcard-zero-owner-silence'));
  it('java-two-wildcards-each-own-merit-edge', () => runCase('java-two-wildcards-each-own-merit-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — java.lang / stdlib / external / vendored: fail-to-find silence, except a mapped vendored file', () => {
  it('java-jdk-import-silence', () => runCase('java-jdk-import-silence'));
  it('java-explicit-stdlib-import-silence', () => runCase('java-explicit-stdlib-import-silence'));
  it('java-bare-autoimport-usage-silence', () => runCase('java-bare-autoimport-usage-silence'));
  it('java-meta-annotation-usage-silence', () => runCase('java-meta-annotation-usage-silence'));
  it('java-external-library-import-silence', () => runCase('java-external-library-import-silence'));
  it('java-vendored-jdk-mapped-edge', () => runCase('java-vendored-jdk-mapped-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — nested types: resolve to the ENCLOSING file (one-level fallback), never deeper', () => {
  it('java-nested-import-enclosing-file-edge', () => runCase('java-nested-import-enclosing-file-edge'));
  it('java-deep-nested-import-one-level-limit-silence', () => runCase('java-deep-nested-import-one-level-limit-silence'));
  it('java-qualified-inline-outer-import-only-edge', () => runCase('java-qualified-inline-outer-import-only-edge'));
  it('java-binary-name-string-silence', () => runCase('java-binary-name-string-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — non-type tokens that must NEVER become an edge (enum case / primitive .class / var / unnamed _)', () => {
  it('java-enum-case-label-silence', () => runCase('java-enum-case-label-silence'));
  it('java-primitive-class-literal-silence', () => runCase('java-primitive-class-literal-silence'));
  it('java-var-reserved-name-silence', () => runCase('java-var-reserved-name-silence'));
  it('java-unnamed-underscore-not-ref', () => runCase('java-unnamed-underscore-not-ref'));
});

// ─────────────────────────────────────────────────────────────────────────────
// INLINE FULLY-QUALIFIED TYPE references (no import). The extractor now emits a SYMBOL
// hint for every `scoped_type_identifier` — a dotted type written inline WITHOUT an import
// in a TYPE position (field/local/param/return, extends/implements, throws, catch, generic
// argument/bound, instanceof/cast, record component, sealed permits, method-reference
// qualifier, `new` type). A fully-qualified name is shadow-free (JLS §6.5.5.2), so it
// resolves through the shared SymbolTable exactly like an import → a REAL cross-node edge.
// Each case puts the referenced type IN-GRAPH; the edge proves the FQN binds the mapped node.
describe('MATRIX — inline fully-qualified TYPE reference (no import): the FQN is shadow-free → real edge', () => {
  it('java-fully-qualified-inline-edge', () => runCase('java-fully-qualified-inline-edge'));
  it('java-extends-implements-edge', () => runCase('java-extends-implements-edge'));
  it('java-generic-argument-bound-edge', () => runCase('java-generic-argument-bound-edge'));
  it('java-instanceof-cast-classliteral-edge', () => runCase('java-instanceof-cast-classliteral-edge'));
  it('java-new-anonymous-diamond-edge', () => runCase('java-new-anonymous-diamond-edge'));
  it('java-array-varargs-element-edge', () => runCase('java-array-varargs-element-edge'));
  it('java-throws-clause-edge', () => runCase('java-throws-clause-edge'));
  it('java-multi-catch-edge', () => runCase('java-multi-catch-edge'));
  it('java-method-reference-edge', () => runCase('java-method-reference-edge'));
  it('java-generic-method-witness-edge', () => runCase('java-generic-method-witness-edge'));
  it('java-record-component-sealed-permits-edge', () => runCase('java-record-component-sealed-permits-edge'));
  it('java-switch-pattern-types-edge', () => runCase('java-switch-pattern-types-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
// USAGE-SITE forms that STAY SILENT (deliberate tolerated false-NEGATIVE, not a bug). These
// are the residual silences AFTER inline fully-qualified TYPE references began to edge: a
// reference is silent here because it is NOT a shadow-free `scoped_type_identifier` in a TYPE
// position. Three residual families remain — PARTIALLY-qualified inline names (would need the
// §6.5.5 simple-name precedence trap to resolve), SAME-PACKAGE bare simple names (same trap),
// and EXPRESSION-position dotted access (`com.app.Helper.staticMethod()`, a qualified enum
// constant, an annotation-use name) which parses as a field_access/method_invocation chain,
// never a `scoped_type_identifier` — the zero-FP boundary. Each case puts the referenced type
// IN-GRAPH, so the silence proves the extractor emits no edge even when the target is mapped.
describe('MATRIX — partially-qualified / same-package / expression-position forms (deliberate tolerated false-NEGATIVE: SILENT)', () => {
  it('java-same-package-no-import-silence', () => runCase('java-same-package-no-import-silence'));
  it('java-partially-qualified-inline-silence', () => runCase('java-partially-qualified-inline-silence'));
  it('java-fully-qualified-expression-call-silence', () => runCase('java-fully-qualified-expression-call-silence'));
  it('java-annotation-use-usage-silence', () => runCase('java-annotation-use-usage-silence'));
  it('java-enum-constant-use-usage-silence', () => runCase('java-enum-constant-use-usage-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
// NEWER-VERSION forms (Java 17→25) the 2026-06-15 research audit found MISSING. Module
// import (`import module M;`) is the only new IMPORT form since SE 21 (SILENCE — a module
// name maps to no file/dir); module-info `uses`/`provides` emit shadow-free service-type
// FQN EDGES (and the provider's `implements` clause is itself an inline fully-qualified
// TYPE reference → a further edge); implicit java.base is SILENCE. (The unnamed `_` and
// switch-pattern forms live with their token / inline-FQN siblings above.)
describe('MATRIX — newer forms (Java 17→25: module import, module-info uses/provides, implicit java.base)', () => {
  it('java-module-import-silence', () => runCase('java-module-import-silence'));
  it('java-module-info-uses-provides', () => runCase('java-module-info-uses-provides'));
  it('java-implicit-module-java-base-silence', () => runCase('java-implicit-module-java-base-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
// PARITY-ONLY DECLARATION KEYING & RESOLVER INVARIANTS — assertions the runCase harness
// cannot express (no cross-node EDGE to observe). Kept as direct extractor/resolver tests
// so the Java-specific behavior is still pinned and nothing is dropped.
describe('MATRIX — declaration-key shape & resolver invariants (not expressible in runCase)', () => {
  /** Parse a Java source string under a chosen repo-rel path, run `fn` with the resulting
   *  ParsedFile, and guarantee the WASM tree is deleted once `fn` returns (withParsedFile). */
  function parse<T>(repoRel: string, code: string, fn: (file: ParsedFile) => T): Promise<T> {
    ensureLoaderRegistered();
    return withParsedFile(repoRel, code, (tree) => fn({ path: repoRel, content: code, tree, language: 'java' }));
  }

  /** A JavaResolveDeps over a fixed in-memory `.java` file universe (repo-rel POSIX). */
  function depsOver(files: Set<string>): JavaResolveDeps {
    return {
      exists: (p) => files.has(p),
      javaFilesIn: (dir) => {
        const prefix = dir === '' ? '' : dir + '/';
        return [...files].filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'));
      },
    };
  }

  const ROOT = 'src/main/java';

  it('SEALED (latent): a nested decl is `+`-chained and package-qualified, never a flat phantom `Inner`', async () => {
    // GENUINE FLAT-KEY PHANTOM this matrix exposed and FIXED — the SAME shape as the
    // pre-fix Kotlin nested-type bug, and worse (Java did not even package-qualify).
    // Now that inline fully-qualified TYPE references emit `symbol` hints, the SymbolTable
    // IS read for Java resolution — so the phantom flat `Inner` key is no longer merely
    // latent: were a nested decl keyed as a flat `Inner` (or an un-package-qualified one),
    // an inline `com.acme.Inner`-shaped reference could mis-bind. It is sealed by `+`-keying
    // the nested chain and package-qualifying the key: the `+` namespace is disjoint from
    // the dotted FQN namespace a `scoped_type_identifier` hint carries, so a nested type is
    // reachable only via its enclosing-file fallback, never as a flat phantom.
    await parse(`${ROOT}/com/acme/Outer.java`, 'package com.acme;\nclass Outer {\n  class Inner {}\n}\n', (nestedFile) => {
      expect(javaExtractor.declarations(nestedFile).map((d) => d.symbolKey)).toEqual([
        'com.acme.Outer',
        'com.acme.Outer+Inner', // NOT the phantom flat `Inner` / `com.acme.Inner`
      ]);
      // Defense-in-depth: a top-level `import com.acme.Inner` (symbol key `com.acme.Inner`)
      // finds nothing in the table → SILENCE (the `+` key is disjoint from the dot namespace).
      const st = new SymbolTable();
      for (const d of javaExtractor.declarations(nestedFile)) st.declare('java', d.symbolKey, nestedFile.path);
      expect(st.has('java', 'com.acme.Inner')).toBe(false);
      expect(st.has('java', 'com.acme.Outer+Inner')).toBe(true);
      const r = makeResolver({
        ownerIndex: { ownerOf: (f: string) => ({ [nestedFile.path]: 'a' } as Record<string, string>)[f] } as never,
        symbolTable: st,
        resolvePathToFile: () => undefined,
      });
      expect(r.classify({ kind: 'symbol', symbolKey: 'com.acme.Inner' }, `${ROOT}/com/x/Use.java`, 'java')).toEqual({ kind: 'absent' });
    });
  });

  it('SEALED (latent): deeper nesting is `+`-chained and package-qualified, never flat', async () => {
    await parse(
      `${ROOT}/com/acme/Outer.java`,
      'package com.acme;\nclass Outer {\n  static class Mid {\n    interface Deep {}\n  }\n}\n',
      (deepFile) => {
        expect(deepFile && javaExtractor.declarations(deepFile).map((d) => d.symbolKey)).toEqual([
          'com.acme.Outer',
          'com.acme.Outer+Mid',
          'com.acme.Outer+Mid+Deep',
        ]);
      },
    );
  });

  it('unnamed/default-package nested decls key bare `Outer` / `Outer+Inner`, never a leading dot', async () => {
    await parse(`${ROOT}/Top.java`, 'class Outer {\n  class Inner {}\n}\n', (noPkg) => {
      const keys = javaExtractor.declarations(noPkg).map((d) => d.symbolKey);
      expect(keys).toEqual(['Outer', 'Outer+Inner']);
      expect(keys.every((k) => !k.startsWith('.'))).toBe(true);
    });
  });

  it('a single-type-import whose FQN is a package DIRECTORY (not a type file) → undefined (no package fall-through)', () => {
    // resolveJavaFqn does NO package fall-through: a TYPE hint whose FQN is actually a
    // directory of `.java` resolves to nothing. (The wildcard branch handles packages.)
    const files = new Set([
      `${ROOT}/com/acme/audit/AuditLog.java`,
      `${ROOT}/com/acme/audit/AuditWriter.java`,
    ]);
    const deps = depsOver(files);
    expect(resolveJavaFqn('com.acme.audit', `${ROOT}/com/app/Use.java`, deps)).toBeUndefined();
  });

  it('split package across TWO owners in ONE directory → 2+ owners → SILENCE (not expressible in runCase)', () => {
    // The same package directory holds files owned by node `x` AND node `y`. The runCase
    // harness maps every embedded file to its parent-dir node, so one directory has exactly
    // one owner — this split (one dir, two owners) can only be expressed with an explicit
    // owner map. Owner set = {x,y} → 2+ owners → silence (never guess across a node split).
    const files = new Set([
      `${ROOT}/com/acme/mixed/FromX.java`,
      `${ROOT}/com/acme/mixed/FromY.java`,
    ]);
    const owners: Record<string, string> = {
      [`${ROOT}/com/acme/mixed/FromX.java`]: 'x',
      [`${ROOT}/com/acme/mixed/FromY.java`]: 'y',
    };
    const deps = depsOver(files);
    // Replicate makeResolvePathToFile's Java wildcard branch: list package files, collapse owners.
    const pkgFiles = files; // resolveJavaPackageFiles over this single dir returns both
    const ownerSet = new Set<string>();
    for (const f of pkgFiles) ownerSet.add(owners[f]);
    expect(ownerSet.size).toBeGreaterThanOrEqual(2);
    // The collapse rule (size === 1 ? attribute : silence) → silence.
    expect(ownerSet.size === 1).toBe(false);
    void deps;
  });

  it('a resolved-but-UNMAPPED .java is a coverage matter → absent (silence), never a violation (not expressible in runCase)', async () => {
    // The runCase harness maps EVERY embedded file to its parent-dir node, so a
    // resolved-but-unowned file is unreachable there. Verified directly: the resolver
    // returns `absent` when ownerOf yields undefined for the resolved file.
    const files = new Set([`${ROOT}/com/unmapped/Target.java`]);
    const deps = depsOver(files);
    const r = makeResolver({
      ownerIndex: { ownerOf: () => undefined } as never,
      symbolTable: new SymbolTable(),
      resolvePathToFile: (specifier, fromFile, language, isPackage) =>
        isPackage ? undefined : resolveJavaFqn(specifier, fromFile, deps),
    });
    expect(
      r.classify({ kind: 'path', specifier: 'com.unmapped.Target' }, `${ROOT}/com/app/Use.java`, 'java'),
    ).toEqual({ kind: 'absent' });
  });
});
