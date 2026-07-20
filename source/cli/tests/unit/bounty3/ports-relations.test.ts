import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkUnpairedEvents,
  checkRelationTargets,
  checkNoCycles,
} from '../../../src/core/checks/relations.js';
import {
  checkArchitectureRelations,
  checkArchitectureParents,
  checkPortConsumes,
  checkPortAspectsDefined,
} from '../../../src/core/checks/architecture.js';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  getAspectStatusSources,
} from '../../../src/core/graph/aspects.js';
import type {
  Graph,
  GraphNode,
  NodeMeta,
  AspectDef,
  ArchitectureDef,
  RelationType,
} from '../../../src/model/graph.js';

// ============================================================================
// BOUNTY 3 — ports / relations: channel-6 propagation + port contracts +
// event pairing + architecture relation-target gating.
//
// WHAT THIS SUITE ADDS over the existing coverage. The channel-6 PROPAGATION
// side (computeEffectiveAspects over ports) is already exhaustively pinned by
// tests/unit/bounty/eff-ports.test.ts, and the four port CONTRACT codes plus
// relation-target-forbidden are pinned end-to-end by validator-constraints.test
// and the cli-ports* / cli-relations e2e suites. This suite instead drives the
// VALIDATION CHECK FUNCTIONS DIRECTLY (checkUnpairedEvents, checkPortConsumes,
// checkPortAspectsDefined, checkArchitectureRelations, checkArchitectureParents,
// checkRelationTargets, checkNoCycles) — which have NO direct unit tests today,
// only indirect coverage through the full validator() / spawned binary — and
// targets the BRANCHES and INVARIANTS those higher-level tests skip:
//
//   * event pairing keyed on node-path SETS (event_name is IGNORED — a
//     documented gap, see suspectedBugs), self-loop pairing, bidirectional
//     attribution, fan-out emitter/listener sets, dedup of pair targets.
//   * the empty-allowed-list invariant: relations: { calls: [] } forbids ALL
//     targets, whereas an ABSENT key is unconstrained — a one-character config
//     difference with opposite enforcement, never pinned directly.
//   * checkArchitectureRelations skips a node whose TYPE is undefined and a
//     relation whose TARGET is missing (those are other checks' jobs) — no
//     double-reporting.
//   * checkPortConsumes precedence on mixed valid/invalid consumes; event
//     relations (emits/listens) carry the consumes contract too; consumes on a
//     ports:{} (empty map) target is consumes-without-ports.
//   * checkPortAspectsDefined does NOT dedup across ports/consumers, and never
//     fires for a port that is declared-but-not-consumed.
//   * CROSS-CONSISTENCY invariants that, if broken, mean false-green / lost
//     drift: the SAME relation set that triggers port-missing-consumes is the
//     one that fails to propagate the aspect (channel 6), and a when-filtered
//     port aspect drops out of BOTH the effective set AND its status sources.
//
// Pure / hermetic: in-memory graph objects (no FS, no clock, no RNG) for the
// unit layer; the single E2E spawns the real binary against a temp copy of the
// committed sample-project-ports fixture, whose only aspect is deterministic.
// ============================================================================

// --- In-memory graph builders (mirror eff-ports.test.ts conventions) ---

function makeNode(nodePath: string, meta: Partial<NodeMeta> = {}): GraphNode {
  return {
    path: nodePath,
    meta: { name: nodePath, type: 'service', ...meta },
    children: [],
    parent: null,
  } as GraphNode;
}

function makeGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    config: {},
    architecture: { node_types: {} } as ArchitectureDef,
    nodes: new Map(),
    aspects: [],
    flows: [],
    rootPath: '/tmp/.yggdrasil',
    ...overrides,
  } as Graph;
}

function aspect(id: string, extra: Partial<AspectDef> = {}): AspectDef {
  return { name: id, id, reviewer: { type: 'llm' as const }, artifacts: [], ...extra } as AspectDef;
}

const codesOf = (issues: { code?: string }[]): string[] => issues.map((i) => i.code ?? '').sort();
const nodePathsOf = (issues: { nodePath?: string }[]): string[] =>
  issues.map((i) => i.nodePath ?? '').sort();

