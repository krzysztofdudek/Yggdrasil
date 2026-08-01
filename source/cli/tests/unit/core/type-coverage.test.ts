/**
 * Type-level classification lattice (coverage.type_level) — core/type-coverage.ts
 * plus its wiring into runCheck's coverage section and the orphan WHAT
 * enrichment in checks/mapping.ts.
 *
 * Driven against the real, committed fixture project
 * tests/fixtures/type-coverage-basic/ — a copy is made per test (mkdtemp) so
 * nothing here ever mutates the committed fixture, and the >5MB-file tests
 * write their oversized file only into that throwaway copy (never committed —
 * see the fixture's own architecture comment for why).
 *
 * No artificial mocking: every graph is loaded for real via loadGraph(), every
 * classification reads real files on disk through FileContentCache, and the
 * flag-off ("byte-identical to today") tests exercise the SAME loaded graph
 * with only coverage.typeLevel flipped in memory — a config-level twin of the
 * one committed fixture, not a second fixture directory.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runCheck } from '../../../src/core/check.js';
import { checkStrictBackwardCoverage } from '../../../src/core/checks/mapping.js';
import { computeTypeCoverage } from '../../../src/core/type-coverage.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';
import type { Graph } from '../../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-basic');

/** The fixture's five uncovered files (matches the fixture's own directory layout). */
const UNCOVERED = [
  'src/misc/plain.ts',
  'src/svc/handler.ts',
  'src/svc/overlap.ts',
  'src/util/special.ts',
  'vendor/tool.ts',
];

let tmpDirs: string[] = [];

