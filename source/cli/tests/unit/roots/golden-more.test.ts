import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRootsIndex, parseAndExtractAll } from '../../../src/roots/pipeline.js';
import { assertGoldenBundleEquivalence } from '../../support/roots-golden.js';
import { withBuiltGolden } from '../helpers/roots-golden-fixture.js';
import { withHistoryDeps } from '../helpers/roots-history-deps.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import { buildTsxGoldenSpec } from '../../fixtures/roots/golden/tsx/spec.js';
import { buildJavaScriptGoldenSpec } from '../../fixtures/roots/golden/javascript/spec.js';
import { buildJavaGoldenSpec } from '../../fixtures/roots/golden/java/spec.js';
import { buildGoGoldenSpec } from '../../fixtures/roots/golden/go/spec.js';
import type { GoldenRepoSpec } from '../../support/roots-golden.js';
import type { RootsConfig } from '../../../src/model/graph.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/golden-more.test.ts — the four "simple" code goldens
// (tsx, javascript, java, go): sibling to golden.test.ts (the typescript
// golden, which carries the two review-inherited requirements — the exact
// candidateCountLog2 hand-count and the forParsing live round-trip — that
// need not repeat here) purely for reviewer-prompt headroom, per Task 7's
// own hard rule against growing an existing roots test file past its
// current size. Each golden gets: builder<->bundle equivalence, its own
// 300-scope-floor-with-margin sizing pin, and a MUST-mine/MUST-NOT-mine
// pair matching its own spec.ts (read alongside this file — each golden's
// header documents WHY its own surfaces converge or don't).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_ROOT = path.join(__dirname, '../../fixtures/roots/golden');

function bundlePathFor(name: string): string {
  return path.join(GOLDEN_ROOT, name, `${name}.bundle`);
}

async function factsOf(spec: GoldenRepoSpec, config: RootsConfig) {
  return withBuiltGolden(spec, async (repoRoot) => {
    const result = await withHistoryDeps((options) => runRootsIndex(repoRoot, config, [], options));
    return result.body.partitions.flatMap((p) => p.facts);
  });
}

describe('golden: tsx', () => {
  it('builder spec matches the committed bundle', () => {
    expect(() => assertGoldenBundleEquivalence(buildTsxGoldenSpec(), bundlePathFor('tsx'))).not.toThrow();
  });

  it('clears the 300-scope floor with real margin (400 raw scopes: 100 files * (1 type + 2 method + 1 file))', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildTsxGoldenSpec(), async (repoRoot) => {
      const { rawScopes } = await parseAndExtractAll(repoRoot, config);
      expect(rawScopes.length).toBe(400);
    });
  });

  it('MUST-mine: the uniform console.log call convention across every method (both exec<i>_0/exec<i>_1 call it identically — unlike the typescript golden, tsx carries no dedup-avoidance split, since this golden makes no alphabets-union claim). MUST-NOT-mine: the deliberate 50/50 arity split', async () => {
    const config = await defaultRootsConfig();
    const facts = await factsOf(buildTsxGoldenSpec(), config);
    expect(facts.some((f) => f.surface === 'auto.call:console.log' && f.appliesKind === 'method' && f.expected === 'true')).toBe(true);
    expect(facts.some((f) => f.surface === 'auto.arity')).toBe(false);
  });
});

describe('golden: javascript', () => {
  it('builder spec matches the committed bundle', () => {
    expect(() => assertGoldenBundleEquivalence(buildJavaScriptGoldenSpec(), bundlePathFor('javascript'))).not.toThrow();
  });

  it('clears the 300-scope floor with real margin (400 raw scopes)', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildJavaScriptGoldenSpec(), async (repoRoot) => {
      const { rawScopes } = await parseAndExtractAll(repoRoot, config);
      expect(rawScopes.length).toBe(400);
    });
  });

  it('MUST-mine: the uniform console.log call convention. MUST-NOT-mine: the deliberate 50/50 arity split', async () => {
    const config = await defaultRootsConfig();
    const facts = await factsOf(buildJavaScriptGoldenSpec(), config);
    expect(facts.some((f) => f.surface === 'auto.call:console.log' && f.appliesKind === 'method' && f.expected === 'true')).toBe(true);
    expect(facts.some((f) => f.surface === 'auto.arity')).toBe(false);
  });
});

describe('golden: java', () => {
  it('builder spec matches the committed bundle', () => {
    expect(() => assertGoldenBundleEquivalence(buildJavaGoldenSpec(), bundlePathFor('java'))).not.toThrow();
  });

  it('clears the 300-scope floor with real margin (400 raw scopes)', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildJavaGoldenSpec(), async (repoRoot) => {
      const { rawScopes } = await parseAndExtractAll(repoRoot, config);
      expect(rawScopes.length).toBe(400);
    });
  });

  it('MUST-mine: the uniform method-body shape (every method\'s first statement is the System.out.println call — design §6.2\'s own "Java required zero lines of language-specific code" verification, exercised here as a golden rather than a prototype log). Spec §9.4e\'s dedup folds the perfectly-correlated `auto.call:System.out.println`/`auto.has:*`/`auto.nameshape` surfaces into this ONE lead fact (`nSurfaces > 1` is the visible proof) rather than emitting each separately — the SAME mechanism `golden.test.ts`\'s own header documents for the typescript golden. MUST-NOT-mine: the deliberate 50/50 arity split', async () => {
    const config = await defaultRootsConfig();
    const facts = await factsOf(buildJavaGoldenSpec(), config);
    const first1 = facts.find((f) => f.surface === 'auto.first1' && f.appliesKind === 'method');
    expect(first1?.expected).toBe('expression_statement');
    expect(first1?.nSurfaces).toBeGreaterThan(1);
    expect(facts.some((f) => f.surface === 'auto.arity')).toBe(false);
  });
});

describe('golden: go', () => {
  it('builder spec matches the committed bundle', () => {
    expect(() => assertGoldenBundleEquivalence(buildGoGoldenSpec(), bundlePathFor('go'))).not.toThrow();
  });

  it('clears the 300-scope floor with real margin (450 raw scopes: 150 files * (2 method + 1 file) — Go has no `type`-kind scope at all, per spec §6.2\'s container/leaf rule: a Go function_declaration never contains a nested scope)', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildGoGoldenSpec(), async (repoRoot) => {
      const { rawScopes } = await parseAndExtractAll(repoRoot, config);
      expect(rawScopes.length).toBe(450);
      expect(rawScopes.some((s) => s.kind === 'type')).toBe(false);
    });
  });

  it('MUST-mine: the uniform fmt.Println call convention (§9.4e dedup folds the co-occurring `auto.has:*`/`auto.stshape`/`auto.first1`/`auto.nameshape` surfaces into this same lead fact — `nSurfaces > 1` is the visible proof, the same mechanism as the java golden above; Go yields no `auto.imp:*` surfaces at all under the ported extractor — see go/spec.ts). MUST-NOT-mine: the deliberate 50/50 arity split', async () => {
    const config = await defaultRootsConfig();
    const facts = await factsOf(buildGoGoldenSpec(), config);
    const call = facts.find((f) => f.surface === 'auto.call:fmt.Println' && f.appliesKind === 'method');
    expect(call?.expected).toBe('true');
    expect(call?.nSurfaces).toBeGreaterThan(1);
    expect(facts.some((f) => f.surface === 'auto.arity')).toBe(false);
  });
});
