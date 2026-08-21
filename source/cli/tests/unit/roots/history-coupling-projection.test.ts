import { describe, it, expect } from 'vitest';
import { projectCouplingForPartition } from '../../../src/roots/history.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/history-coupling-projection.test.ts — a direct unit test
// for `projectCouplingForPartition` (R4 Task 8, Appendix D `:892`): the
// repo-global `couplingByFile`/`couplingByModule` co-change percentiles,
// projected down to ONE partition's own file/module set. No landed golden
// currently produces more than one partition with a non-empty co-change cut
// small enough to hand-verify (`_root` is the only surviving partition on
// every landed goldens' own file layout), so this is a synthetic, two-
// partition input built directly against the function's own signature —
// the same reasoning `mine-roles-fence.test.ts` already applies to
// `computeRoleLiftForPartition`.
// ---------------------------------------------------------------------------

describe('projectCouplingForPartition — repo-global coupling maps projected per partition, never leaking across partitions', () => {
  it('two partitions with disjoint file sets each receive ONLY their own couplingByFile/couplingByModule entries', () => {
    const join = {
      couplingByFile: {
        'moda/a.ts': 0.9,
        'moda/b.ts': 0.5,
        'modb/c.ts': 0.3,
        'modb/d.ts': 0.7,
      },
      couplingByModule: {
        moda: 0.8,
        modb: 0.4,
      },
    };

    const partitionAFiles = new Set(['moda/a.ts', 'moda/b.ts']);
    const partitionBFiles = new Set(['modb/c.ts', 'modb/d.ts']);

    const projectedA = projectCouplingForPartition(join, partitionAFiles);
    const projectedB = projectCouplingForPartition(join, partitionBFiles);

    // Partition A gets exactly its own two files and its own module, never
    // partition B's.
    expect(projectedA.couplingByFile).toEqual({ 'moda/a.ts': 0.9, 'moda/b.ts': 0.5 });
    expect(projectedA.couplingByModule).toEqual({ moda: 0.8 });

    // Partition B gets exactly its own two files and its own module, never
    // partition A's — the isolation this whole function exists for.
    expect(projectedB.couplingByFile).toEqual({ 'modb/c.ts': 0.3, 'modb/d.ts': 0.7 });
    expect(projectedB.couplingByModule).toEqual({ modb: 0.4 });

    // Neither projection leaks the OTHER partition's own keys.
    expect(Object.keys(projectedA.couplingByFile)).not.toContain('modb/c.ts');
    expect(Object.keys(projectedB.couplingByFile)).not.toContain('moda/a.ts');
    expect(Object.keys(projectedA.couplingByModule)).not.toContain('modb');
    expect(Object.keys(projectedB.couplingByModule)).not.toContain('moda');
  });

  it('a partition with no files projects to two empty objects, never the unprojected repo-global maps', () => {
    const join = { couplingByFile: { 'moda/a.ts': 0.9 }, couplingByModule: { moda: 0.8 } };
    const projected = projectCouplingForPartition(join, new Set());
    expect(projected.couplingByFile).toEqual({});
    expect(projected.couplingByModule).toEqual({});
  });
});
