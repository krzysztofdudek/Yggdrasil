/**
 * Unit tests for the SILENT feature-field deviation math (core/feature-index-write.ts).
 *
 * These drive the PURE core — `median` / `mad` / `robustZ` and `computeFamilyDeviations`
 * — on synthetic families, with no filesystem and no clock. They pin:
 *   - median / MAD on both even and odd family sizes,
 *   - robust-z admission (all three conditions: N >= MIN_N, mad > 0, |z| >= Z_ADMIT),
 *   - the sparse output (only files with >= 1 deviation appear),
 *   - the family key format and the threaded contentHash,
 *   - small-N silence and zero-spread silence (no divide-by-zero).
 */
import { describe, it, expect } from 'vitest';
import {
  median,
  mad,
  robustZ,
  computeFamilyDeviations,
  familyKey,
  Z_ADMIT,
  MIN_N,
} from '../../../src/core/feature-index-write.js';
import type { FamilyOwner } from '../../../src/core/feature-field-schema.js';
import type { FeatureVector } from '../../../src/relations/feature-vector.js';
import type { FileFacts } from '../../../src/relations/pass.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a FeatureVector from overrides; every field defaults to a bland, spread-free value
 *  so a test can perturb exactly ONE dimension and know nothing else can fire. */
function fv(overrides: Partial<{
  nodeCount: number;
  depth: [number, number, number];
  categories: Partial<FeatureVector['categories']>;
}> = {}): FeatureVector {
  return {
    nodeCount: overrides.nodeCount ?? 100,
    depthQuartiles: overrides.depth ?? [2, 4, 6],
    categories: {
      'function-like': 5,
      'class-like': 1,
      'import-like': 8,
      'branch-like': 3,
      'call-like': 20,
      'literal-like': 15,
      ...(overrides.categories ?? {}),
    },
  };
}

/** Wrap a FeatureVector as the minimal FileFacts the deviation math reads. */
function facts(vector: FeatureVector): FileFacts {
  return { declarations: [], uses: [], csharp: null, features: vector };
}

/** Build (factsByPath, ownerOf, hashByPath) for a single family of TS files with the given
 *  per-file branch-like counts, all other dimensions held constant (so ONLY branch-like can
 *  ever fire). Returns the built maps plus the resolver. */
function tsFamily(branchCounts: number[], node = 'svc') {
  const factsByPath = new Map<string, FileFacts>();
  const hashByPath = new Map<string, string>();
  branchCounts.forEach((b, i) => {
    const p = `src/${node}/file${i}.ts`;
    factsByPath.set(p, facts(fv({ categories: { 'branch-like': b } })));
    hashByPath.set(p, `hash-${node}-${i}`);
  });
  const ownerOf = (p: string): FamilyOwner | undefined =>
    p.startsWith(`src/${node}/`) ? { kind: 'node', id: node } : undefined;
  return { factsByPath, hashByPath, ownerOf };
}

// ── median / mad / robustZ ───────────────────────────────────────────────────

describe('median / mad / robustZ (robust statistics)', () => {
  it('median on an odd-sized array is the middle element', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([5, 1, 4, 2, 3])).toBe(3);
  });

  it('median on an even-sized array is the mean of the two middle elements', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([10, 2, 8, 4])).toBe(6); // sorted [2,4,8,10] → (4+8)/2
  });

  it('mad is the median of absolute deviations about the centre (odd and even)', () => {
    // odd: values [1,2,3,4,5], median 3, |x-3| = [2,1,0,1,2] → median 1
    expect(mad([1, 2, 3, 4, 5], 3)).toBe(1);
    // even: values [1,2,3,4], median 2.5, |x-2.5| = [1.5,0.5,0.5,1.5] → median 1
    expect(mad([1, 2, 3, 4], 2.5)).toBe(1);
  });

  it('robustZ rescales by 1.4826·mad', () => {
    expect(robustZ(10, 4, 1)).toBeCloseTo(6 / 1.4826, 6);
    expect(robustZ(4, 4, 2)).toBe(0);
  });
});