// ============================================================================
// 1. checkUnpairedEvents — event pairing keyed on NODE PATHS
// ============================================================================

describe('checkUnpairedEvents — pairing by node-path set', () => {
  it('a matched emits/listens pair (A emits→B, B listens→A) produces NO issue', () => {
    const nodes = new Map<string, GraphNode>([
      ['A', makeNode('A', { relations: [{ target: 'B', type: 'emits', event_name: 'Evt' }] })],
      ['B', makeNode('B', { relations: [{ target: 'A', type: 'listens', event_name: 'Evt' }] })],
    ]);
    expect(checkUnpairedEvents(makeGraph({ nodes }))).toEqual([]);
  });

  it('an emits with no listens half fires event-unpaired, attributed to the EMITTER', () => {
    const nodes = new Map<string, GraphNode>([
      ['A', makeNode('A', { relations: [{ target: 'B', type: 'emits', event_name: 'Evt' }] })],
      ['B', makeNode('B')],
    ]);
    const issues = checkUnpairedEvents(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['event-unpaired']);
    expect(issues[0].nodePath).toBe('A');
    expect(issues[0].severity).toBe('error');
  });

  it('a listens with no emits half fires event-unpaired, attributed to the LISTENER', () => {
    const nodes = new Map<string, GraphNode>([
      ['A', makeNode('A', { relations: [{ target: 'B', type: 'listens', event_name: 'Evt' }] })],
      ['B', makeNode('B')],
    ]);
    const issues = checkUnpairedEvents(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['event-unpaired']);
    expect(issues[0].nodePath).toBe('A');
  });

  it('the partial pairing in ONE direction is still unpaired in the OTHER (both halves reported)', () => {
    // A emits→B but B does NOT listen→A, AND B listens→A is the only listen but
    // there is no emit FROM A's perspective missing... construct a genuinely
    // one-sided graph: A emits→B (no B listens→A) and B listens→C (no C emits→B).
    const nodes = new Map<string, GraphNode>([
      ['A', makeNode('A', { relations: [{ target: 'B', type: 'emits', event_name: 'E1' }] })],
      ['B', makeNode('B', { relations: [{ target: 'C', type: 'listens', event_name: 'E2' }] })],
      ['C', makeNode('C')],
    ]);
    const issues = checkUnpairedEvents(makeGraph({ nodes }));
    // Two independent unpaired halves: A's emit and B's listen.
    expect(issues).toHaveLength(2);
    expect(nodePathsOf(issues)).toEqual(['A', 'B']);
  });

  it('a self-loop (A emits→A AND A listens→A) is considered paired — no issue', () => {
    const nodes = new Map<string, GraphNode>([
      [
        'A',
        makeNode('A', {
          relations: [
            { target: 'A', type: 'emits', event_name: 'Self' },
            { target: 'A', type: 'listens', event_name: 'Self' },
          ],
        }),
      ],
    ]);
    expect(checkUnpairedEvents(makeGraph({ nodes }))).toEqual([]);
  });

  it('a self emits→A WITHOUT a self listens→A is unpaired', () => {
    const nodes = new Map<string, GraphNode>([
      ['A', makeNode('A', { relations: [{ target: 'A', type: 'emits', event_name: 'Self' }] })],
    ]);
    const issues = checkUnpairedEvents(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['event-unpaired']);
  });

  it('fan-out: A emits→B and A emits→C; only B listens→A → C-half is the single unpaired error', () => {
    const nodes = new Map<string, GraphNode>([
      [
        'A',
        makeNode('A', {
          relations: [
            { target: 'B', type: 'emits', event_name: 'E' },
            { target: 'C', type: 'emits', event_name: 'E' },
          ],
        }),
      ],
      ['B', makeNode('B', { relations: [{ target: 'A', type: 'listens', event_name: 'E' }] })],
      ['C', makeNode('C')],
    ]);
    const issues = checkUnpairedEvents(makeGraph({ nodes }));
    expect(issues).toHaveLength(1);
    // The emitter (A) is named, and the message identifies the unmatched target C.
    expect(issues[0].nodePath).toBe('A');
    expect(issues[0].messageData.what).toContain('C');
  });

  it('duplicate emits to the same target collapse via the set — one pair, no spurious unpaired', () => {
    const nodes = new Map<string, GraphNode>([
      [
        'A',
        makeNode('A', {
          relations: [
            { target: 'B', type: 'emits', event_name: 'E' },
            { target: 'B', type: 'emits', event_name: 'E' },
          ],
        }),
      ],
      ['B', makeNode('B', { relations: [{ target: 'A', type: 'listens', event_name: 'E' }] })],
    ]);
    expect(checkUnpairedEvents(makeGraph({ nodes }))).toEqual([]);
  });

  it('purely structural relations (calls/uses/extends/implements) never trigger event pairing', () => {
    for (const type of ['calls', 'uses', 'extends', 'implements'] as RelationType[]) {
      const nodes = new Map<string, GraphNode>([
        ['A', makeNode('A', { relations: [{ target: 'B', type }] })],
        ['B', makeNode('B')],
      ]);
      expect(checkUnpairedEvents(makeGraph({ nodes })), `relation ${type}`).toEqual([]);
    }
  });

  // INVARIANT GAP: pairing ignores event_name. A emits 'OrderPlaced'→B paired
  // with B listens 'OrderShipped'→A is reported as PAIRED even though no single
  // event is actually paired. Pinned here as ACTUAL behavior (see suspectedBugs:
  // event-pairing-ignores-event-name).
  it('mismatched event_name across the pair is STILL treated as paired (node-path-only pairing)', () => {
    const nodes = new Map<string, GraphNode>([
      ['A', makeNode('A', { relations: [{ target: 'B', type: 'emits', event_name: 'OrderPlaced' }] })],
      ['B', makeNode('B', { relations: [{ target: 'A', type: 'listens', event_name: 'OrderShipped' }] })],
    ]);
    // Actual behavior: no issue, because pairing keys on (emitter, target) node
    // paths only and never compares event_name.
    expect(checkUnpairedEvents(makeGraph({ nodes }))).toEqual([]);
  });
});

