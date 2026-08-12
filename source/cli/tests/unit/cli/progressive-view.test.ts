import { describe, it, expect } from 'vitest';
import {
  splitIssuesByScope,
  renderProgressiveViewLine,
} from '../../../src/cli/progressive-view.js';
import { progressivePairKey, type BurnSet } from '../../../src/core/progressive-scope.js';
import type { CheckIssue } from '../../../src/core/check-contract.js';
import type { ExpectedPair } from '../../../src/core/pairs.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';

// ---------------------------------------------------------------------------
// The two pure halves of the progressive view: how a finished report's findings
// are split into "this change is accountable for it" and "it was already there",
// and the sentence that reports the split.
//
// Everything the split needs arrives already resolved, so these can be pinned
// without a repository. The end-to-end behavior over a real one lives in
// tests/e2e/cli-progressive-view.test.ts.
//
// The property under test throughout is the DIRECTION of the conservatism: a
// finding may only be called outside the change when something positively
// attributes it there. Every uncertainty must fall the other way.
// ---------------------------------------------------------------------------

function makeNode(nodePath: string): GraphNode {
  return {
    path: nodePath,
    meta: { name: nodePath, type: 'library' },
    children: [],
    parent: null,
  } as unknown as GraphNode;
}

function makeGraph(nodePaths: string[]): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(nodePaths.map((p) => [p, makeNode(p)])),
    aspects: [],
    flows: [],
    rootPath: '/tmp/.yggdrasil',
  } as unknown as Graph;
}

function makeBurn(overrides: Partial<BurnSet> = {}): BurnSet {
  return {
    global: false,
    pairKeys: new Set(),
    nodePaths: new Set(),
    files: new Set(),
    logOnlyNodePaths: new Set(),
    changedInputCount: 0,
    ...overrides,
  };
}

function makePair(aspectId: string, unitKey: string, nodePath?: string): ExpectedPair {
  return {
    aspectId,
    kind: 'deterministic',
    unitKey,
    nodePath,
    status: 'enforced',
    subjectFiles: [],
  } as ExpectedPair;
}

const issue = (over: Partial<CheckIssue>): CheckIssue =>
  ({ severity: 'error', code: 'x', rule: 'x', messageData: { what: '', why: '', next: '' }, ...over }) as CheckIssue;