// ── computeFamilyDeviations ──────────────────────────────────────────────────

describe('computeFamilyDeviations', () => {
  it('flags the single branch-like outlier in a 6-file family (even size)', () => {
    // branch-like across 6 files: sorted [3,4,5,5,6,40], median 5, |x-5| sorted [0,0,1,1,2,35] → mad 1.
    // robustZ(40,5,1) = 35/1.4826 ≈ 23.6 (>> 3.5); the others are all within ~1.35.
    const { factsByPath, hashByPath, ownerOf } = tsFamily([3, 5, 4, 6, 5, 40]);
    const result = computeFamilyDeviations(factsByPath, ownerOf, hashByPath, new Set(factsByPath.keys()));

    // Sparse: exactly the one outlier file appears.
    expect([...result.keys()]).toEqual(['src/svc/file5.ts']);
    const entry = result.get('src/svc/file5.ts')!;
    expect(entry.family).toBe(familyKey({ kind: 'node', id: 'svc' }, 'typescript'));
    expect(entry.contentHash).toBe('hash-svc-5'); // threaded from hashByPath
    // Exactly one deviation, on branch-like, with a large positive robust score.
    expect(entry.deviations).toHaveLength(1);
    expect(entry.deviations[0].dim).toBe('branch-like');
    expect(entry.deviations[0].z).toBeGreaterThan(Z_ADMIT);
    expect(entry.deviations[0].z).toBeCloseTo(35 / 1.4826, 1);
  });

  it('emits NOTHING for a family below MIN_N even with a wild outlier', () => {
    expect(MIN_N).toBe(5);
    // 4 files (< MIN_N) with an extreme outlier → still silent.
    const { factsByPath, hashByPath, ownerOf } = tsFamily([3, 5, 4, 400]);
    const result = computeFamilyDeviations(factsByPath, ownerOf, hashByPath, new Set(factsByPath.keys()));
    expect(result.size).toBe(0);
  });

  it('never flags a zero-spread dimension (no divide-by-zero) yet still flags one with spread', () => {
    // 5 files (odd). nodeCount is constant across all → mad(nodeCount) == 0 → must never fire.
    // branch-like [2,3,4,5,60]: sorted [2,3,4,5,60], median 4, |x-4| sorted [0,1,1,2,56] → mad 1.
    // robustZ(60,4,1) ≈ 37.8 → branch-like fires on file4 ONLY.
    const factsByPath = new Map<string, FileFacts>();
    const hashByPath = new Map<string, string>();
    [2, 3, 4, 5, 60].forEach((b, i) => {
      const p = `src/svc/file${i}.ts`;
      // nodeCount held constant at 100 (default) → zero spread on that dimension.
      factsByPath.set(p, facts(fv({ categories: { 'branch-like': b } })));
      hashByPath.set(p, `h${i}`);
    });
    const ownerOf = (p: string): FamilyOwner | undefined =>
      p.startsWith('src/svc/') ? { kind: 'node', id: 'svc' } : undefined;

    const result = computeFamilyDeviations(factsByPath, ownerOf, hashByPath, new Set(factsByPath.keys()));
    expect([...result.keys()]).toEqual(['src/svc/file4.ts']);
    const dims = result.get('src/svc/file4.ts')!.deviations.map((d) => d.dim);
    expect(dims).toEqual(['branch-like']); // NOT nodeCount (zero spread)
    // The score is finite — no Infinity/NaN from a zero-spread dimension leaking through.
    for (const d of result.get('src/svc/file4.ts')!.deviations) {
      expect(Number.isFinite(d.z)).toBe(true);
    }
  });

  it('excludes an owned file that is NOT in the git-tracked (included) set', () => {
    // A 6-file family with one clear branch-like outlier (file5).
    const { factsByPath, hashByPath, ownerOf } = tsFamily([3, 5, 4, 6, 5, 40]);

    // With ALL files tracked, the outlier is flagged.
    const withAll = computeFamilyDeviations(factsByPath, ownerOf, hashByPath, new Set(factsByPath.keys()));
    expect([...withAll.keys()]).toEqual(['src/svc/file5.ts']);

    // Omit the outlier from the tracked set (it is owned but gitignored/scratch). It must be
    // excluded entirely — never flagged — and, with the outlier gone, the cohort has no outlier.
    const tracked = new Set([...factsByPath.keys()].filter((p) => p !== 'src/svc/file5.ts'));
    const withoutOutlier = computeFamilyDeviations(factsByPath, ownerOf, hashByPath, tracked);
    expect(withoutOutlier.has('src/svc/file5.ts')).toBe(false);
    expect(withoutOutlier.size).toBe(0);
  });

  it('compares only WITHIN a family — files with no owner are skipped, and two languages never mix', () => {
    const factsByPath = new Map<string, FileFacts>();
    const hashByPath = new Map<string, string>();
    // Family A: 5 TS files, one branch-like outlier.
    [3, 4, 5, 4, 50].forEach((b, i) => {
      const p = `src/a/f${i}.ts`;
      factsByPath.set(p, facts(fv({ categories: { 'branch-like': b } })));
      hashByPath.set(p, `a${i}`);
    });
    // A single uncovered file (no owner) — must be skipped entirely.
    factsByPath.set('vendor/x.ts', facts(fv({ categories: { 'branch-like': 9999 } })));
    hashByPath.set('vendor/x.ts', 'vend');

    const ownerOf = (p: string): FamilyOwner | undefined =>
      p.startsWith('src/a/') ? { kind: 'node', id: 'a' } : undefined;
    const result = computeFamilyDeviations(factsByPath, ownerOf, hashByPath, new Set(factsByPath.keys()));

    expect([...result.keys()]).toEqual(['src/a/f4.ts']);
    expect(result.get('src/a/f4.ts')!.family).toBe(familyKey({ kind: 'node', id: 'a' }, 'typescript'));
    expect(result.has('vendor/x.ts')).toBe(false);
  });

  // ── Task 12 / K17: a type-covered file (no owning node) forms its own family ──

  it('a family resolved via a TYPE owner (no node) is admitted — a type-covered file is not silently dropped', () => {
    // 5 TS files whose resolver names a matched TYPE, never a node — exactly the
    // shape a type-covered file (computeTypeCoverage's `covered` map) resolves to.
    // Before the widened resolver, ownerOf could only ever return a node id or
    // undefined, so a file like this was always skipped (see the "no owner" case
    // above) — never grouped into a family, never compared, never flagged.
    const factsByPath = new Map<string, FileFacts>();
    const hashByPath = new Map<string, string>();
    [3, 4, 5, 4, 50].forEach((b, i) => {
      const p = `src/svc/f${i}.ts`;
      factsByPath.set(p, facts(fv({ categories: { 'branch-like': b } })));
      hashByPath.set(p, `svc${i}`);
    });
    const typeOwnerOf = (p: string): FamilyOwner | undefined =>
      p.startsWith('src/svc/') ? { kind: 'type', id: 'svc' } : undefined;

    const result = computeFamilyDeviations(factsByPath, typeOwnerOf, hashByPath, new Set(factsByPath.keys()));

    expect([...result.keys()]).toEqual(['src/svc/f4.ts']);
    expect(result.get('src/svc/f4.ts')!.family).toBe(familyKey({ kind: 'type', id: 'svc' }, 'typescript'));
  });

  it("a type-keyed family never collides with a node-keyed family carrying the SAME id string", () => {
    // A node 'svc' and a type 'svc' are two entirely different comparison cohorts
    // (a node's own mapped files vs. every file the architecture classifies under
    // the type 'svc') — the family key must distinguish them even though the raw
    // id string is identical, so a node-owned outlier can never be compared
    // against (or silently merged with) a type-covered one under the same key.
    expect(familyKey({ kind: 'node', id: 'svc' }, 'typescript')).not.toBe(
      familyKey({ kind: 'type', id: 'svc' }, 'typescript'),
    );
  });
});