// ============================================================================
// 2. checkArchitectureRelations — relation-target gating, incl. the empty-list
//    invariant (the high-value branch).
// ============================================================================

describe('checkArchitectureRelations — target-type gating', () => {
  const arch = (relations: Partial<Record<RelationType, string[]>>): ArchitectureDef => ({
    node_types: {
      service: { description: 'svc', relations },
      module: { description: 'mod' },
      library: { description: 'lib' },
    },
  });

  it('allowed target type → no issue', () => {
    const nodes = new Map<string, GraphNode>([
      ['a', makeNode('a', { type: 'service', relations: [{ target: 'b', type: 'calls' }] })],
      ['b', makeNode('b', { type: 'module' })],
    ]);
    expect(checkArchitectureRelations(makeGraph({ nodes, architecture: arch({ calls: ['module'] }) }))).toEqual([]);
  });

  it('disallowed target type → relation-target-forbidden naming the type and allowed list', () => {
    const nodes = new Map<string, GraphNode>([
      ['a', makeNode('a', { type: 'service', relations: [{ target: 'b', type: 'calls' }] })],
      ['b', makeNode('b', { type: 'library' })],
    ]);
    const issues = checkArchitectureRelations(makeGraph({ nodes, architecture: arch({ calls: ['module'] }) }));
    expect(codesOf(issues)).toEqual(['relation-target-forbidden']);
    expect(issues[0].nodePath).toBe('a');
    expect(issues[0].messageData.what).toContain('library');
    expect(issues[0].messageData.why).toContain('module');
  });

  // THE KEY INVARIANT: an EMPTY allowed list forbids ALL targets, whereas an
  // ABSENT key leaves the relation type unconstrained. These two configs differ
  // by one character but enforce the exact opposite.
  it('empty allowed list relations:{calls:[]} forbids EVERY target', () => {
    const nodes = new Map<string, GraphNode>([
      ['a', makeNode('a', { type: 'service', relations: [{ target: 'b', type: 'calls' }] })],
      ['b', makeNode('b', { type: 'module' })],
    ]);
    const issues = checkArchitectureRelations(makeGraph({ nodes, architecture: arch({ calls: [] }) }));
    expect(codesOf(issues)).toEqual(['relation-target-forbidden']);
    expect(issues[0].messageData.why).toContain('[]');
  });

  it('ABSENT relation-type key is unconstrained — any target passes', () => {
    const nodes = new Map<string, GraphNode>([
      // `calls` is not declared in the type's relations map at all.
      ['a', makeNode('a', { type: 'service', relations: [{ target: 'b', type: 'calls' }] })],
      ['b', makeNode('b', { type: 'library' })],
    ]);
    // relations only constrains `uses`, leaving `calls` unconstrained.
    expect(checkArchitectureRelations(makeGraph({ nodes, architecture: arch({ uses: ['module'] }) }))).toEqual([]);
  });

  it('a node whose TYPE is undefined in architecture is skipped (no false forbidden)', () => {
    const nodes = new Map<string, GraphNode>([
      ['a', makeNode('a', { type: 'ghost-type', relations: [{ target: 'b', type: 'calls' }] })],
      ['b', makeNode('b', { type: 'module' })],
    ]);
    expect(checkArchitectureRelations(makeGraph({ nodes, architecture: arch({ calls: [] }) }))).toEqual([]);
  });

  it('a relation to a MISSING target node is skipped here (relation-broken is another check)', () => {
    const nodes = new Map<string, GraphNode>([
      ['a', makeNode('a', { type: 'service', relations: [{ target: 'ghost', type: 'calls' }] })],
    ]);
    expect(checkArchitectureRelations(makeGraph({ nodes, architecture: arch({ calls: [] }) }))).toEqual([]);
  });

  it('a node with no relations at all contributes nothing', () => {
    const nodes = new Map<string, GraphNode>([['a', makeNode('a', { type: 'service' })]]);
    expect(checkArchitectureRelations(makeGraph({ nodes, architecture: arch({ calls: [] }) }))).toEqual([]);
  });

  it('multiple forbidden relations on one node each produce their own issue', () => {
    const nodes = new Map<string, GraphNode>([
      [
        'a',
        makeNode('a', {
          type: 'service',
          relations: [
            { target: 'b', type: 'calls' },
            { target: 'c', type: 'calls' },
          ],
        }),
      ],
      ['b', makeNode('b', { type: 'library' })],
      ['c', makeNode('c', { type: 'library' })],
    ]);
    const issues = checkArchitectureRelations(makeGraph({ nodes, architecture: arch({ calls: ['module'] }) }));
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.code === 'relation-target-forbidden')).toBe(true);
  });
});

