import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPortalData } from '../../src/portal/extract.js';
import { buildSuppressions, buildHubs, buildResidue, buildWorklist } from '../../src/portal/derive-rest.js';
import { buildBoundary } from '../../src/portal/derive-boundary.js';
import type {
  PortalData,
  PortalNode,
  BoundaryInput,
  SuppressionMarkerInput,
} from '../../src/portal/contract.js';
import type { CheckResult } from '../../src/core/check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The REAL repo root (real .yggdrasil/ graph + real source).
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Hubs, residue, the worklist, and the LIVE boundary, on the REAL repo. The boundary +
// suppression inventory are now produced by the facade (the single engine seam): the
// boundary is computed live (never UNKNOWN on a parseable repo) and the suppression
// inventory is populated. The pure builders are branch-covered directly below with
// synthetic inputs (no fabricated PortalData).

describe('portal rest derivation (hubs / residue / worklist / boundary) — real repo', () => {
  let data: PortalData;

  beforeAll(async () => {
    data = await extractPortalData(REPO_ROOT, { writeEnabled: false });
  }, 180_000);

  it('the top fan-out hub is a three-way tie at 24 declared relations: cli/core/check, cli/core/fill, cli/portal/engine-api', () => {
    // cli/commands/aspect-test briefly gained three real dependencies for its
    // --file addressing mode (cli/relations/core, cli/commands/owner,
    // cli/core/check-coverage-tiers), raising it 21 -> 24 and tying it with
    // the leaders here — but that raise was undone by extraction, not kept:
    // --file's target-classification logic moved out into its own node
    // (cli/core/aspect-test-file-target), landing aspect-test at 20 real
    // relations (the two checks that stay — existence, ownership — needed
    // only cli/commands/owner back, not the other two). So the tie reverts
    // to the same three that were tied at 24 all along beneath it:
    // cli/core/check and cli/core/fill (named in the ORIGINAL version of this
    // pin) plus cli/portal/engine-api, which was already at 24 too but never
    // asserted here because the old 3-entry check never looked past index 2.
    // Tied counts break alphabetically (rankHubs: count desc, then path asc).
    expect(data.hubs.fanOut.length).toBeGreaterThan(0);
    expect(data.hubs.fanOut[0].path).toBe('cli/core/check');
    expect(data.hubs.fanOut[0].count).toBe(24);
    expect(data.hubs.fanOut[1].path).toBe('cli/core/fill');
    expect(data.hubs.fanOut[1].count).toBe(24);
    expect(data.hubs.fanOut[2].path).toBe('cli/portal/engine-api');
    expect(data.hubs.fanOut[2].count).toBe(24);
    // Stronger than the pin this replaces: also pins that aspect-test's
    // extraction actually landed it BELOW the leaders (never re-joining the
    // tie by accident) — the one fact the relation-ceiling restoration above
    // is supposed to make true. Found by path, not by a fixed index — the
    // nodes between the top tie and aspect-test in the ranking are unrelated
    // to this change and no more pinned here than they were before, avoiding
    // exactly the brittle-anchor failure mode the 2026-07-26 dogfood entry
    // recorded for this same test file.
    const aspectTest = data.hubs.fanOut.find((h) => h.path === 'cli/commands/aspect-test');
    expect(aspectTest).toBeDefined();
    expect(aspectTest!.count).toBe(20);
    expect(aspectTest!.count).toBeLessThan(24);
    // descending order invariant.
    for (let i = 1; i < data.hubs.fanOut.length; i++) {
      expect(data.hubs.fanOut[i - 1].count).toBeGreaterThanOrEqual(data.hubs.fanOut[i].count);
    }
  });

  it('fan-in hubs are ranked and the heaviest is a shared utility/store node', () => {
    expect(data.hubs.fanIn.length).toBeGreaterThan(0);
    for (let i = 1; i < data.hubs.fanIn.length; i++) {
      expect(data.hubs.fanIn[i - 1].count).toBeGreaterThanOrEqual(data.hubs.fanIn[i].count);
    }
  });

  it('the worklist carries no high-fan-out group — both reviewed seams declare an allowance', () => {
    // cli/core/fill and cli/portal/engine-api each declare a reviewed-seam max_direct_relations
    // ceiling equal to their exact relation count, so the built-in high-fan-out check no longer
    // warns on either. The real repo is warning-free, so the worklist has no high-fan-out group.
    const hfo = data.worklist.find((w) => w.rule === 'high-fan-out');
    expect(hfo).toBeUndefined();
  });

  it('the boundary is LIVE (computed, never UNKNOWN) on the real parseable repo', () => {
    expect(data.boundary.unknown).toBe(false);
    // A green repo has no undeclared (phantom) dependency and no architecture-forbidden
    // edge; declared-only edges (declared relations with no static code backing) are
    // expected and surfaced — never hidden.
    expect(data.boundary.phantom).toEqual([]);
    expect(data.boundary.forbiddenType).toEqual([]);
    expect(Array.isArray(data.boundary.declaredOnly)).toBe(true);
  });

  it('the residue never hides a genuinely-no-rule source node (universal honesty invariant, robust to coverage level)', () => {
    // Asserted as a UNIVERSAL invariant rather than by pinning any one node. As coverage
    // closes (rule-bearing aspects attach to more source-owning types), the set of genuinely-
    // no-rule source nodes shrinks — and may legitimately trend all the way to EMPTY. The old
    // pin that named `scripts` here rotted the instant `scripts` gained a rule, so it is gone.
    // What MUST hold at every coverage level is that the residue never HIDES a source node
    // that carries no rule: for every derived node that owns source, it is either surfaced in
    // the no-rule residue, OR it carries at least one effective aspect (a rule reaches it), OR
    // its mapped source was just edited (`fresh`) and it is therefore surfaced as `unverified`
    // — a stronger, more-visible state than no-rule, never a silent green. This is strictly
    // stronger than the old single-node pin and cannot be defeated by the coverage closing.
    const byPath = new Map(data.nodes.map((n) => [n.path, n]));
    const noRule = new Set(data.residue.noRuleNodes);
    for (const n of data.nodes) {
      if (n.mapping.length === 0) continue; // a node with no source cannot be a no-rule SOURCE node
      const surfaced = noRule.has(n.path) || n.effectiveAspects.length > 0 || n.fresh;
      expect(surfaced, `source node "${n.path}" (state=${n.state}) is hidden: absent from the residue, carries no rule, and is not fresh`).toBe(true);
    }
    // The general residue invariant is KEPT: every node the residue calls no-rule reads
    // state==='no-rule' in its own node detail — the residue can never mislabel a node.
    for (const p of data.residue.noRuleNodes) {
      expect(byPath.get(p)!.state).toBe('no-rule');
    }
  });
});