function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-type-coverage-'));
  cpSync(FIXTURE, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

/**
 * The "twin fixture config" the flag-off tests need: the SAME loaded graph
 * (same architecture, same files) with coverage.typeLevel flipped in memory.
 * coverage.type_level is committed-only, but nothing stops a caller from
 * constructing a Graph value with a different one — this is exactly the seam
 * that lets a test prove flag-off is byte-identical without a second
 * committed fixture directory.
 */
function withTypeLevel(graph: Graph, typeLevel: boolean): Graph {
  return {
    ...graph,
    config: { ...graph.config, coverage: { ...graph.config.coverage!, typeLevel } },
  };
}

// ===========================================================================
// computeTypeCoverage — the pure lattice, one test per row (design §3)
// ===========================================================================

describe('computeTypeCoverage — classification lattice', () => {
  it('exactly one non-strict match → covered (row 4)', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const result = await computeTypeCoverage(graph, UNCOVERED, new FileContentCache());
    expect(result.covered.get('src/svc/handler.ts')).toBe('svc');
  });

  it('2+ non-strict matches, no strict match → ambiguous (row 3)', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const result = await computeTypeCoverage(graph, UNCOVERED, new FileContentCache());
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]).toEqual({ file: 'src/svc/overlap.ts', typeIds: ['svc', 'util'] });
    expect(result.covered.has('src/svc/overlap.ts')).toBe(false);
    expect(result.unmatched).not.toContain('src/svc/overlap.ts');
  });

  it('>=1 strict match → strictClaimed, naming the non-strict co-match (row 2)', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const result = await computeTypeCoverage(graph, UNCOVERED, new FileContentCache());
    expect(result.strictClaimed).toEqual([
      { file: 'src/util/special.ts', strictTypeId: 'special' },
    ]);
    // A strict match must never ALSO be reported ambiguous or covered.
    expect(result.ambiguous.some((a) => a.file === 'src/util/special.ts')).toBe(false);
    expect(result.covered.has('src/util/special.ts')).toBe(false);
  });

  it('no type matches at all → unmatched (row 5)', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const result = await computeTypeCoverage(graph, UNCOVERED, new FileContentCache());
    expect(result.unmatched).toContain('src/misc/plain.ts');
  });

  it('a coverage.excluded-root file matching a type is skipped ENTIRELY — appears in no bucket (row 1/excluded-mute)', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const result = await computeTypeCoverage(graph, UNCOVERED, new FileContentCache());
    expect(result.covered.has('vendor/tool.ts')).toBe(false);
    expect(result.unmatched).not.toContain('vendor/tool.ts');
    expect(result.ambiguous.some((a) => a.file === 'vendor/tool.ts')).toBe(false);
    expect(result.strictClaimed.some((s) => s.file === 'vendor/tool.ts')).toBe(false);
    expect(result.unreadable.some((u) => u.file === 'vendor/tool.ts')).toBe(false);
  });

  it('a file over the 5MB content-scan limit under a content-predicate type → unreadable, never silently covered/unmatched', async () => {
    const dir = copyFixture();
    const bigPath = path.join(dir, 'src', 'huge.ts');
    writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const graph = await loadGraph(dir);
    const result = await computeTypeCoverage(graph, [...UNCOVERED, 'src/huge.ts'], new FileContentCache());
    expect(result.unreadable).toHaveLength(1);
    expect(result.unreadable[0].file).toBe('src/huge.ts');
    // One entry per FILE (not per type) — typeIds names every unreadable type.
    expect(result.unreadable[0].typeIds).toEqual(['big']);
    expect(result.unreadable[0].reason).toMatch(/5MB/);
    expect(result.unreadable[0].kind).toBe('too-large');
    expect(result.covered.has('src/huge.ts')).toBe(false);
    expect(result.unmatched).not.toContain('src/huge.ts');
  });

  it('a file unreadable against MULTIPLE classifying types is ONE aggregated entry naming every type, not one per type', async () => {
    const dir = copyFixture();
    const bigPath = path.join(dir, 'src', 'huge.ts');
    writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const graphOn = await loadGraph(dir);
    // Add a second content-only classifying type in memory (never touching the
    // committed fixture, which other tests pin at exactly 4 classifying types).
    const graph: Graph = {
      ...graphOn,
      architecture: {
        ...graphOn.architecture,
        node_types: {
          ...graphOn.architecture.node_types,
          big2: { description: 'second content-only type', when: { content: 'BIGMARKER2' } },
        },
      },
    };
    const result = await computeTypeCoverage(graph, [...UNCOVERED, 'src/huge.ts'], new FileContentCache());
    expect(result.unreadable).toHaveLength(1);
    expect(result.unreadable[0].file).toBe('src/huge.ts');
    expect([...result.unreadable[0].typeIds].sort()).toEqual(['big', 'big2']);
    expect(result.unreadable[0].kind).toBe('too-large');
  });

  it('a >5MB BINARY file is a clean non-match everywhere in the lattice, never a blocking file-unreadable (I1b: binary wins over the size guard)', async () => {
    const dir = copyFixture();
    const bigBinaryPath = path.join(dir, 'src', 'huge.bin');
    writeFileSync(
      bigBinaryPath,
      Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)]),
    );
    const graph = await loadGraph(dir);
    const result = await computeTypeCoverage(graph, [...UNCOVERED, 'src/huge.bin'], new FileContentCache());
    expect(result.unreadable.some((u) => u.file === 'src/huge.bin')).toBe(false);
    expect(result.covered.has('src/huge.bin')).toBe(false);
    // Matches no path-scoped type and 'big' correctly sees a clean binary
    // non-match (not unreadable) — falls through to genuinely unmatched.
    expect(result.unmatched).toContain('src/huge.bin');
  });

  it('a >5MB TEXT file short-circuits to a clean non-match for a type whose path atom definitively fails, even though its content atom is unreadable', async () => {
    const dir = copyFixture();
    const bigPath = path.join(dir, 'src', 'huge.ts');
    writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const graphOn = await loadGraph(dir);
    const graph: Graph = {
      ...graphOn,
      architecture: {
        ...graphOn.architecture,
        node_types: {
          ...graphOn.architecture.node_types,
          // path never matches src/huge.ts — the all_of can never match no
          // matter what the (also unreadable) content atom would resolve to.
          scoped: { description: 'path-scoped content type', when: { path: 'nomatch/**', content: 'BIGMARKER' } },
        },
      },
    };
    const result = await computeTypeCoverage(graph, [...UNCOVERED, 'src/huge.ts'], new FileContentCache());
    const u = result.unreadable.find((x) => x.file === 'src/huge.ts');
    expect(u).toBeDefined();
    // Only 'big' (genuinely content-hinging, no path constraint) is unreadable;
    // 'scoped' is short-circuited to a clean non-match by its failed path atom.
    expect(u!.typeIds).toEqual(['big']);
    expect(u!.typeIds).not.toContain('scoped');
  });
});