// ============================================================================
// 3. checkArchitectureParents — parent-type gating (sibling of relation gating)
// ============================================================================

describe('checkArchitectureParents — parent-type gating', () => {
  it('allowed parent type → no issue', () => {
    const parent = makeNode('p', { type: 'module' });
    const child = makeNode('p/c', { type: 'service' });
    child.parent = parent;
    const nodes = new Map<string, GraphNode>([['p', parent], ['p/c', child]]);
    const architecture: ArchitectureDef = {
      node_types: { service: { description: 's', parents: ['module'] }, module: { description: 'm' } },
    };
    expect(checkArchitectureParents(makeGraph({ nodes, architecture }))).toEqual([]);
  });

  it('disallowed parent type → parent-type-forbidden', () => {
    const parent = makeNode('p', { type: 'library' });
    const child = makeNode('p/c', { type: 'service' });
    child.parent = parent;
    const nodes = new Map<string, GraphNode>([['p', parent], ['p/c', child]]);
    const architecture: ArchitectureDef = {
      node_types: {
        service: { description: 's', parents: ['module'] },
        module: { description: 'm' },
        library: { description: 'l' },
      },
    };
    const issues = checkArchitectureParents(makeGraph({ nodes, architecture }));
    expect(codesOf(issues)).toEqual(['parent-type-forbidden']);
    expect(issues[0].nodePath).toBe('p/c');
    expect(issues[0].messageData.what).toContain('library');
  });

  it('a root node (no parent) is never checked even when its type restricts parents', () => {
    const root = makeNode('p', { type: 'service' });
    const nodes = new Map<string, GraphNode>([['p', root]]);
    const architecture: ArchitectureDef = {
      node_types: { service: { description: 's', parents: ['module'] }, module: { description: 'm' } },
    };
    expect(checkArchitectureParents(makeGraph({ nodes, architecture }))).toEqual([]);
  });
});