// ── Pure-builder branch coverage (synthetic inputs, real builder functions) ───

describe('portal rest builders — honest branches', () => {
  it('buildBoundary(null) is UNKNOWN; a populated input is clean/false and deduped+sorted', () => {
    expect(buildBoundary(null).unknown).toBe(true);

    const input: BoundaryInput = {
      phantom: [
        { source: 'b', target: 'x' },
        { source: 'a', target: 'y' },
        { source: 'a', target: 'y' }, // duplicate
      ],
      declaredOnly: [],
      forbiddenType: [{ source: 'c', target: 'z' }],
    };
    const b = buildBoundary(input);
    expect(b.unknown).toBe(false);
    // deduped to 2, sorted by source then target.
    expect(b.phantom).toEqual([
      { source: 'a', target: 'y' },
      { source: 'b', target: 'x' },
    ]);
    expect(b.forbiddenType).toEqual([{ source: 'c', target: 'z' }]);
  });

  it('buildSuppressions carries the risk flag and sorts by file then line', () => {
    const markers: SuppressionMarkerInput[] = [
      { file: 'src/b.ts', line: 10, aspectId: 'a1', reason: 'r' },
      { file: 'src/a.ts', line: 30, aspectId: '*', reason: 'silence all', risk: 'wildcard' },
      { file: 'src/a.ts', line: 5, aspectId: 'a2', reason: 'r2', risk: 'unbounded' },
    ];
    const out = buildSuppressions(markers);
    expect(out.map((s) => `${s.file}:${s.line}`)).toEqual(['src/a.ts:5', 'src/a.ts:30', 'src/b.ts:10']);
    const wildcard = out.find((s) => s.aspectId === '*')!;
    expect(wildcard.risk).toBe('wildcard');
    expect(out.filter((s) => s.risk).length).toBe(2);
  });

  it('buildHubs omits zero-degree nodes and ranks descending', () => {
    const nodes = [
      mkNode('n1', 3, 1),
      mkNode('n2', 0, 0),
      mkNode('n3', 5, 2),
    ];
    const hubs = buildHubs(nodes);
    expect(hubs.fanOut.map((h) => h.path)).toEqual(['n3', 'n1']);
    expect(hubs.fanOut[0].count).toBe(5);
    // n2 (zero degree) is omitted from both lists.
    expect(hubs.fanOut.find((h) => h.path === 'n2')).toBeUndefined();
    expect(hubs.fanIn.find((h) => h.path === 'n2')).toBeUndefined();
  });

  it('buildResidue collects only mapped no-rule nodes and sorts uncovered files', () => {
    const nodes = [
      { ...mkNode('keep', 0, 0), state: 'no-rule' as const, mapping: ['f.ts'] },
      { ...mkNode('drop-empty', 0, 0), state: 'no-rule' as const, mapping: [] },
      { ...mkNode('verified-node', 0, 0), state: 'verified' as const, mapping: ['g.ts'] },
    ];
    const residue = buildResidue(nodes, ['z.ts', 'a.ts']);
    expect(residue.noRuleNodes).toEqual(['keep']);
    expect(residue.uncoveredFiles).toEqual(['a.ts', 'z.ts']);
  });

  it('buildWorklist reuses groupIssues — empty issues yield an empty worklist', () => {
    const check = { issues: [] } as unknown as CheckResult;
    expect(buildWorklist(check)).toEqual([]);
  });
});

