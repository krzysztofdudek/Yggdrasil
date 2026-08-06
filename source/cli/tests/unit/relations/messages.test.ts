import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relationRefusedMessage, relationUnverifiedMessage } from '../../../src/relations/messages.js';
import { allowedRelationTypes } from '../../../src/relations/allowed-types.js';
import { parseArchitecture } from '../../../src/io/architecture-parser.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';
import type { Violation } from '../../../src/relations/verifier.js';

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

const viol = (fromFile: string, line: number, ownerNode: string): Violation => ({
  fromFile,
  line,
  ownerNode,
});

describe('allowedRelationTypes', () => {
  it('returns the relation types whose target list includes toType, in canonical order', () => {
    const arch = makeGraph([]).architecture;
    // service → service: uses (service ∈ [service,repository]) + calls (service ∈ [service])
    expect(allowedRelationTypes(arch, 'service', 'service')).toEqual(['uses', 'calls']);
    // service → repository: only uses (repository ∈ uses list, not in calls list)
    expect(allowedRelationTypes(arch, 'service', 'repository')).toEqual(['uses']);
  });

  it('treats a relation type ABSENT from the table as unconstrained (any target)', () => {
    const arch = makeGraph([]).architecture;
    // repository has no relations table → all six relation types are unconstrained.
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
    // service constrains all six relation types; none lists gateway → dead-end.
    expect(allowedRelationTypes(arch, 'service', 'gateway')).toEqual([]);
  });

  it('returns [] for an unknown fromType', () => {
    const arch = makeGraph([]).architecture;
    expect(allowedRelationTypes(arch, 'nope', 'service')).toEqual([]);
  });

  it('re-exports the SAME function object the engine module defines (relocation compat shim)', async () => {
    const fromRelations = await import('../../../src/relations/allowed-types.js');
    const fromCore = await import('../../../src/core/allowed-relation-types.js');
    expect(fromRelations.allowedRelationTypes).toBe(fromCore.allowedRelationTypes);
  });
});

describe('relationRefusedMessage', () => {
  it('names the exact yg-node.yaml path to edit', () => {
    const graph = makeGraph([
      ['a', 'service'],
      ['b', 'service'],
    ]);
    const m = relationRefusedMessage(graph, 'a', [viol('src/a/foo.ts', 3, 'b')]);
    expect(m.next).toContain('.yggdrasil/model/a/yg-node.yaml');
    // what block enumerates the violating site.
    expect(m.what).toContain('src/a/foo.ts:3 → b');
    expect(m.why).toContain('sanctioned, declared relation');
  });

  it('lists the allowed relation types for a permitted (type→type) pair and shows the stanza', () => {
    const graph = makeGraph([
      ['a', 'service'],
      ['b', 'repository'],
    ]);
    const m = relationRefusedMessage(graph, 'a', [viol('src/a/foo.ts', 1, 'b')]);
    // service → repository allows only `uses`.
    expect(m.next).toContain('allowed relation type(s) [uses]');
    expect(m.next).toContain('relations:');
    expect(m.next).toContain('- target: b');
    expect(m.next).toContain('type: uses');
  });

  it('emits the dead-end wording when no relation type is allowed between the node types', () => {
    const graph = makeGraph([
      ['a', 'service'],
      ['g', 'gateway'],
    ]);
    const m = relationRefusedMessage(graph, 'a', [viol('src/a/foo.ts', 9, 'g')]);
    expect(m.next).toContain('no relation type is allowed from service to gateway');
    expect(m.next).toContain('.yggdrasil/yg-architecture.yaml');
    expect(m.next).toContain('requires confirming the architecture change');
    // No stanza for a dead-end.
    expect(m.next).not.toContain('- target: g');
  });

  it('falls back to (unknown type) wording when a target node is not in the graph', () => {
    // The violation names a target node 'ghost' that the graph does not contain
    // → its type is unknown → the message cannot compute an allow-list and emits
    // the dead-end note with the (unknown type) placeholder for the target.
    const graph = makeGraph([['a', 'service']]);
    const m = relationRefusedMessage(graph, 'a', [viol('src/a/foo.ts', 2, 'ghost')]);
    expect(m.next).toContain('no relation type is allowed from service to (unknown type)');
    expect(m.next).not.toContain('- target: ghost');
  });

  it('deduplicates repeated targets into a single stanza but keeps all sites', () => {
    const graph = makeGraph([
      ['a', 'service'],
      ['b', 'service'],
    ]);
    const m = relationRefusedMessage(graph, 'a', [
      viol('src/a/foo.ts', 1, 'b'),
      viol('src/a/bar.ts', 4, 'b'),
    ]);
    expect(m.what).toContain('src/a/foo.ts:1 → b');
    expect(m.what).toContain('src/a/bar.ts:4 → b');
    // Only one stanza block for target b (allowed: uses, calls).
    expect(m.next.match(/- target: b/g)?.length).toBe(1);
    expect(m.next).toContain('allowed relation type(s) [uses, calls]');
  });
});

describe('relationUnverifiedMessage', () => {
  it('points at yg check --approve', () => {
    const m = relationUnverifiedMessage('a');
    expect(m.what).toContain("node 'a' is unverified");
    expect(m.next).toContain('yg check --approve');
  });
});

describe('allowedRelationTypes — default policy + wildcard + empty list', () => {
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
    // uses excluded; the other five are unlisted + default allow ⇒ included
    expect(allowedRelationTypes(a as any, 'svc', 'other')).toEqual([
      'calls', 'extends', 'implements', 'emits', 'listens',
    ]);
  });
});

describe('allowedRelationTypes — via real parseArchitecture (FIX C)', () => {
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
    // uses:[] → uses is denied; remaining five unlisted + default allow → included
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
    // uses:['*'] → uses allowed for any target including 'other'
    expect(allowedRelationTypes(arch, 'svc', 'other')).toContain('uses');
  });
});

describe('allowedRelationTypes — mixed wildcard list (FIX D)', () => {
  it("list containing both '*' and a named type: any target is allowed ('*' wins)", () => {
    const arch = {
      node_types: {
        svc: { description: 's', relations: { uses: ['*', 'domain'] } },
        domain: { description: 'd' },
        other: { description: 'o' },
        third: { description: 't' },
      },
    };
    // '*' in the list means any target is permitted, regardless of named entries
    expect(allowedRelationTypes(arch as any, 'svc', 'domain')).toContain('uses');
    expect(allowedRelationTypes(arch as any, 'svc', 'other')).toContain('uses');
    expect(allowedRelationTypes(arch as any, 'svc', 'third')).toContain('uses');
  });
});
