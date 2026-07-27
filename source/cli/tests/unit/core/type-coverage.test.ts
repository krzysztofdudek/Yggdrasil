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
import { describe, it, expect, afterEach } from 'vitest';
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
      { file: 'src/util/special.ts', strictTypeId: 'special', alsoMatches: ['util'] },
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
    expect(result.unreadable[0].typeId).toBe('big');
    expect(result.unreadable[0].reason).toMatch(/5MB/);
    expect(result.covered.has('src/huge.ts')).toBe(false);
    expect(result.unmatched).not.toContain('src/huge.ts');
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

  it('a strict+non-strict file yields the enriched orphan WHAT and NO ambiguity issue for it', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    const orphan = result.issues.find((i) => i.code === 'type-strict-orphan');
    expect(orphan?.messageData.what).toContain('Also matches: util');
    const amb = result.issues.filter((i) => i.code === 'ambiguous-node-type');
    expect(amb).toHaveLength(1); // only overlap.ts — special.ts never becomes ambiguous
    expect(amb[0].messageData.what).not.toContain('special.ts');
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

  it('an unmatched file falls through to unmapped-files with the improved "no type" message', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    const unmapped = result.issues.find((i) => i.code === 'unmapped-files');
    expect(unmapped?.uncoveredFiles).toContain('src/misc/plain.ts');
    expect(unmapped?.messageData.why).toContain('your architecture has no type for this file');
  });

  it('a file over the 5MB content-scan limit is a blocking file-unreadable error', async () => {
    const dir = copyFixture();
    writeFileSync(path.join(dir, 'src', 'huge.ts'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const result = await runOnFixture(dir);
    const unreadable = result.issues.find(
      (i) => i.code === 'file-unreadable' && i.messageData.what.includes('huge.ts'),
    );
    expect(unreadable).toBeDefined();
    expect(unreadable!.severity).toBe('error');
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
});