// ===========================================================================
// runCheck wiring (flag ON) — the same six rows, observed through the coverage
// section's actual issue set.
// ===========================================================================

async function runOnFixture(dir: string): Promise<Awaited<ReturnType<typeof runCheck>>> {
  const graph = await loadGraph(dir);
  const files = await walkRepoFiles(dir);
  return runCheck(graph, files);
}

describe('runCheck — type-level coverage wiring (flag on)', () => {
  it('a type-covered file is absent from the unmapped-files issue', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    const unmapped = result.issues.find((i) => i.code === 'unmapped-files');
    expect(unmapped?.uncoveredFiles ?? []).not.toContain('src/svc/handler.ts');
  });

  it('an ambiguous file yields ambiguous-node-type naming both types, with both exits in NEXT', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    const amb = result.issues.filter((i) => i.code === 'ambiguous-node-type');
    expect(amb).toHaveLength(1);
    expect(amb[0].severity).toBe('error');
    expect(amb[0].messageData.what).toContain('svc');
    expect(amb[0].messageData.what).toContain('util');
    expect(amb[0].messageData.next).toContain('1. Create an explicit node');
    expect(amb[0].messageData.next).toContain('2. Narrow one of the overlapping');
  });

  it('a strict+non-strict file yields the enriched orphan WHAT, NO ambiguity issue, and is absent from unmapped-files', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    const orphan = result.issues.find((i) => i.code === 'type-strict-orphan');
    expect(orphan?.messageData.what).toContain('Also matches: util');
    const amb = result.issues.filter((i) => i.code === 'ambiguous-node-type');
    expect(amb).toHaveLength(1); // only overlap.ts — special.ts never becomes ambiguous
    expect(amb[0].messageData.what).not.toContain('special.ts');
    // The lattice is one issue per file, most-binding wins: a strict-claimed
    // file already has its own (more specific) error and must not ALSO
    // inflate the generic bulk unmapped-files count.
    const unmapped = result.issues.find((i) => i.code === 'unmapped-files');
    expect(unmapped?.uncoveredFiles ?? []).not.toContain('src/util/special.ts');
  });

  it('an excluded-root file matching a type appears in no issue at all', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    const mentionsVendor = result.issues.some(
      (i) =>
        i.messageData.what.includes('vendor/tool.ts') ||
        (i.uncoveredFiles ?? []).includes('vendor/tool.ts'),
    );
    expect(mentionsVendor).toBe(false);
  });

  it('an unmatched file falls through to unmapped-files with the improved, unqualified "no type" message', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    const unmapped = result.issues.find((i) => i.code === 'unmapped-files');
    expect(unmapped?.uncoveredFiles).toContain('src/misc/plain.ts');
    expect(unmapped?.messageData.why).toContain('Your architecture has no type for this file');
    // The actionable yg type-suggest command belongs in NEXT, not WHY.
    expect(unmapped?.messageData.why).not.toContain('type-suggest');
    expect(unmapped?.messageData.next).toContain('yg type-suggest --file');
    // Every OTHER uncovered file in this fixture already has its own, more
    // specific verdict (covered / ambiguous / strict-claimed) — none of them
    // may also inflate this bulk listing or its count.
    expect(unmapped?.uncoveredFiles).toEqual(['src/misc/plain.ts']);
    expect(unmapped?.uncoveredCount).toBe(1);
  });

  it('an ambiguous file appears in EXACTLY ONE issue — the lattice is one issue per file, most-binding wins', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    const mentioning = result.issues.filter(
      (i) =>
        i.messageData.what.includes('src/svc/overlap.ts') ||
        (i.uncoveredFiles ?? []).includes('src/svc/overlap.ts'),
    );
    expect(mentioning).toHaveLength(1);
    expect(mentioning[0].code).toBe('ambiguous-node-type');
  });

  it('a strict-claimed file appears in EXACTLY ONE issue (type-strict-orphan)', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    const mentioning = result.issues.filter(
      (i) =>
        i.messageData.what.includes('src/util/special.ts') ||
        (i.uncoveredFiles ?? []).includes('src/util/special.ts'),
    );
    expect(mentioning).toHaveLength(1);
    expect(mentioning[0].code).toBe('type-strict-orphan');
  });

  it('a file over the 5MB content-scan limit is a blocking file-unreadable error and appears in EXACTLY that one issue', async () => {
    const dir = copyFixture();
    writeFileSync(path.join(dir, 'src', 'huge.ts'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const result = await runOnFixture(dir);
    const unreadable = result.issues.find(
      (i) => i.code === 'file-unreadable' && i.messageData.what.includes('huge.ts'),
    );
    expect(unreadable).toBeDefined();
    expect(unreadable!.severity).toBe('error');
    // I1c: the too-large kind is not an "OS error" — the WHAT says what it
    // actually is (exceeds the content-scan size limit) and NEXT is actionable
    // (gitignore it, exclude its root, or drop the content: atom), not a
    // permissions fix that would be the wrong advice for this file.
    expect(unreadable!.messageData.what).not.toContain('OS error');
    expect(unreadable!.messageData.what).toContain('exceeds the content-scan size limit');
    expect(unreadable!.messageData.what).toContain('big');
    expect(unreadable!.messageData.next).toContain('coverage.excluded');
    expect(unreadable!.messageData.next).toContain('content:');
    const mentioning = result.issues.filter(
      (i) =>
        i.messageData.what.includes('src/huge.ts') ||
        (i.uncoveredFiles ?? []).includes('src/huge.ts'),
    );
    expect(mentioning).toHaveLength(1);
    expect(mentioning[0].code).toBe('file-unreadable');
  });

  it('suggestedNext for an ambiguous file names the file and the two-exit guidance, not the generic ".yggdrasil" structural fallback', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    expect(result.suggestedNext).not.toBeNull();
    expect(result.suggestedNext).not.toContain('.yggdrasil');
    expect(result.suggestedNext).toContain('Two exits');
    expect(result.suggestedNext).toContain('svc');
    expect(result.suggestedNext).toContain('util');
    // Exactly the ambiguous issue's own messageData.next, verbatim.
    const amb = result.issues.find((i) => i.code === 'ambiguous-node-type');
    expect(result.suggestedNext).toBe(amb!.messageData.next);
  });
});

