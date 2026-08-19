import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { readNodeTypes } from '../../../src/ast/node-types.js';
import { deriveBinding, bindingHash, isDecorationMarkerText, isWithinDecorationWindow } from '../../../src/roots/binding.js';
import { LANGUAGES } from '../../../src/utils/language-registry.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/binding.test.ts — spec §6.2 binding derivation, pinned
// against committed per-grammar snapshots (tests/fixtures/roots/bindings/),
// the node-types.json disk loader's happy and loud-failure paths, and the
// two extraction-time helpers (the lexical @/[ marker, the decoration
// attribution window) Task 4's extract.ts consumes rather than re-deriving.
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(__dirname, '../../fixtures/roots/bindings');

/** Grammar asset name from a registry `wasmFile` — strips the fixed prefix/suffix (design `integration-design.md:174-177`). */
function assetNameOf(wasmFile: string): string {
  return wasmFile.replace(/^tree-sitter-/, '').replace(/\.wasm$/, '');
}

const ALL_ASSETS = [...new Set(Object.values(LANGUAGES).map(def => assetNameOf(def.wasmFile)))].sort();

function loadFixture(asset: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, `${asset}.json`), 'utf8'));
}

describe('deriveBinding — 16 committed per-grammar snapshots (spec §6.2)', () => {
  for (const asset of ALL_ASSETS) {
    it(`${asset}: fresh derivation equals the committed snapshot`, () => {
      const binding = deriveBinding(readNodeTypes(asset));
      expect(binding).toEqual(loadFixture(asset));
    });
  }

  // The three DATA grammars (json/yaml/toml) yield no name+body node types by
  // construction — design §5.4 rests on this emptiness as the mechanism that
  // routes them to file/module-level facts only, not as an error condition.
  for (const dataAsset of ['json', 'yaml', 'toml']) {
    it(`${dataAsset}: data grammar derives an EMPTY scope set (design §5.4's mechanism, not an error)`, () => {
      const binding = deriveBinding(readNodeTypes(dataAsset));
      expect(binding.scope).toEqual([]);
    });
  }

  // Measured, not assumed: this shipped kotlin grammar's `class_declaration`/
  // `function_declaration` node types declare a `name` FIELD but expose their
  // body only as an unnamed positional child (`class_body`/`function_body`
  // under `children`, never a `body` FIELD) — verified directly against
  // dist/grammars/tree-sitter-kotlin.node-types.json. Spec §6.2's scope rule
  // requires BOTH fields to be declared, so this grammar derives zero scope
  // node types under the fixed rule, exactly like a data grammar — spec §6.2's
  // own fallback ("a grammar that yields an empty scope set is disabled for
  // the session with one incident") is the documented handling for this
  // outcome, applied wherever a mining pipeline consumes this binding.
  // Pinned here so a future grammar-package upgrade that adds a
  // `body` field is a visible, deliberate snapshot change rather than a silent
  // capability gain.
  it('kotlin: the shipped grammar version derives an empty scope set (verified node-types.json shape, not a data grammar)', () => {
    const binding = deriveBinding(readNodeTypes('kotlin'));
    expect(binding.scope).toEqual([]);
    expect(binding.decorators.length).toBeGreaterThan(0); // annotation/file_annotation still derive — only scope is empty
  });
});

describe('readNodeTypes — build assertion: every registry grammar resolves a readable node-types.json in dist/grammars/', () => {
  for (const [registryId, def] of Object.entries(LANGUAGES)) {
    it(`${registryId} (${def.wasmFile}) resolves`, () => {
      const nodeTypes = readNodeTypes(assetNameOf(def.wasmFile));
      expect(Array.isArray(nodeTypes)).toBe(true);
    });
  }
});