// ============================================================================
// 4. checkPortConsumes — the consumes contract (missing-consumes / unknown-port
//    / consumes-without-ports), including event relations and mixed lists.
// ============================================================================

describe('checkPortConsumes — consumes contract', () => {
  it('target has ports but consumer omits consumes → port-missing-consumes (lists port names)', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: '', aspects: ['ct'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls' }] })],
    ]);
    const issues = checkPortConsumes(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['port-missing-consumes']);
    expect(issues[0].messageData.why).toContain('charge');
  });

  it('consumes references a non-existent port → port-undefined (echoes the bad name)', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: '', aspects: ['ct'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['ghost'] }] })],
    ]);
    const issues = checkPortConsumes(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['port-undefined']);
    expect(issues[0].messageData.what).toContain('ghost');
  });

  it('mixed consumes [valid, invalid] → exactly one port-undefined for the invalid name only', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: '', aspects: ['ct'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['charge', 'ghost'] }] })],
    ]);
    const issues = checkPortConsumes(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['port-undefined']);
    expect(issues[0].messageData.what).toContain('ghost');
    expect(issues[0].messageData.what).not.toContain('charge');
  });

  it('two distinct unknown ports → two port-undefined issues', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: '', aspects: ['ct'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['g1', 'g2'] }] })],
    ]);
    expect(checkPortConsumes(makeGraph({ nodes }))).toHaveLength(2);
  });

  it('valid consume → no issue', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: '', aspects: ['ct'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['charge'] }] })],
    ]);
    expect(checkPortConsumes(makeGraph({ nodes }))).toEqual([]);
  });

  it('consumes on a target with NO ports → consumes-without-ports', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p')],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['anything'] }] })],
    ]);
    expect(codesOf(checkPortConsumes(makeGraph({ nodes })))).toEqual(['consumes-without-ports']);
  });

  it('consumes on a target with an EMPTY ports map {} → consumes-without-ports (empty map == no ports)', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: {} })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['anything'] }] })],
    ]);
    expect(codesOf(checkPortConsumes(makeGraph({ nodes })))).toEqual(['consumes-without-ports']);
  });

  it('an empty ports map {} with a BARE relation does NOT fire missing-consumes', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: {} })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls' }] })],
    ]);
    expect(checkPortConsumes(makeGraph({ nodes }))).toEqual([]);
  });

  it('event relations (emits/listens) carry the consumes contract too — missing-consumes fires', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: '', aspects: ['ct'] } } })],
      ['emit', makeNode('emit', { relations: [{ target: 'p', type: 'emits', event_name: 'E' }] })],
      ['listen', makeNode('listen', { relations: [{ target: 'p', type: 'listens', event_name: 'E' }] })],
    ]);
    const issues = checkPortConsumes(makeGraph({ nodes }));
    expect(issues.every((i) => i.code === 'port-missing-consumes')).toBe(true);
    expect(nodePathsOf(issues)).toEqual(['emit', 'listen']);
  });

  it('a relation to a MISSING target WITH consumes is treated as a target with no ports → consumes-without-ports', () => {
    // A missing target resolves to `undefined`, so hasPorts is false; with a
    // consumes list present, checkPortConsumes reports consumes-without-ports.
    // (The broken target itself is separately reported by checkRelationTargets;
    // see suspectedBugs: consumes-without-ports-on-broken-target for the quality
    // note that this double-reports a confusing reason on a non-existent target.)
    const nodes = new Map<string, GraphNode>([
      ['c', makeNode('c', { relations: [{ target: 'ghost', type: 'calls', consumes: ['charge'] }] })],
    ]);
    expect(codesOf(checkPortConsumes(makeGraph({ nodes })))).toEqual(['consumes-without-ports']);
  });

  it('a relation to a MISSING target WITHOUT consumes contributes nothing in this check', () => {
    const nodes = new Map<string, GraphNode>([
      ['c', makeNode('c', { relations: [{ target: 'ghost', type: 'calls' }] })],
    ]);
    expect(checkPortConsumes(makeGraph({ nodes }))).toEqual([]);
  });
});

// ============================================================================
// 5. checkPortAspectsDefined — port contract aspects must be defined
// ============================================================================