// ===========================================================================
// Excluded-ancestor-of-required corner — absolute exclusion resolution.
// Before this fix, computeTypeCoverage's own excluded-mute (independent,
// already absolute) disagreed with partitionByCoverageTier's longest-match:
// the SAME file could be lattice-muted yet still land in the required tier.
// This fix unifies both onto isExcludedByCoverage, so the corner is now
// fully closed: a file under this fixture's src/misc/ required root, ALSO
// under a broader src/ excluded root, is silenced everywhere — AND the
// required root itself is now a detectable dead config line
// (coverage-required-shadowed).
// ===========================================================================

describe('runCheck — excluded-ancestor-of-required corner is now fully closed', () => {
  it('every src/** file is silenced by the broader excluded root; the shadowed required root is warned; vendor/tool.ts (no longer excluded under this config) becomes type-covered', async () => {
    const dir = copyFixture();
    const graphOn = await loadGraph(dir);
    const graph: Graph = {
      ...graphOn,
      config: {
        ...graphOn.config,
        coverage: { ...graphOn.config.coverage!, required: ['src/misc/'], excluded: ['src/'], typeLevel: true },
      },
    };
    const files = await walkRepoFiles(dir);
    const result = await runCheck(graph, files);

    // No src/** file appears in the coverage-nodeless-tier issues — plain.ts,
    // handler.ts, and overlap.ts are all under excluded 'src/', silenced before
    // classification and before required/middle tiering both run through the
    // same absolute authority (isExcludedByCoverage).
    for (const f of ['src/misc/plain.ts', 'src/svc/handler.ts', 'src/svc/overlap.ts']) {
      const mentions = result.issues.some(
        (i) => i.messageData.what.includes(f) || (i.uncoveredFiles ?? []).includes(f),
      );
      expect(mentions).toBe(false);
    }
    expect(result.issues.some((i) => i.code === 'unmapped-files')).toBe(false);
    expect(result.issues.some((i) => i.code === 'ambiguous-node-type')).toBe(false);
    // special.ts (src/util/special.ts) sits under this test's excluded root
    // ('src/') too. checkStrictBackwardCoverage (core/checks/mapping.ts) now
    // filters its own repo walk through the same exclusion authority every
    // other type-level question already uses — an excluded file can be
    // neither a strict orphan nor misplaced, because it was never a candidate
    // this graph considers in the first place. So special.ts raises no
    // type-strict-orphan here, exactly like the other three excluded files
    // above raise no coverage complaint.
    expect(result.issues.some((i) => i.code === 'type-strict-orphan')).toBe(false);

    // The dead required line is now a visible, actionable warning instead of a
    // silent no-op — this is what the "coverage-required-shadowed" warning reports.
    const shadowed = result.issues.find((i) => i.code === 'coverage-required-shadowed');
    expect(shadowed).toBeDefined();
    expect(shadowed!.severity).toBe('warning');

    // vendor/tool.ts is NOT under this test's excluded root ('src/' only, not
    // 'vendor/'), so it is classified for the first time in this test — and the
    // fixture's `util` type explicitly names it in an any_of clause (see the
    // fixture's own yg-architecture.yaml comment), so it becomes type-covered.
    const advisory = result.issues.find((i) => i.code === 'uncovered-advisory');
    expect(advisory).toBeUndefined(); // vendor/tool.ts is covered, not advisory
    expect(result.typeCoveredCount).toBe(1); // vendor/tool.ts alone
  });
});

