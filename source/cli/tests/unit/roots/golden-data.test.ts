import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRootsIndex, parseAndExtractAll } from '../../../src/roots/pipeline.js';
import { assertGoldenBundleEquivalence } from '../../support/roots-golden.js';
import { withBuiltGolden } from '../helpers/roots-golden-fixture.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import { buildDataGoldenSpec } from '../../fixtures/roots/golden/data/spec.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/golden-data.test.ts — the seventh, data-mixed golden
// (design §5.4, `integration-design.md:210-216`): asserts BOTH halves the
// design names — MUST-mine on the file/module surfaces (shared across data
// AND code files alike) and MUST-NOT-mine on every scope-level enumerator
// over the data files specifically. See
// tests/fixtures/roots/golden/data/spec.ts's own header for the full
// content/sizing rationale.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '../../fixtures/roots/golden/data/data.bundle');
const DATA_FILE_RE = /\.(json|yaml|toml)$/;

describe('golden: data — builder spec <-> committed bundle equivalence', () => {
  it('the committed bundle still matches what the builder spec produces', () => {
    expect(() => assertGoldenBundleEquivalence(buildDataGoldenSpec(), BUNDLE_PATH)).not.toThrow();
  });
});

describe('golden: data — MUST-NOT-mine: no scope-level enumerator ever fires over a data file (design §5.4\'s structural guarantee)', () => {
  it('clears spec §6.8\'s 300-scope floor with real margin (440 raw scopes: 40 packages * (2 code files * 4 scopes + 3 data files * 1 scope) = 440, a 46% margin over the 300 floor)', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildDataGoldenSpec(), async (repoRoot) => {
      const { rawScopes } = await parseAndExtractAll(repoRoot, config);
      expect(rawScopes.length).toBe(440);
    });
  });

  it('every .json/.yaml/.toml RawScope is `file` kind — NEVER `method` or `type` — verified directly against parseAndExtractAll\'s own output, not merely inferred from the absence of a fact (json/yaml/toml\'s committed binding snapshots pin an empty scope-node-type set, so this is a structural guarantee, not a statistical one)', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildDataGoldenSpec(), async (repoRoot) => {
      const { rawScopes } = await parseAndExtractAll(repoRoot, config);
      const dataFileScopes = rawScopes.filter((s) => DATA_FILE_RE.test(s.relPath));
      expect(dataFileScopes.length).toBeGreaterThan(0); // the data files really were walked and parsed
      expect(dataFileScopes.every((s) => s.kind === 'file')).toBe(true);
      expect(dataFileScopes.some((s) => (s.kind as string) === 'method' || (s.kind as string) === 'type')).toBe(false);
    });
  });
});

describe('golden: data — MUST-mine: file/module surfaces, shared across code AND data files alike (design §5.4)', () => {
  it('mines auto.filenameshape at 100% share — every file in the repo (both the two .ts files and the three data files per package) shares the identical single-letter basename shape', async () => {
    const config = await defaultRootsConfig();
    const facts = await withBuiltGolden(buildDataGoldenSpec(), async (repoRoot) => {
      const result = await runRootsIndex(repoRoot, config, []);
      return result.body.partitions.flatMap((p) => p.facts);
    });
    const filenameshape = facts.find((f) => f.surface === 'auto.filenameshape' && f.appliesKind === 'file');
    expect(filenameshape?.expected).toBe('a');
    expect(filenameshape?.share).toBe(1);
  });

  it('mines an E12 module-level fact (auto.moddirshape) at 100% share — every one of the 40 package directories resolves its own module scope (5 direct files each clears MIN_MODULE_CODE_FILES) and shares the identical directory-name shape', async () => {
    const config = await defaultRootsConfig();
    const facts = await withBuiltGolden(buildDataGoldenSpec(), async (repoRoot) => {
      const result = await runRootsIndex(repoRoot, config, []);
      return result.body.partitions.flatMap((p) => p.facts);
    });
    const moddirshape = facts.find((f) => f.surface === 'auto.moddirshape' && f.appliesKind === 'module');
    expect(moddirshape?.expected).toBe('a');
    expect(moddirshape?.share).toBe(1);
  });

  it('mines the code half\'s own conventions too (the golden genuinely MIXES data with code, not merely coexists): the uniform console.log call convention and the Handler type\'s nameshape', async () => {
    const config = await defaultRootsConfig();
    const facts = await withBuiltGolden(buildDataGoldenSpec(), async (repoRoot) => {
      const result = await runRootsIndex(repoRoot, config, []);
      return result.body.partitions.flatMap((p) => p.facts);
    });
    expect(facts.some((f) => f.surface === 'auto.call:console.log' && f.appliesKind === 'method' && f.expected === 'true')).toBe(true);
    expect(facts.some((f) => f.surface === 'auto.nameshape' && f.appliesKind === 'type' && f.expected === 'Ua')).toBe(true);
  });
});