describe('checkPortAspectsDefined — port-required aspect must exist', () => {
  it('consumed port requires an undefined aspect → port-missing-aspect on the consumer', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: '', aspects: ['ghost'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['charge'] }] })],
    ]);
    const issues = checkPortAspectsDefined(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['port-missing-aspect']);
    expect(issues[0].nodePath).toBe('c');
    expect(issues[0].messageData.what).toContain('ghost');
  });

  it('defined aspect → no issue', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: '', aspects: ['ct'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['charge'] }] })],
    ]);
    expect(checkPortAspectsDefined(makeGraph({ nodes, aspects: [aspect('ct')] }))).toEqual([]);
  });

  it('a declared-but-NOT-consumed port with a missing aspect is NOT reported (contract only on consumers)', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: '', aspects: ['ghost'] } } })],
      // bare relation — does not consume the port
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls' }] })],
    ]);
    expect(checkPortAspectsDefined(makeGraph({ nodes }))).toEqual([]);
  });

  it('two consumed ports sharing the same missing aspect produce TWO issues (no dedup)', () => {
    const nodes = new Map<string, GraphNode>([
      [
        'p',
        makeNode('p', {
          ports: {
            a: { description: '', aspects: ['ghost'] },
            b: { description: '', aspects: ['ghost'] },
          },
        }),
      ],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['a', 'b'] }] })],
    ]);
    // No dedup: one issue per (port, missing-aspect) pair. Pinned actual behavior.
    expect(checkPortAspectsDefined(makeGraph({ nodes }))).toHaveLength(2);
  });

  it('consuming an UNKNOWN port (no such port) is a no-op here (unknown-port is checkPortConsumes job)', () => {
    const nodes = new Map<string, GraphNode>([
      ['p', makeNode('p', { ports: { charge: { description: '', aspects: ['ghost'] } } })],
      ['c', makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['nope'] }] })],
    ]);
    expect(checkPortAspectsDefined(makeGraph({ nodes }))).toEqual([]);
  });
});

// ============================================================================
// 6. checkRelationTargets / checkNoCycles — structural relation integrity
// ============================================================================

describe('checkRelationTargets — relation target must exist', () => {
  it('a relation to a non-existent node → relation-broken naming the target', () => {
    const nodes = new Map<string, GraphNode>([
      ['a', makeNode('a', { relations: [{ target: 'ghost/node', type: 'uses' }] })],
    ]);
    const issues = checkRelationTargets(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['relation-broken']);
    expect(issues[0].nodePath).toBe('a');
    expect(issues[0].messageData.what).toContain('ghost/node');
  });

  it('a valid relation target → no issue', () => {
    const nodes = new Map<string, GraphNode>([
      ['a', makeNode('a', { relations: [{ target: 'b', type: 'uses' }] })],
      ['b', makeNode('b')],
    ]);
    expect(checkRelationTargets(makeGraph({ nodes }))).toEqual([]);
  });
});