function mkNode(p: string, outDeg: number, inDeg: number): PortalNode {
  return {
    path: p,
    name: p,
    type: 'module',
    parent: null,
    mapping: [],
    sourceFileCount: 0,
    isTest: false,
    checked: false,
    fresh: false,
    state: 'no-rule',
    rollupState: 'no-rule',
    effectiveAspects: [],
    notApplicable: [],
    relationsOut: Array.from({ length: outDeg }, (_, i) => ({ target: `t${i}`, type: 'calls' })),
    relationsIn: Array.from({ length: inDeg }, (_, i) => ({ source: `s${i}`, type: 'calls' })),
    suppressions: [],
    log: [],
  };
}

describe('portal rest builders — additional honest branches', () => {
  it('buildBoundary surfaces declaredOnly edges (sorted, deduped)', () => {
    const b = buildBoundary({
      phantom: [],
      declaredOnly: [
        { source: 'z', target: 'a' },
        { source: 'a', target: 'b' },
      ],
      forbiddenType: [],
    });
    expect(b.unknown).toBe(false);
    expect(b.declaredOnly).toEqual([
      { source: 'a', target: 'b' },
      { source: 'z', target: 'a' },
    ]);
  });

  it('buildWorklist maps grouped issues to rule/why/fix/nodes (deduped, sorted)', () => {
    const check = {
      issues: [
        {
          severity: 'error',
          code: 'unverified',
          rule: 'unverified',
          nodePath: 'node-b',
          messageData: { what: 'w', why: 'shared why', next: 'yg check --approve' },
        },
        {
          severity: 'error',
          code: 'unverified',
          rule: 'unverified',
          nodePath: 'node-a',
          messageData: { what: 'w', why: 'shared why', next: 'yg check --approve' },
        },
      ],
    } as unknown as CheckResult;
    const wl = buildWorklist(check);
    expect(wl).toHaveLength(1);
    expect(wl[0].rule).toBe('unverified');
    expect(wl[0].severity).toBe('error');
    expect(wl[0].why).toBe('shared why');
    expect(wl[0].fix).toBe('yg check --approve');
    expect(wl[0].nodes).toEqual(['node-a', 'node-b']); // sorted, deduped
  });
});
