import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withParsedFile } from '../../../src/ast/parser.js';
import { readNodeTypes } from '../../../src/ast/node-types.js';
import { deriveBinding } from '../../../src/roots/binding.js';
import { extractUnits } from '../../../src/roots/extract.js';
import { parseAndExtractAll, runRootsIndex } from '../../../src/roots/pipeline.js';
import { assertGoldenBundleEquivalence } from '../../support/roots-golden.js';
import { withBuiltGolden } from '../helpers/roots-golden-fixture.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import { buildTypeScriptGoldenSpec } from '../../fixtures/roots/golden/typescript/spec.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/golden.test.ts — the TypeScript golden (Task 7, R1's
// scope: the six prototype-measured code grammars + the data golden; the
// remaining seven code-grammar goldens are R10's, per this plan's own
// boundary note). UNIT-level: every assertion reads `MinedModel` shapes
// in-process through `runRootsIndex` — the spawned-CLI proof over the SAME
// bundles is Task 8's (`e2e-public-surface` forbids any `src/**` import
// from `tests/e2e/`, so that proof cannot live here).
//
// This is the ONE golden carrying two review-inherited requirements that
// need not repeat on every golden: the exact `candidateCountLog2` hand-count
// pin, and the live forParsing round-trip (the "files named like tests mine
// nothing" control, validated by contrast against a bypassed-filter branch
// rather than merely asserting an empty result that could as well be a
// parse failure). See `tests/fixtures/roots/golden/typescript/spec.ts` for
// the full content/sizing rationale this file's assertions depend on.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '../../fixtures/roots/golden/typescript/typescript.bundle');

describe('golden: typescript — builder spec <-> committed bundle equivalence', () => {
  it('the committed bundle still matches what the builder spec produces', () => {
    expect(() => assertGoldenBundleEquivalence(buildTypeScriptGoldenSpec(), BUNDLE_PATH)).not.toThrow();
  });
});

describe('golden: typescript — MUST-mine / MUST-NOT-mine (design §13.2)', () => {
  it('mines auto.nameshape for BOTH type and method kinds (the alphabets-union regression guard: a per-kind alphabet-overwrite bug would silently drop one of these two, or §9.4e dedup collapsing method-kind nameshape into an unrelated body-shaped lead would silently drop the method-kind half — see spec.ts\'s own header for why exec<i>_0/exec<i>_1\'s bodies deliberately diverge); never mines the deliberately 50/50 arity surface', async () => {
    const spec = buildTypeScriptGoldenSpec();
    const config = await defaultRootsConfig();
    await withBuiltGolden(spec, async (repoRoot) => {
      const result = await runRootsIndex(repoRoot, config, []);
      expect(result.body.partitions.length).toBeGreaterThan(0);
      const facts = result.body.partitions.flatMap((p) => p.facts);

      // MUST-mine — the alphabets-union regression guard: BOTH kinds' own
      // auto.nameshape fact must independently survive scoring, dedup and
      // culling. Values are pinned too (`nameShape`'s own char-class fold is
      // deterministic over this golden's fixed literal names): 'Handler<i>'
      // -> 'Ua', 'exec<i>_0'/'exec<i>_1' -> 'a_a'.
      const typeNameshape = facts.find((f) => f.surface === 'auto.nameshape' && f.appliesKind === 'type');
      const methodNameshape = facts.find((f) => f.surface === 'auto.nameshape' && f.appliesKind === 'method');
      expect(typeNameshape?.expected).toBe('Ua');
      expect(typeNameshape?.roleKey).toBe('_all');
      expect(methodNameshape?.expected).toBe('a_a');
      expect(methodNameshape?.roleKey).toBe('_all');

      // MUST-NOT-mine — the spec's own deliberate 50/50 split (exec<i>_0
      // takes 0 params, exec<i>_1 takes 1) never clears any acceptable
      // margin at the partition level (a near-coin-flip data_term, per
      // Appendix E.3 S2/S5).
      expect(facts.some((f) => f.surface === 'auto.arity')).toBe(false);

      // Review-inherited requirement (d): `deviantsN` is the RAW
      // non-conforming count (Appendix D's own worked record), not
      // `nTotalRaw - nConformRaw` (mine-invariants.test.ts's H2 fix). The
      // spec's own deliberate minority deviation — every 20th package's
      // exec<i>_0 returns a string instead of a number (5 of the 100
      // exec<i>_0-only `auto.ret` population) — gives this a real,
      // hand-derivable non-zero value: 5 raw instances differ from
      // `expected`, not 0.
      const retFact = facts.find((f) => f.surface === 'auto.ret' && f.appliesKind === 'method');
      expect(retFact?.expected).toBe('number');
      expect(retFact?.deviantsN).toBe(5);
    });
  });

  it('the golden clears spec §6.8\'s 300-scope partition floor with real margin — the merged bucket has 400 raw (named-body + file) scopes against the 300 floor, not a boundary landing', async () => {
    const spec = buildTypeScriptGoldenSpec();
    const config = await defaultRootsConfig();
    await withBuiltGolden(spec, async (repoRoot) => {
      const { files, rawScopes } = await parseAndExtractAll(repoRoot, config);
      // decoy.test.ts is walked (forMarkers admits it) but never parsed
      // (forParsing drops it) — it contributes to `files` but not `rawScopes`.
      expect(files).toContain('src/mod0/decoy.test.ts');
      expect(rawScopes.length).toBe(400); // 100 files * (1 type + 2 method + 1 file)
      expect(rawScopes.length).toBeGreaterThan(300); // the §6.8 floor claim itself — 400 raw scopes give 33% real margin
    });
  });
});

describe('golden: typescript — the forParsing exclusion control is a live round-trip, not a vacuous negative (review-inherited requirement)', () => {
  it('decoy.test.ts (spec §6.8\'s *.test.* mining exclusion) is dropped by the real pipeline, but the SAME content parsed directly via extractUnits (bypassing forParsing entirely) DOES yield real method scopes — proving the negative above is the filter doing real work, not an empty/unparseable file passing trivially', async () => {
    const spec = buildTypeScriptGoldenSpec();
    const decoyContent = spec.commits[0].files['src/mod0/decoy.test.ts'];
    expect(decoyContent).toBeDefined();

    const config = await defaultRootsConfig();
    await withBuiltGolden(spec, async (repoRoot) => {
      const { rawScopes } = await parseAndExtractAll(repoRoot, config);
      expect(rawScopes.some((s) => s.relPath === 'src/mod0/decoy.test.ts')).toBe(false);
    });

    // The "filter removed" branch: extractUnits has no forParsing knowledge
    // at all — calling it directly on the IDENTICAL content is what the
    // pipeline would see if the mining-only test-pattern exclusion did not
    // exist.
    const binding = deriveBinding(readNodeTypes('typescript'));
    const bypassedScopes = await withParsedFile('src/mod0/decoy.test.ts', decoyContent as string, (tree) =>
      extractUnits('src/mod0/decoy.test.ts', decoyContent as string, tree, binding),
    );
    expect(bypassedScopes.some((s) => s.kind === 'method' && s.name === 'shouldNeverMine')).toBe(true);
  });
});

describe('golden: typescript — candidateCountLog2 pin, hand-counted (review-inherited requirement)', () => {
  it('C = 8 exactly under a support override that empties every one of the six vocabulary-bearing enumerators (nodeType/call/decorator/import/supertype/shape survive at their default population but never clear an astronomically high support floor) — the surviving candidate universe is EXACTLY: _all:type{auto.nameshape}=1, _all:method{auto.nameshape,auto.arity,auto.first1,auto.ret}=4, _all:file{auto.filenameshape,auto.dir1,auto.dir2}=3, _all:module{}=0 (no directory resolves >=3 direct files, so no E12 surface is ever emitted); no role or directory cells exist (every scope has exactly one name-token own-feature, below roles.minOwnFeatures=2, and no directory clears mdl.dirContextMinScopes=25 while staying strictly under its kind\'s whole-partition population). C=8 -> C2=8 (already a power of two) -> candidateCountLog2 = ceil(log2(8)) = 3', async () => {
    const spec = buildTypeScriptGoldenSpec();
    const config = await defaultRootsConfig(
      'enumerate:\n    support: { nodeType: 999999999, call: 999999999, import: 999999999, supertype: 999999999, shape: 999999999, decorator: 999999999 }\n',
    );
    await withBuiltGolden(spec, async (repoRoot) => {
      const result = await runRootsIndex(repoRoot, config, []);
      expect(result.candidateCountLog2).toBe(3);
    });
  });
});