describe('checkNoCycles — structural relations only', () => {
  it('a structural self-loop (A uses→A) is a structural-cycle', () => {
    const nodes = new Map<string, GraphNode>([
      ['A', makeNode('A', { relations: [{ target: 'A', type: 'uses' }] })],
    ]);
    const issues = checkNoCycles(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['structural-cycle']);
    expect(issues[0].messageData.what).toContain('A -> A');
  });

  it('a two-node structural cycle (A uses→B, B uses→A) is reported', () => {
    const nodes = new Map<string, GraphNode>([
      ['A', makeNode('A', { relations: [{ target: 'B', type: 'uses' }] })],
      ['B', makeNode('B', { relations: [{ target: 'A', type: 'uses' }] })],
    ]);
    expect(codesOf(checkNoCycles(makeGraph({ nodes })))).toEqual(['structural-cycle']);
  });

  // REGRESSION: a node that merely depends INTO a cycle member (but is not
  // itself part of any cycle) must NOT be reported. The DFS must finalize
  // (BLACK) every node on an aborted cycle-discovery path, otherwise cycle
  // members stay GRAY and a later, unrelated DFS root fabricates a spurious
  // structural-cycle against the innocent downstream node.
  it('a node depending INTO a cycle member is not spuriously reported', () => {
    const nodes = new Map<string, GraphNode>([
      ['A', makeNode('A', { relations: [{ target: 'B', type: 'uses' }] })],
      ['B', makeNode('B', { relations: [{ target: 'A', type: 'uses' }] })],
      ['C', makeNode('C', { relations: [{ target: 'A', type: 'uses' }] })],
    ]);
    const issues = checkNoCycles(makeGraph({ nodes }));
    expect(codesOf(issues)).toEqual(['structural-cycle']);
    for (const issue of issues) {
      expect(issue.messageData.what).not.toContain('C ->');
    }
  });

  // INVARIANT: event relations are EXCLUDED from cycle detection — an
  // emits/listens loop between two nodes is the NORMAL paired form, not a cycle.
  it('an emits/listens loop between two nodes is NOT a structural cycle', () => {
    const nodes = new Map<string, GraphNode>([
      ['A', makeNode('A', { relations: [{ target: 'B', type: 'emits', event_name: 'E' }] })],
      ['B', makeNode('B', { relations: [{ target: 'A', type: 'emits', event_name: 'E' }] })],
    ]);
    expect(checkNoCycles(makeGraph({ nodes }))).toEqual([]);
  });
});

// ============================================================================
// 7. CROSS-CONSISTENCY INVARIANTS — the high-value false-green guards.
//
// These tie the VALIDATION layer (port contract codes) to the PROPAGATION layer
// (channel 6 effective aspects). If either side drifts from the other, you get
// either lost enforcement (aspect propagates but contract is silent) or noise
// (contract fires but nothing propagates). Both must agree.
// ============================================================================

describe('cross-consistency — contract codes agree with channel-6 propagation', () => {
  it('a bare relation: BOTH no aspect propagates AND port-missing-consumes fires', () => {
    const provider = makeNode('p', { ports: { charge: { description: '', aspects: ['ct'] } } });
    const consumer = makeNode('c', { relations: [{ target: 'p', type: 'calls' }] }); // bare
    const nodes = new Map<string, GraphNode>([['p', provider], ['c', consumer]]);
    const graph = makeGraph({ nodes, aspects: [aspect('ct')] });

    // Propagation side: nothing reaches the consumer.
    expect(computeEffectiveAspects(consumer, graph).size).toBe(0);
    // Contract side: the missing consumes is flagged.
    expect(codesOf(checkPortConsumes(graph))).toEqual(['port-missing-consumes']);
  });

  it('a valid consume: the aspect propagates AND no contract code fires', () => {
    const provider = makeNode('p', { ports: { charge: { description: '', aspects: ['ct'] } } });
    const consumer = makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['charge'] }] });
    const nodes = new Map<string, GraphNode>([['p', provider], ['c', consumer]]);
    const graph = makeGraph({ nodes, aspects: [aspect('ct')] });

    expect(computeEffectiveAspects(consumer, graph).has('ct')).toBe(true);
    expect(checkPortConsumes(graph)).toEqual([]);
    expect(checkPortAspectsDefined(graph)).toEqual([]);
  });

  it('consuming an unknown port: nothing propagates AND port-undefined fires (no silent enforcement)', () => {
    const provider = makeNode('p', { ports: { charge: { description: '', aspects: ['ct'] } } });
    const consumer = makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['ghost'] }] });
    const nodes = new Map<string, GraphNode>([['p', provider], ['c', consumer]]);
    const graph = makeGraph({ nodes, aspects: [aspect('ct')] });

    expect(computeEffectiveAspects(consumer, graph).size).toBe(0);
    expect(codesOf(checkPortConsumes(graph))).toEqual(['port-undefined']);
  });

  it('port-missing-aspect implies the SAME aspect id is what would be effective on the consumer', () => {
    // The contract names aspect 'ghost'; channel 6 would make 'ghost' effective
    // had it been defined. The two layers reference the identical id.
    const provider = makeNode('p', { ports: { charge: { description: '', aspects: ['ghost'] } } });
    const consumer = makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['charge'] }] });
    const nodes = new Map<string, GraphNode>([['p', provider], ['c', consumer]]);
    const graph = makeGraph({ nodes }); // 'ghost' NOT defined

    const contractIssues = checkPortAspectsDefined(graph);
    expect(contractIssues).toHaveLength(1);
    expect(contractIssues[0].messageData.what).toContain('ghost');
    // The propagation layer still makes the (undefined) id effective by id —
    // proving the contract guards exactly the id the consumer would inherit.
    expect(computeEffectiveAspects(consumer, graph).has('ghost')).toBe(true);
  });

  it('a when-filtered port aspect drops out of BOTH the effective set AND the status sources', () => {
    // Port-site when references a node type the consumer is NOT, so the aspect
    // must vanish from every downstream view consistently.
    const provider = makeNode('p', {
      ports: {
        charge: {
          description: '',
          aspects: ['ct'],
          aspectWhens: { ct: { node: { type: 'command' } } }, // consumer is 'service' → false
        },
      },
    });
    const consumer = makeNode('c', {
      type: 'service',
      relations: [{ target: 'p', type: 'calls', consumes: ['charge'] }],
    });
    const nodes = new Map<string, GraphNode>([['p', provider], ['c', consumer]]);
    const graph = makeGraph({ nodes, aspects: [aspect('ct')] });

    expect(computeEffectiveAspects(consumer, graph).has('ct')).toBe(false);
    expect(computeEffectiveAspectStatuses(consumer, graph).has('ct')).toBe(false);
    expect(getAspectStatusSources(consumer, 'ct', graph)).toEqual([]);
  });

  it('port aspect status default flows through channel 6 (enforced when no override)', () => {
    const provider = makeNode('p', { ports: { charge: { description: '', aspects: ['ct'] } } });
    const consumer = makeNode('c', { relations: [{ target: 'p', type: 'calls', consumes: ['charge'] }] });
    const nodes = new Map<string, GraphNode>([['p', provider], ['c', consumer]]);
    const graph = makeGraph({ nodes, aspects: [aspect('ct')] }); // no status → enforced default
    expect(computeEffectiveAspectStatuses(consumer, graph).get('ct')).toBe('enforced');
  });
});

