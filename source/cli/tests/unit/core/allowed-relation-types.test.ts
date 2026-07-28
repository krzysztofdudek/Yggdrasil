/**
 * R1 relocation test: allowedRelationTypes/RELATION_TYPES moved out of
 * relations/allowed-types.ts into this engine module (core/allowed-relation-types.ts)
 * so both the relation-conformance pass and the live type-relation gate can share one
 * implementation without a relations-adapter-to-relations-adapter edge for logic that
 * is really engine-layer.
 *
 * These tests are a COPY of the pre-existing allowedRelationTypes coverage that lived
 * inside tests/unit/relations/messages.test.ts (there is no dedicated allowed-types.test.ts
 * — its behavior tests are interleaved there with relationRefusedMessage/relationUnverifiedMessage
 * tests, which stay in place since they exercise relations/messages.ts, not this relocation).
 * Only the import path changes; the assertions are unchanged, proving the moved
 * implementation behaves identically at its new home.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { allowedRelationTypes } from '../../../src/core/allowed-relation-types.js';
import { parseArchitecture } from '../../../src/io/architecture-parser.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

function node(nodePath: string, type: string): GraphNode {
  return {
    path: nodePath,
    meta: { name: nodePath.split('/').pop() ?? nodePath, type },
    children: [],
    parent: null,
  };
}

/**
 * Architecture. NOTE the validator semantics (mirrored by allowedRelationTypes):
 * a relation type ABSENT from a type's `relations:` table is UNCONSTRAINED — it
 * may target any node type. A PRESENT relation type constrains its targets.
 *
 *   service: every relation type present, each with an explicit target list →
 *            fully constrained, so dead-ends are reachable. uses→[service,
 *            repository], calls→[service], the other four → [] (nothing).
 *   repository: NO relations table → every relation type unconstrained.
 *   gateway: present in the graph as a target type that service never lists.
 */
function makeGraph(nodes: Array<[string, string]>): Graph {
  return {
    config: {},
    architecture: {
      node_types: {
        service: {
          description: 'svc',
          relations: {
            uses: ['service', 'repository'],
            calls: ['service'],
            extends: [],
            implements: [],
            emits: [],
            listens: [],
          },
        },
        repository: { description: 'repo' },
        gateway: { description: 'gw' },
      },
    },
    nodes: new Map(nodes.map(([p, t]) => [p, node(p, t)])),
    aspects: [],
    flows: [],
    rootPath: path.join(FIXTURE_PROJECT, '.yggdrasil'),
  };
}

describe('allowedRelationTypes (relocated: core/allowed-relation-types.ts)', () => {
  it('returns the relation types whose target list includes toType, in canonical order', () => {
    const arch = makeGraph([]).architecture;
    expect(allowedRelationTypes(arch, 'service', 'service')).toEqual(['uses', 'calls']);
    expect(allowedRelationTypes(arch, 'service', 'repository')).toEqual(['uses']);
  });

  it('treats a relation type ABSENT from the table as unconstrained (any target)', () => {
    const arch = makeGraph([]).architecture;
    expect(allowedRelationTypes(arch, 'repository', 'service')).toEqual([
      'uses',
      'calls',
      'extends',
      'implements',
      'emits',
      'listens',
    ]);
  });

  it('returns [] (dead-end) when every present relation type excludes toType', () => {
    const arch = makeGraph([]).architecture;
    expect(allowedRelationTypes(arch, 'service', 'gateway')).toEqual([]);
  });

  it('returns [] for an unknown fromType', () => {
    const arch = makeGraph([]).architecture;
    expect(allowedRelationTypes(arch, 'nope', 'service')).toEqual([]);
  });
});

describe('allowedRelationTypes — default policy + wildcard + empty list (relocated)', () => {
  const arch = (nt: Record<string, any>) => ({ node_types: nt });

  it('default: deny returns only explicitly-allowed relation types', () => {
    const a = arch({
      sink: { description: 's', relationDefault: 'deny', relations: { listens: ['bus'] } },
      bus: { description: 'b' },
      other: { description: 'o' },
    });
    expect(allowedRelationTypes(a as any, 'sink', 'bus')).toEqual(['listens']);
    expect(allowedRelationTypes(a as any, 'sink', 'other')).toEqual([]);
  });

  it('wildcard ["*"] makes a relation type allowed for any target', () => {
    const a = arch({
      sink: { description: 's', relationDefault: 'deny', relations: { listens: ['*'] } },
      other: { description: 'o' },
    });
    expect(allowedRelationTypes(a as any, 'sink', 'other')).toEqual(['listens']);
  });

  it('empty list [] excludes that relation type', () => {
    const a = arch({
      svc: { description: 's', relations: { uses: [] } },
      other: { description: 'o' },
    });
    expect(allowedRelationTypes(a as any, 'svc', 'other')).toEqual([
      'calls', 'extends', 'implements', 'emits', 'listens',
    ]);
  });
});

describe('allowedRelationTypes — via real parseArchitecture (FIX C, relocated)', () => {
  const dirsToCleanup: string[] = [];
  afterEach(async () => {
    for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function archFromYaml(yaml: string) {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-arch-msg-'));
    dirsToCleanup.push(dir);
    const file = path.join(dir, 'yg-architecture.yaml');
    await writeFile(file, yaml, 'utf-8');
    return parseArchitecture(file);
  }

  it('empty list [] via real parser: relation type is excluded for any target', async () => {
    const arch = await archFromYaml(`
node_types:
  svc:
    description: "service"
    relations:
      uses: []
  other:
    description: "other"
`);
    expect(allowedRelationTypes(arch, 'svc', 'other')).toEqual([
      'calls', 'extends', 'implements', 'emits', 'listens',
    ]);
  });

  it("wildcard ['*'] via real parser: relation type is allowed for any target", async () => {
    const arch = await archFromYaml(`
node_types:
  svc:
    description: "service"
    relations:
      uses: ['*']
  other:
    description: "other"
`);
    expect(allowedRelationTypes(arch, 'svc', 'other')).toContain('uses');
  });
});

describe('allowedRelationTypes — mixed wildcard list (FIX D, relocated)', () => {
  it("list containing both '*' and a named type: any target is allowed ('*' wins)", () => {
    const arch = {
      node_types: {
        svc: { description: 's', relations: { uses: ['*', 'domain'] } },
        domain: { description: 'd' },
        other: { description: 'o' },
        third: { description: 't' },
      },
    };
    expect(allowedRelationTypes(arch as any, 'svc', 'domain')).toContain('uses');
    expect(allowedRelationTypes(arch as any, 'svc', 'other')).toContain('uses');
    expect(allowedRelationTypes(arch as any, 'svc', 'third')).toContain('uses');
  });
});

describe('allowedRelationTypes — compat re-export identity', () => {
  it('re-exports the SAME function object the engine module defines (R1 relocation, compat shim)', async () => {
    const fromRelations = await import('../../../src/relations/allowed-types.js');
    const fromCore = await import('../../../src/core/allowed-relation-types.js');
    expect(fromRelations.allowedRelationTypes).toBe(fromCore.allowedRelationTypes);
  });
});