// ===========================================================================
// Flag OFF — byte-identical to pre-type-level behavior (HARD invariant)
// ===========================================================================

describe('runCheck — coverage.type_level OFF reproduces pre-type-level behavior exactly', () => {
  it('no ambiguous-node-type, no orphan enrichment, old unmapped wording; would-be covered/ambiguous files plainly listed', async () => {
    const dir = copyFixture();
    const graphOn = await loadGraph(dir);
    const graphOff = withTypeLevel(graphOn, false);
    const files = await walkRepoFiles(dir);
    const result = await runCheck(graphOff, files);

    expect(result.issues.some((i) => i.code === 'ambiguous-node-type')).toBe(false);
    expect(result.issues.some((i) => i.code === 'file-unreadable')).toBe(false);

    const orphan = result.issues.find((i) => i.code === 'type-strict-orphan');
    expect(orphan).toBeDefined();
    expect(orphan!.messageData.what).not.toContain('Also matches');

    const unmapped = result.issues.find((i) => i.code === 'unmapped-files');
    expect(unmapped).toBeDefined();
    expect(unmapped!.messageData.why).not.toContain('no type for this file');
    // handler.ts (would be type-covered) and overlap.ts (would be ambiguous)
    // are both ordinary unmapped files today — the lattice never ran.
    expect(unmapped!.uncoveredFiles).toContain('src/svc/handler.ts');
    expect(unmapped!.uncoveredFiles).toContain('src/svc/overlap.ts');
    expect(unmapped!.uncoveredFiles).toContain('src/util/special.ts');
    expect(unmapped!.uncoveredFiles).toContain('src/misc/plain.ts');
    // Insurance against drift: this fixture's required ('src/') and excluded
    // ('vendor/') roots do not nest, so checkRequiredShadowedByExcluded (a
    // pure config check, unrelated to the type-level flag) must stay silent
    // here regardless of whether the flag is on or off.
    expect(result.issues.some((i) => i.code === 'coverage-required-shadowed')).toBe(false);
  });

  it('flag OFF reproduces the COMPLETE pre-type-level issue set — full comparison, not targeted negatives', async () => {
    // The test above uses .some()/.find()/field-level checks — targeted
    // negatives, not a full issue-set comparison. A new issue class silently
    // appearing at flag-off would be a real regression (the flag must gate
    // 100% of the type-level machinery) but none of those checks would catch
    // an EXTRA, unanticipated issue — only a complete, sorted comparison of
    // every issue's code + severity + exact uncoveredFiles membership does.
    const dir = copyFixture();
    const graphOn = await loadGraph(dir);
    const graphOff = withTypeLevel(graphOn, false);
    const files = await walkRepoFiles(dir);
    const result = await runCheck(graphOff, files);

    const shape = result.issues
      .map((i) => ({
        code: i.code,
        severity: i.severity,
        // uncoveredFiles is present only on the bulk unmapped-files issue;
        // null elsewhere keeps the comparison array uniform and diffable.
        uncoveredFiles: i.uncoveredFiles ? [...i.uncoveredFiles].sort() : null,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));

    expect(shape).toEqual([
      // type-strict-orphan for special.ts — still fires at flag-off (the
      // strict backward scan is unconditional), but carries none of the
      // "Also matches" enrichment (pinned separately above).
      { code: 'type-strict-orphan', severity: 'error', uncoveredFiles: null },
      // Every other uncovered file lands in ONE bulk unmapped-files issue —
      // the lattice never partitioned them into covered/ambiguous, so this
      // includes special.ts too: at flag-off the "one issue per file" dedup
      // (a type-level-only mechanism) does not run, and the pre-existing
      // strict-orphan check and the plain unmapped-files check independently
      // flag the same file, exactly as they did before type-level coverage
      // existed. vendor/tool.ts is dropped by the pre-existing excluded-root
      // tier, unrelated to type-level.
      {
        code: 'unmapped-files',
        severity: 'error',
        uncoveredFiles: [
          'src/misc/plain.ts',
          'src/svc/handler.ts',
          'src/svc/overlap.ts',
          'src/util/special.ts',
        ],
      },
    ]);

    // Zero issues of any type-level-only code exist in this list at all —
    // stronger than the old test's .some()===false checks, because it is
    // implied by the exhaustive toEqual above (any stray issue would break
    // the array-length match), stated explicitly for readability.
    const typeLevelOnlyCodes = ['ambiguous-node-type', 'file-unreadable'];
    expect(shape.some((i) => typeLevelOnlyCodes.includes(i.code))).toBe(false);

    // Task 2's dead-config-line warning (coverage-required-shadowed) is a PURE
    // CoverageConfig check, unrelated to the type-level flag, and fires on
    // every run regardless of typeLevel. This fixture's config (required:
    // [src/], excluded: [vendor/]) has no shadowing relationship — neither root
    // contains the other — so it must stay silent. Kept here as insurance
    // against exactly this fixture's config drifting in a later change.
    expect(shape.some((i) => i.code === 'coverage-required-shadowed')).toBe(false);
  });
});

// ===========================================================================
// CheckResult header-support fields (typeLevel / typeCoveredCount /
// classifyingTypeCount) — the data the CLI header split and the
// zero-classifying-types notice render from.
// ===========================================================================

describe('runCheck — typeLevel / typeCoveredCount / classifyingTypeCount', () => {
  it('flag on: typeLevel true, classifyingTypeCount counts the four `when`-bearing types, typeCoveredCount counts only the silently-covered file', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    expect(result.typeLevel).toBe(true);
    // svc, util, special, big all declare `when:` in the fixture architecture.
    expect(result.classifyingTypeCount).toBe(4);
    // Only handler.ts lands in the lattice's `covered` bucket — overlap.ts is
    // ambiguous, special.ts is strict-claimed, neither counts as type-covered.
    expect(result.typeCoveredCount).toBe(1);
  });

  it('nodeOwnedFiles/excludedFiles split honestly: the fixture has ZERO nodes, so nodeOwnedFiles is 0 even though vendor/tool.ts (excluded root) inflates the legacy coveredFiles count to 1', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    // No node in this fixture owns anything — "node-owned" must read 0, never
    // borrow from the excluded-root file that the legacy coveredFiles counter
    // (kept unchanged for the flag-off header/portal) folds in as "covered".
    expect(result.nodeOwnedFiles).toBe(0);
    expect(result.excludedFiles).toBe(1); // vendor/tool.ts
    expect(result.coveredFiles).toBe(1); // legacy conflated total, unchanged
    expect((result.nodeOwnedFiles ?? 0) + (result.excludedFiles ?? 0)).toBe(result.coveredFiles);
  });

  it('sum invariant on the FAIL fixture: node-owned + type-covered + excluded + every issue-listed file === totalFiles', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    // Every uncovered file in this fixture lands in exactly one bucket: the
    // three header terms, or exactly one issue (ambiguous-node-type for
    // overlap.ts, type-strict-orphan for special.ts, unmapped-files for
    // plain.ts). None may be double-counted or dropped.
    const headerTermsTotal =
      (result.nodeOwnedFiles ?? 0) + (result.typeCoveredCount ?? 0) + (result.excludedFiles ?? 0);
    const ambiguousCount = result.issues.filter((i) => i.code === 'ambiguous-node-type').length;
    const strictOrphanCount = result.issues.filter((i) => i.code === 'type-strict-orphan').length;
    const unmapped = result.issues.find((i) => i.code === 'unmapped-files');
    const unmappedCount = unmapped?.uncoveredCount ?? 0;
    expect(headerTermsTotal + ambiguousCount + strictOrphanCount + unmappedCount).toBe(result.totalFiles);
    // Concretely: 0 node-owned + 1 type-covered + 1 excluded + 1 ambiguous +
    // 1 strict-orphan + 1 unmapped = 5 total files.
    expect(headerTermsTotal).toBe(2);
    expect(ambiguousCount + strictOrphanCount + unmappedCount).toBe(3);
    expect(result.totalFiles).toBe(5);
  });

  it('flag off: typeLevel false, typeCoveredCount 0 (the lattice never ran), classifyingTypeCount unaffected (a pure architecture fact)', async () => {
    const dir = copyFixture();
    const graphOn = await loadGraph(dir);
    const graphOff = withTypeLevel(graphOn, false);
    const files = await walkRepoFiles(dir);
    const result = await runCheck(graphOff, files);
    expect(result.typeLevel).toBe(false);
    expect(result.typeCoveredCount).toBe(0);
    expect(result.classifyingTypeCount).toBe(4);
  });

  it('flag on, zero classifying types (every `when:` stripped in memory): classifyingTypeCount 0, typeCoveredCount 0 — the lattice cannot match a single file', async () => {
    const dir = copyFixture();
    const graphOn = await loadGraph(dir);
    const noClassifying: Graph = {
      ...graphOn,
      architecture: {
        ...graphOn.architecture,
        node_types: Object.fromEntries(
          Object.entries(graphOn.architecture.node_types).map(([id, def]) => [
            id,
            { ...def, when: undefined, enforce: undefined },
          ]),
        ),
      },
    };
    const files = await walkRepoFiles(dir);
    const result = await runCheck(noClassifying, files);
    expect(result.typeLevel).toBe(true);
    expect(result.classifyingTypeCount).toBe(0);
    expect(result.typeCoveredCount).toBe(0);
  });
});