describe('readNodeTypes — loud failure when neither candidate directory has the file', () => {
  it('throws naming the build command, using the injected candidate list (not the real dist/grammars/)', async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), 'yg-roots-node-types-empty-'));
    try {
      expect(() => readNodeTypes('not-a-real-grammar', [emptyDir])).toThrow(/npm run build/);
      expect(() => readNodeTypes('not-a-real-grammar', [emptyDir])).toThrow(/tree-sitter-not-a-real-grammar\.node-types\.json/);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('tries every candidate directory in order before throwing', async () => {
    const d1 = mkdtempSync(path.join(tmpdir(), 'yg-roots-node-types-a-'));
    const d2 = mkdtempSync(path.join(tmpdir(), 'yg-roots-node-types-b-'));
    try {
      expect(() => readNodeTypes('missing', [d1, d2])).toThrow(new RegExp(`${d1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*${d2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });

  it('the real default candidate dirs resolve a known-good grammar (no injected list)', () => {
    // No second argument — exercises defaultNodeTypesCandidateDirs()'s own
    // package.json walk-up, the branch the two tests above (which inject a
    // fake candidate list) do not reach.
    expect(() => readNodeTypes('python')).not.toThrow();
  });
});

describe('bindingHash — pure, stable content hash of a derived binding', () => {
  it('is stable across repeated derivations of the same grammar', () => {
    const a = deriveBinding(readNodeTypes('python'));
    const b = deriveBinding(readNodeTypes('python'));
    expect(bindingHash(a)).toBe(bindingHash(b));
  });

  it('changes when any set member changes', () => {
    const binding = deriveBinding(readNodeTypes('python'));
    const mutated = { ...binding, scope: [...binding.scope, 'a_node_type_that_does_not_exist'] };
    expect(bindingHash(mutated)).not.toBe(bindingHash(binding));
  });

  it('is independent of the field order the RootsBinding object literal happens to use', () => {
    const binding = deriveBinding(readNodeTypes('python'));
    const reordered = {
      heritagePattern: binding.heritagePattern,
      decorators: binding.decorators,
      imports: binding.imports,
      scope: binding.scope,
    };
    expect(bindingHash(reordered)).toBe(bindingHash(binding));
  });

  it('differs between two different grammars', () => {
    const py = deriveBinding(readNodeTypes('python'));
    const go = deriveBinding(readNodeTypes('go'));
    expect(bindingHash(py)).not.toBe(bindingHash(go));
  });
});

// ---------------------------------------------------------------------------
// The marker rule, unit-level (spec §6.2). Table-driven across the six
// measured grammars' decorator kinds — Go included as the negative case: its
// grammar has no decorator-family node type at all (verified directly against
// dist/grammars/tree-sitter-go.node-types.json), matching the design's note
// that Go needed zero lines of language-specific code because its own
// conventions (e.g. `NewRouter` construction) are mined through other
// enumerators entirely, never through decorators.
// ---------------------------------------------------------------------------
const MEASURED_DECORATOR_KINDS: {
  asset: string;
  nodeType: string | null;
  markerPassingText: string | null;
}[] = [
  { asset: 'typescript', nodeType: 'decorator', markerPassingText: '@Component' },
  { asset: 'tsx', nodeType: 'decorator', markerPassingText: '@Component' },
  { asset: 'javascript', nodeType: 'decorator', markerPassingText: '@observable' },
  { asset: 'python', nodeType: 'decorator', markerPassingText: '@staticmethod' },
  { asset: 'java', nodeType: 'marker_annotation', markerPassingText: '@Override' },
  { asset: 'go', nodeType: null, markerPassingText: null },
];

describe('the marker rule, unit-level — six measured grammars\' decorator kinds', () => {
  for (const { asset, nodeType, markerPassingText } of MEASURED_DECORATOR_KINDS) {
    if (nodeType === null) {
      it(`${asset}: has no decorator-family node type at all (grammar-name binding is legitimately empty)`, () => {
        const binding = deriveBinding(readNodeTypes(asset));
        expect(binding.decorators).toEqual([]);
      });
      continue;
    }
    it(`${asset}: '${nodeType}' is bound as a decorator-family node type, and its real source text passes the lexical marker`, () => {
      const binding = deriveBinding(readNodeTypes(asset));
      expect(binding.decorators).toContain(nodeType);
      expect(isDecorationMarkerText(markerPassingText as string)).toBe(true);
      // Realistic leading whitespace (grammar source text keeps a node's own
      // indentation as part of its text range in some positions) must not
      // defeat the marker — the rule trims leading whitespace first.
      expect(isDecorationMarkerText(`  \n  ${markerPassingText}`)).toBe(true);
    });
  }

  // MANDATORY CASE (a): TypeScript's `type_annotation` node type satisfies the
  // decorator name regex (`/decorator|annotation|attribute_list/` matches the
  // substring "annotation"); the lexical `@`/`[` marker filters it, because a
  // real type annotation's own source text never starts with `@` or `[`. This
  // is the exact real defect the prototype's verification measured on a real
  // repo (`2026-08-17-yg-roots-prototype-report.md`'s decorator-binding
  // over-match finding: a field's type, `queue: fastq.queueAsPromised<…>`,
  // was mined as a decorator before the marker rule existed).
  it("MANDATORY (a): TypeScript's type_annotation matches the decorator name regex; the lexical @/[ marker filters it", () => {
    const binding = deriveBinding(readNodeTypes('typescript'));
    expect(binding.decorators).toContain('type_annotation'); // the grammar-name over-match, confirmed present
    expect(isDecorationMarkerText(': fastq.queueAsPromised<Job>')).toBe(false); // a real type annotation's own text
    expect(isDecorationMarkerText('@Component')).toBe(true); // contrast: a real decorator's own text passes
  });

  // MANDATORY CASE (b): a stacked decorator physically written above a
  // PRECEDING class member must not attach to the FOLLOWING scope. Scenario:
  // method A ends at row 10 (this becomes the next scope's `loRow`); method B
  // (the scope under test) declares its body starting at row 15 (`bodyRow`).
  // A decorator written above method A, at row 3, belongs to method A, not
  // method B — the window's lower bound (strictly after `loRow`) is what
  // excludes it (`prototype-roots2.mjs:85-87`'s stated purpose: never
  // attribute a preceding member's — or the enclosing class's earlier
  // members' — decorators to a later scope).
  it('MANDATORY (b): a stacked decorator above a PRECEDING member does not attach to the following scope', () => {
    const loRow = 10; // end row of method A (the previous non-decoration, non-comment sibling)
    const bodyRow = 15; // start row of method B's own body
    expect(isWithinDecorationWindow(3, loRow, bodyRow)).toBe(false); // above method A entirely — method A's decorator
    expect(isWithinDecorationWindow(loRow, loRow, bodyRow)).toBe(false); // AT loRow — lower bound is strict/open
    expect(isWithinDecorationWindow(11, loRow, bodyRow)).toBe(true); // just after loRow — attaches to method B
    expect(isWithinDecorationWindow(12, loRow, bodyRow)).toBe(true); // a stack of any height between loRow and bodyRow attaches in full
    expect(isWithinDecorationWindow(13, loRow, bodyRow)).toBe(true);
    expect(isWithinDecorationWindow(bodyRow, loRow, bodyRow)).toBe(true); // AT bodyRow — upper bound is closed (parameter-level annotations)
    expect(isWithinDecorationWindow(16, loRow, bodyRow)).toBe(false); // past the body start — outside the window
  });
});

describe('deriveBinding — the underscore-prefix import exclusion, pinned directly', () => {
  // No shipped grammar declares an `_`-prefixed import-ish node type, so the 16
  // snapshots can never exercise this spec rule: hidden (underscore-prefixed)
  // node types matching the import-name pattern must NOT join the imports set.
  // deriveBinding is pure over the node-types array, so a direct call pins it.
  it('an _-prefixed node type matching the import pattern is excluded; the visible one is kept', () => {
    const binding = deriveBinding([
      { type: '_import_list' },
      { type: 'import_statement' },
    ]);
    expect(binding.imports).toEqual(['import_statement']);
  });
});
