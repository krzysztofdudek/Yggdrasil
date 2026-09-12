import { describe, it, expect } from 'vitest';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  getAspectSource,
  getAspectStatusSources,
} from '../../../../src/core/graph/aspects.js';
import type { Graph, GraphNode, AspectDef } from '../../../../src/model/graph.js';

// ============================================================================
// Characterization test for the aspect cascade engine.
//
// Locks the EXACT current outputs of all four cascade functions over one rich
// graph that exercises every channel (1 own, 2 ancestor-node, 3 own-type,
// 4 ancestor-type, 5 flow-via-parent, 6 port) plus implies propagation, a global
// `when` filter, per-attach status overrides, and a draft aspect. The inline
// snapshots are captured from the pre-refactor implementation; any change in
// behavior from the iterateAttachments unification will fail these.
// ============================================================================

// A `when` predicate that is false for this node (type 'service', not 'command'),
// so the aspect carrying it is filtered out.
const ALWAYS_FALSE = { node: { type: 'command' } } as unknown;

function aspect(over: Partial<AspectDef> & { id: string }): AspectDef {
  return {
    name: over.id,
    reviewer: { type: 'llm' },
    artifacts: [{ filename: 'content.md', content: '' }, { filename: 'yg-aspect.yaml', content: '' }],
    ...over,
  } as AspectDef;
}

function buildRichGraph(): { graph: Graph; node: GraphNode } {
  const parent: GraphNode = {
    path: 'mod',
    meta: { name: 'mod', type: 'module', aspects: ['B'] },
    children: [],
    parent: null,
  };
  const node: GraphNode = {
    path: 'mod/svc',
    meta: {
      name: 'svc',
      type: 'service',
      // channel 1: own — A (override to advisory), C (filtered by global when), D (draft)
      aspects: ['A', 'C', 'D'],
      aspectStatus: { A: 'advisory' },
      relations: [{ target: 'dep', type: 'uses', portNames: ['port1'] }],
    },
    children: [],
    parent,
  };
  parent.children = [node];

  const dep: GraphNode = {
    path: 'dep',
    meta: {
      name: 'dep',
      type: 'library',
      ports: { port1: { description: '', aspects: ['P'] } },
    },
    children: [],
    parent: null,
  };

  const graph = {
    config: {},
    architecture: {
      node_types: {
        service: { description: '', aspects: ['T'] }, // channel 3
        module: { description: '', aspects: ['PT'] }, // channel 4 (on parent)
        library: { description: '' },
      },
    },
    nodes: new Map([['mod', parent], ['mod/svc', node], ['dep', dep]]),
    aspects: [
      aspect({ id: 'A', status: 'enforced', implies: ['B'] }), // A implies B (channel 7)
      aspect({ id: 'B', status: 'advisory' }),
      aspect({ id: 'C', status: 'enforced', when: ALWAYS_FALSE as AspectDef['when'] }), // filtered out
      aspect({ id: 'D', status: 'draft' }),
      aspect({ id: 'P', status: 'enforced' }),
      aspect({ id: 'T', status: 'enforced' }),
      aspect({ id: 'PT', status: 'advisory' }),
      aspect({ id: 'F', status: 'advisory' }),
    ],
    flows: [
      // channel 5: flow includes the PARENT 'mod' (not the node directly) → via-parent origin
      { path: 'flow1', name: 'flow1', description: '', nodes: ['mod'], aspects: ['F'] },
    ],
    rootPath: '/tmp',
  } as unknown as Graph;

  return { graph, node };
}

describe('aspect cascade — characterization (locks behavior across the iterateAttachments unification)', () => {
  const { graph, node } = buildRichGraph();

  it('computeEffectiveAspects', () => {
    const ids = [...computeEffectiveAspects(node, graph)].sort();
    expect(ids).toMatchInlineSnapshot(`
      [
        "A",
        "B",
        "D",
        "F",
        "P",
        "PT",
        "T",
      ]
    `);
  });

  it('computeEffectiveAspectStatuses', () => {
    const statuses = [...computeEffectiveAspectStatuses(node, graph).entries()].sort();
    expect(statuses).toMatchInlineSnapshot(`
      [
        [
          "A",
          "advisory",
        ],
        [
          "B",
          "advisory",
        ],
        [
          "D",
          "draft",
        ],
        [
          "F",
          "advisory",
        ],
        [
          "P",
          "enforced",
        ],
        [
          "PT",
          "advisory",
        ],
        [
          "T",
          "enforced",
        ],
      ]
    `);
  });

  it('getAspectSource for every aspect id', () => {
    const sources = ['A', 'B', 'C', 'D', 'P', 'T', 'PT', 'F'].map((id) => [id, getAspectSource(id, node, graph)]);
    expect(sources).toMatchInlineSnapshot(`
      [
        [
          "A",
          "own declaration",
        ],
        [
          "B",
          "inherited from parent 'mod'",
        ],
        [
          "C",
          "own declaration",
        ],
        [
          "D",
          "own declaration",
        ],
        [
          "P",
          "port 'port1' on 'dep'",
        ],
        [
          "T",
          "architecture (type: service)",
        ],
        [
          "PT",
          "inherited from parent (type: module)",
        ],
        [
          "F",
          "flow 'flow1' (via parent 'mod')",
        ],
      ]
    `);
  });

  it('getAspectStatusSources for a multi-channel aspect (B: own-parent + implied)', () => {
    expect(getAspectStatusSources(node, 'B', graph)).toMatchInlineSnapshot(`
      [
        {
          "channel": 2,
          "declared": "advisory",
          "origin": "ancestor:mod",
        },
      ]
    `);
  });

  it('getAspectStatusSources for own aspect A (status override)', () => {
    expect(getAspectStatusSources(node, 'A', graph)).toMatchInlineSnapshot(`
      [
        {
          "channel": 1,
          "declared": "advisory",
          "origin": "own:mod/svc",
        },
      ]
    `);
  });

  it('getAspectStatusSources for flow aspect F (channel 5)', () => {
    expect(getAspectStatusSources(node, 'F', graph)).toMatchInlineSnapshot(`
      [
        {
          "channel": 5,
          "declared": "advisory",
          "origin": "flow:flow1",
        },
      ]
    `);
  });

  it('getAspectStatusSources for port aspect P (channel 6)', () => {
    expect(getAspectStatusSources(node, 'P', graph)).toMatchInlineSnapshot(`
      [
        {
          "channel": 6,
          "declared": "enforced",
          "origin": "port:port1@dep",
        },
      ]
    `);
  });
});