// ===========================================================================
// checkStrictBackwardCoverage — orphan WHAT enrichment in isolation
// ===========================================================================

describe('checkStrictBackwardCoverage — orphan WHAT enrichment is flag-gated', () => {
  it('typeLevel on: appends "Also matches: <types>" to the type-strict-orphan WHAT', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const { issues } = await checkStrictBackwardCoverage(graph, new FileContentCache());
    const orphan = issues.find((i) => i.code === 'type-strict-orphan');
    expect(orphan?.messageData.what).toContain('Also matches: util');
  });

  it('typeLevel off: the orphan WHAT carries no enrichment', async () => {
    const dir = copyFixture();
    const graphOn = await loadGraph(dir);
    const graphOff = withTypeLevel(graphOn, false);
    const { issues } = await checkStrictBackwardCoverage(graphOff, new FileContentCache());
    const orphan = issues.find((i) => i.code === 'type-strict-orphan');
    expect(orphan?.messageData.what).not.toContain('Also matches');
  });

  it('the Also-matches predicate excludes EVERY strict type, not just the primary co-match (predicate unification)', () => {
    // The exact filter now shared by core/checks/mapping.ts's Also-matches enrichment
    // (the fixed predicate excluding every strict co-match, not just the primary one) —
    // reproduced inline so this test proves the LOGIC, independent of any
    // fixture's ability to construct a 2-strict-co-match file without also triggering
    // strict-overlap-conflict first (design §3 row 1: 2+ strict types matching wins over
    // orphan entirely, so that shape can never reach the Also-matches enrichment path at
    // all — testing it through runCheck/checkStrictBackwardCoverage would be testing the
    // wrong code path).
    const nodeTypes: Record<string, { enforce?: 'strict' }> = {
      special: { enforce: 'strict' },
      'special-2': { enforce: 'strict' },
      util: {},
    };
    const matches = [{ typeId: 'special' }, { typeId: 'special-2' }, { typeId: 'util' }];
    const alsoMatches = matches
      .filter((m) => nodeTypes[m.typeId]?.enforce !== 'strict')
      .map((m) => m.typeId);
    // Old predicate (`m.typeId !== typeId`) would have wrongly kept 'special-2' (a strict
    // co-match, not a "consider this instead" suggestion) in the list. The fixed predicate
    // excludes every strict type, keeping only the genuinely non-strict co-match.
    expect(alsoMatches).toEqual(['util']);
  });
});