describe('splitIssuesByScope', () => {
  it('counts a burned pair in scope and an unburned one outside', () => {
    const graph = makeGraph(['alpha', 'beta']);
    const pairs = [makePair('r', 'node:alpha', 'alpha'), makePair('r', 'node:beta', 'beta')];
    const burn = makeBurn({ pairKeys: new Set([progressivePairKey('r', 'node:alpha')]) });

    const split = splitIssuesByScope(
      [
        issue({ aspectId: 'r', unitKey: 'node:alpha', nodePath: 'alpha' }),
        issue({ aspectId: 'r', unitKey: 'node:beta', nodePath: 'beta' }),
      ],
      graph,
      burn,
      pairs,
    );

    expect(split).toEqual({ inScope: 1, outside: 1, global: false });
  });

  it('counts a finding naming an obligation the enumeration never saw as IN scope, not outside', () => {
    // The decisive case for the conservative direction. The finding names a pair
    // that is not in the burn set — but it is not in the enumerated universe
    // either, so nothing here can speak to whether the change reached it.
    // Reporting it outside would claim a real finding is none of the change's
    // business on the strength of not having looked.
    const graph = makeGraph(['alpha']);
    const split = splitIssuesByScope(
      [issue({ aspectId: 'r', unitKey: 'file:src/unknown.ts' })],
      graph,
      makeBurn(),
      [makePair('r', 'node:alpha', 'alpha')],
    );

    expect(split).toEqual({ inScope: 1, outside: 0, global: false });
  });

  it('trusts a component key only when it names a real component', () => {
    // Several finding kinds put a synthetic label where a component path goes
    // (a rule id dressed as a path). Probing the burn set with one would answer
    // "outside" about something that was never a component to begin with.
    const graph = makeGraph(['alpha']);
    const split = splitIssuesByScope(
      [
        issue({ nodePath: 'alpha' }), // real, and not burned -> outside
        issue({ nodePath: 'aspects/some-rule' }), // synthetic -> unattributable
      ],
      graph,
      makeBurn(),
      [],
    );

    expect(split).toEqual({ inScope: 1, outside: 1, global: false });
  });

  it("puts a component's log finding in scope when only its log changed", () => {
    const graph = makeGraph(['alpha']);
    const split = splitIssuesByScope(
      [issue({ nodePath: 'alpha', code: 'log-missing' })],
      graph,
      makeBurn({ logOnlyNodePaths: new Set(['alpha']) }),
      [],
    );

    expect(split.inScope).toBe(1);
  });

  it('attributes a per-file finding through its unit key', () => {
    const graph = makeGraph([]);
    const split = splitIssuesByScope(
      [
        issue({ unitKey: 'file:src/touched.ts' }),
        issue({ unitKey: 'file:src/untouched.ts' }),
      ],
      graph,
      makeBurn({ files: new Set(['src/touched.ts']) }),
      [],
    );

    expect(split).toEqual({ inScope: 1, outside: 1, global: false });
  });

  it('keeps a multi-file coverage finding whole: any changed member puts all of it in scope', () => {
    const graph = makeGraph([]);
    const burn = makeBurn({ files: new Set(['src/b.ts']) });

    expect(
      splitIssuesByScope(
        [issue({ code: 'unmapped-files', uncoveredFiles: ['src/a.ts', 'src/b.ts'] })],
        graph,
        burn,
        [],
      ).inScope,
    ).toBe(1);
    expect(
      splitIssuesByScope(
        [issue({ code: 'unmapped-files', uncoveredFiles: ['src/a.ts'] })],
        graph,
        burn,
        [],
      ).outside,
    ).toBe(1);
  });

  it('counts a finding with no identity at all as in scope', () => {
    const split = splitIssuesByScope([issue({ code: 'rules-digest-stale' })], makeGraph([]), makeBurn(), []);
    expect(split).toEqual({ inScope: 1, outside: 0, global: false });
  });

  it('puts everything in scope when the change reached something unbounded', () => {
    const graph = makeGraph(['alpha']);
    const split = splitIssuesByScope(
      [issue({ aspectId: 'r', unitKey: 'node:alpha' }), issue({ nodePath: 'alpha' })],
      graph,
      makeBurn({ global: true }),
      [makePair('r', 'node:alpha', 'alpha')],
    );

    expect(split).toEqual({ inScope: 2, outside: 0, global: true });
  });

  it('reports an empty report as an empty split rather than dividing by nothing', () => {
    expect(splitIssuesByScope([], makeGraph([]), makeBurn(), [])).toEqual({
      inScope: 0,
      outside: 0,
      global: false,
    });
  });
});

describe('renderProgressiveViewLine', () => {
  it('states the ratio, the reference, and that nothing about the build changed', () => {
    expect(renderProgressiveViewLine({ inScope: 2, outside: 5, global: false }, 'origin/main')).toBe(
      'progressive view: 2 of 7 issue(s) within scope of origin/main (5 outside) — gate unchanged in this build',
    );
  });

  it('says WHY nothing is outside when the change reached the whole graph', () => {
    // A bare "(0 outside)" here would read as a coincidence of this change
    // rather than the consequence of what it touched.
    expect(renderProgressiveViewLine({ inScope: 4, outside: 0, global: true }, 'main')).toBe(
      'progressive view: 4 of 4 issue(s) within scope of main (0 outside; this change reaches the whole graph) — gate unchanged in this build',
    );
  });

  it('reads honestly for a clean report with nothing to split', () => {
    expect(renderProgressiveViewLine({ inScope: 0, outside: 0, global: false }, 'main')).toBe(
      'progressive view: 0 of 0 issue(s) within scope of main (0 outside) — gate unchanged in this build',
    );
  });
});