// ============================================================================
// 8. E2E — spawn the real binary against a temp copy of sample-project-ports.
//    Asserts the observed exit code + rendered output for: (a) a clean port
//    contract approves + checks green; (b) consuming an undefined port is a
//    blocking check error. Deterministic aspect only — no LLM, no network.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const PORTS_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-ports');
const distExists = existsSync(BIN_PATH) && existsSync(PORTS_FIXTURE);

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function copyPortsFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-b3-${label}-`));
  tempDirs.push(dir);
  cpSync(PORTS_FIXTURE, dir, { recursive: true });
  return dir;
}

function run(args: string[], cwd: string): { status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: result.status, all: (result.stdout ?? '') + (result.stderr ?? '') };
}

describe.skipIf(!distExists)('E2E — ports/relations contract through the real binary', () => {
  it('clean port contract: fill the consumer (deterministic, zero LLM) then check is green', () => {
    const dir = copyPortsFixture('clean');
    // The consumer's only effective aspect is the deterministic charge-port
    // aspect; filling the lock records a verdict with no LLM call.
    const fill = run(['check', '--approve'], dir);
    expect(fill.status).toBe(0);
    const check = run(['check'], dir);
    expect(check.status).toBe(0);
    expect(check.all).toContain('PASS');
  });

  it('consuming an undefined port fails check with port-undefined (exit 1) and echoes the bad name', () => {
    const dir = copyPortsFixture('undefined-port');
    const consumerYaml = path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
    const yaml = readFileSync(consumerYaml, 'utf-8').replace('consumes: [charge]', 'consumes: [phantom]');
    writeFileSync(consumerYaml, yaml, 'utf-8');

    const check = run(['check'], dir);
    expect(check.status).toBe(1);
    expect(check.all).toContain('port-undefined');
    expect(check.all).toContain('phantom');
  });

  // Guard against a silently-broken fixture path: ensure the helper actually
  // created a graph (mkdirSync used elsewhere is real, this asserts the copy).
  it('the temp fixture copy contains the provider node yaml (hermetic-copy guard)', () => {
    const dir = copyPortsFixture('guard');
    expect(existsSync(path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml'))).toBe(true);
  });
});