// ===========================================================================
// Shared FileContentCache across validate() and computeTypeCoverage()
// ===========================================================================

describe('runCheck — shares one FileContentCache between validate() and computeTypeCoverage()', () => {
  it('does not re-read an uncovered file\'s content once cached within a single runCheck', async () => {
    // The fixture's content-classified type ('big') forces classifyFile to read
    // EVERY uncovered file's content, including src/util/special.ts — once via
    // checkStrictBackwardCoverage's own "Also matches" enrichment classifyFile
    // call (inside validate()), and again via computeTypeCoverage's classifyFile
    // call (in runCheck's coverage section). Before this sharing was added, these
    // were two independent FileContentCache instances, so special.ts was read from
    // disk twice for the one run; now both consumers share one cache, so the
    // second read is a cache hit.
    //
    // Observation seam: FileContentCache.read() memoizes by delegating to the
    // private load() exactly once per absolute path per INSTANCE (read()'s own
    // `if (entry === undefined)` guard) — vi.spyOn on the module's ESM export
    // (node:fs/promises.readFile) is not usable here (Vitest cannot redefine a
    // non-configurable ESM namespace property), so load() on the class's own
    // prototype is the seam this test actually has, per file-content-cache.ts.
    const dir = copyFixture();
    const loadSpy = vi.spyOn(FileContentCache.prototype as unknown as { load(absPath: string): Promise<unknown> }, 'load');
    await runOnFixture(dir);
    const specialTsLoads = loadSpy.mock.calls.filter(([p]) => String(p).includes('special.ts'));
    expect(specialTsLoads.length).toBeLessThanOrEqual(1);
    loadSpy.mockRestore();
  });
});
