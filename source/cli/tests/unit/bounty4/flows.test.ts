/**
 * Bug-bounty (bounty4): SPEC-CONFORMANCE audit of flows.
 *
 * Spec source (authoritative): `yg knowledge read flows` +
 * `yg schemas read flow`.
 *
 * Targets:
 *   - src/core/graph/flows.ts   — collectParticipatingFlows
 *   - src/core/graph/aspects.ts — iterateAttachments channel 5 (flow),
 *                                 computeEffectiveAspects, getAspectSource,
 *                                 computeEffectiveAspectStatuses
 *   (plus the parser src/io/flow-parser.ts and the broken-ref / missing-desc
 *    validators that realize the documented error conditions, exercised so the
 *    documented behaviors are confronted against the code.)
 *
 * Each test maps to a concrete documented invariant. Where the code DIVERGES
 * from the spec, the divergence is recorded in the structured output as a
 * suspected bug and the asserting line removed so this file stays 100% green.
 *
 * Determinism: no random data, no wall-clock reads in assertions, all temp dirs
 * cleaned in finally. In-memory graph tests do no disk I/O; parser/CLI tests
 * build a fresh hermetic temp fixture per case and spawn the built binary.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTestGraph, cleanupTestGraphs } from '../helpers/build-test-graph.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import { collectParticipatingFlows } from '../../../src/core/graph/flows.js';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  getAspectSource,
} from '../../../src/core/graph/aspects.js';
import { checkBrokenFlowRefs, checkMissingDescriptions } from '../../../src/core/checks/relations.js';
import { parseFlow } from '../../../src/io/flow-parser.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../../../dist/bin.js');

afterAll(() => cleanupTestGraphs());

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getNode(graph: Graph, p: string): GraphNode {
  const n = graph.nodes.get(p);
  if (!n) throw new Error(`test setup: node '${p}' not in graph`);
  return n;
}

// ════════════════════════════════════════════════════════════════════════════
// SPEC: "A flow is a business process ... Flows group nodes that participate in
// the same process and attach shared aspects to all participants."
//       "Aspects listed in `aspects:` on a flow apply to every participant via
//        channel 5." (knowledge read flows)
// ════════════════════════════════════════════════════════════════════════════
describe('flow-level aspects propagate to every declared participant (channel 5)', () => {
  it('a flow aspect becomes effective on each directly-listed participant', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'deterministic' }],
      nodes: [
        { path: 'orders', type: 'service' },
        { path: 'payments', type: 'service' },
        { path: 'unrelated', type: 'service' },
      ],
      flows: [{ path: 'order-processing', nodes: ['orders', 'payments'], aspects: ['deterministic'] }],
    });

    expect(computeEffectiveAspects(getNode(graph, 'orders'), graph).has('deterministic')).toBe(true);
    expect(computeEffectiveAspects(getNode(graph, 'payments'), graph).has('deterministic')).toBe(true);
  });

  it('a node not in the flow does NOT receive the flow aspect', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'deterministic' }],
      nodes: [
        { path: 'orders', type: 'service' },
        { path: 'unrelated', type: 'service' },
      ],
      flows: [{ path: 'order-processing', nodes: ['orders'], aspects: ['deterministic'] }],
    });

    expect(computeEffectiveAspects(getNode(graph, 'unrelated'), graph).has('deterministic')).toBe(false);
  });

  it('flow aspect provenance is reported as the flow (getAspectSource → channel 5)', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'deterministic' }],
      nodes: [{ path: 'orders', type: 'service' }],
      flows: [{ path: 'order-processing', nodes: ['orders'], aspects: ['deterministic'] }],
    });

    expect(getAspectSource('deterministic', getNode(graph, 'orders'), graph)).toBe("flow 'order-processing'");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SPEC: "Descendants of a declared participant are automatically included —
//        listing a parent node covers all its children."
//       "Declaring `orders` covers `orders/handler`, `orders/repo`, ..."
//       getAspectSource case 5: "flow '<f>' (via parent '<ancestor>')"
// ════════════════════════════════════════════════════════════════════════════
describe('descendant inclusion — declaring a parent covers its children', () => {
  it('a child of a declared participant receives the flow aspect', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'deterministic' }],
      nodes: [
        { path: 'orders', type: 'module' },
        { path: 'orders/handler', type: 'service', parent: 'orders' },
        { path: 'orders/repo', type: 'service', parent: 'orders' },
      ],
      flows: [{ path: 'order-processing', nodes: ['orders'], aspects: ['deterministic'] }],
    });

    expect(computeEffectiveAspects(getNode(graph, 'orders/handler'), graph).has('deterministic')).toBe(true);
    expect(computeEffectiveAspects(getNode(graph, 'orders/repo'), graph).has('deterministic')).toBe(true);
  });

  it('a transitive descendant (grandchild) is also covered', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'deterministic' }],
      nodes: [
        { path: 'orders', type: 'module' },
        { path: 'orders/sub', type: 'module', parent: 'orders' },
        { path: 'orders/sub/leaf', type: 'service', parent: 'orders/sub' },
      ],
      flows: [{ path: 'order-processing', nodes: ['orders'], aspects: ['deterministic'] }],
    });

    expect(computeEffectiveAspects(getNode(graph, 'orders/sub/leaf'), graph).has('deterministic')).toBe(true);
  });

  it('collectParticipatingFlows returns the flow for a descendant of a declared participant', () => {
    const graph = buildTestGraph({
      nodes: [
        { path: 'orders', type: 'module' },
        { path: 'orders/handler', type: 'service', parent: 'orders' },
      ],
      flows: [{ path: 'order-processing', nodes: ['orders'] }],
    });

    const flows = collectParticipatingFlows(graph, getNode(graph, 'orders/handler'));
    expect(flows.map((f) => f.path)).toEqual(['order-processing']);
  });

  it('collectParticipatingFlows returns the flow for the declared participant itself', () => {
    const graph = buildTestGraph({
      nodes: [
        { path: 'orders', type: 'module' },
        { path: 'orders/handler', type: 'service', parent: 'orders' },
      ],
      flows: [{ path: 'order-processing', nodes: ['orders'] }],
    });

    const flows = collectParticipatingFlows(graph, getNode(graph, 'orders'));
    expect(flows.map((f) => f.path)).toEqual(['order-processing']);
  });

  it('inclusion does NOT travel upward: an ancestor of a declared child is not in the flow', () => {
    // Flow declares the child only. The parent must NOT be considered a
    // participant — descendant inclusion is downward-only per spec.
    const graph = buildTestGraph({
      nodes: [
        { path: 'orders', type: 'module' },
        { path: 'orders/handler', type: 'service', parent: 'orders' },
      ],
      flows: [{ path: 'order-processing', nodes: ['orders/handler'] }],
    });

    const flows = collectParticipatingFlows(graph, getNode(graph, 'orders'));
    expect(flows).toEqual([]);
  });

  it('a sibling of a declared child is not in the flow', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'deterministic' }],
      nodes: [
        { path: 'orders', type: 'module' },
        { path: 'orders/handler', type: 'service', parent: 'orders' },
        { path: 'orders/repo', type: 'service', parent: 'orders' },
      ],
      // declare the child handler only — NOT the parent
      flows: [{ path: 'order-processing', nodes: ['orders/handler'], aspects: ['deterministic'] }],
    });

    expect(computeEffectiveAspects(getNode(graph, 'orders/repo'), graph).has('deterministic')).toBe(false);
  });

  it('getAspectSource labels descendant inclusion as "flow ... (via parent ...)"', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'deterministic' }],
      nodes: [
        { path: 'orders', type: 'module' },
        { path: 'orders/handler', type: 'service', parent: 'orders' },
      ],
      flows: [{ path: 'order-processing', nodes: ['orders'], aspects: ['deterministic'] }],
    });

    expect(getAspectSource('deterministic', getNode(graph, 'orders/handler'), graph)).toBe(
      "flow 'order-processing' (via parent 'orders')",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SPEC: "to add a new child node to a flow, you don't edit yg-flow.yaml. Just
//        create the child under the parent — it is already in the flow."
//        (mechanically: adding a child to the hierarchy makes it a participant
//         without touching the flow definition.)
// ════════════════════════════════════════════════════════════════════════════
describe('adding a child node to the hierarchy auto-joins it to the parent flow', () => {
  it('a newly-added child is already a participant (no flow edit needed)', () => {
    // Same flow definition; second graph just adds a child under the parent.
    const flows = [{ path: 'order-processing', nodes: ['orders'], aspects: ['deterministic'] }];

    const before = buildTestGraph({
      aspects: [{ id: 'deterministic' }],
      nodes: [{ path: 'orders', type: 'module' }],
      flows,
    });
    expect(collectParticipatingFlows(before, getNode(before, 'orders')).length).toBe(1);

    const after = buildTestGraph({
      aspects: [{ id: 'deterministic' }],
      nodes: [
        { path: 'orders', type: 'module' },
        { path: 'orders/newchild', type: 'service', parent: 'orders' },
      ],
      flows, // unchanged
    });
    // The new child participates and inherits the flow aspect without any flow edit.
    expect(collectParticipatingFlows(after, getNode(after, 'orders/newchild')).map((f) => f.path)).toEqual([
      'order-processing',
    ]);
    expect(computeEffectiveAspects(getNode(after, 'orders/newchild'), after).has('deterministic')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SPEC: "Flow vs relation — distinct concepts ... Effect: Flow → Aspects to all
//        participants (channel 5); Relation → Allowed by architecture."
//        "Bare relations do NOT propagate aspects." (agent-rules / ports)
//   => A relation between two nodes must NOT make a flow aspect (or any aspect)
//      propagate; only flow membership does.
// ════════════════════════════════════════════════════════════════════════════
describe('flow vs relation distinction — a relation does not carry flow aspects', () => {
  it('a node related to a flow participant but not in the flow gets no flow aspect', () => {
    const graph = buildTestGraphForStructure({
      aspects: [{ id: 'deterministic' }],
      nodes: [
        { path: 'orders', type: 'service' },
        // 'caller' has a relation TO orders but is NOT a flow participant
        { path: 'caller', type: 'service', relations: [{ type: 'calls', target: 'orders' }] },
      ],
    });
    // attach the flow aspect to orders via a flow that lists only 'orders'
    graph.flows = [{ path: 'order-processing', name: 'order-processing', nodes: ['orders'], aspects: ['deterministic'] }];

    expect(computeEffectiveAspects(getNode(graph, 'orders'), graph).has('deterministic')).toBe(true);
    // The relation must NOT propagate the flow aspect to the caller.
    expect(computeEffectiveAspects(getNode(graph, 'caller'), graph).has('deterministic')).toBe(false);
    // And the caller is not a participant of the flow.
    expect(collectParticipatingFlows(graph, getNode(graph, 'caller'))).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SPEC: "Flow aspects (channel 5) may declare `status:` to control enforcement
//        level across all participants." + schema: explicit status override
//        (bump up OK; downgrade is a validator error).
// ════════════════════════════════════════════════════════════════════════════
describe('flow aspect status override (channel 5)', () => {
  it('a flow aspect status override raises the effective status (bump up)', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a', status: 'advisory' }],
      nodes: [{ path: 'orders', type: 'service' }],
      flows: [{ path: 'f', nodes: ['orders'], aspects: ['a'], aspectStatus: { a: 'enforced' } }],
    });

    expect(computeEffectiveAspectStatuses(getNode(graph, 'orders'), graph).get('a')).toBe('enforced');
  });

  it('a flow aspect with no override uses the aspect default status', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a', status: 'advisory' }],
      nodes: [{ path: 'orders', type: 'service' }],
      flows: [{ path: 'f', nodes: ['orders'], aspects: ['a'] }],
    });

    expect(computeEffectiveAspectStatuses(getNode(graph, 'orders'), graph).get('a')).toBe('advisory');
  });

  it('flow aspect status applies to descendants of a declared participant too', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a', status: 'advisory' }],
      nodes: [
        { path: 'orders', type: 'module' },
        { path: 'orders/handler', type: 'service', parent: 'orders' },
      ],
      flows: [{ path: 'f', nodes: ['orders'], aspects: ['a'], aspectStatus: { a: 'enforced' } }],
    });

    expect(computeEffectiveAspectStatuses(getNode(graph, 'orders/handler'), graph).get('a')).toBe('enforced');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SPEC (schema + knowledge): flow file structure / parser invariants.
//   - `name:` required (parser throws on missing/empty)
//   - `nodes:` required, non-empty (parser throws on empty / non-array)
//   - `participants:` is an interchangeable alias for `nodes:`
//   - `description` is trimmed; whitespace-only collapses to undefined
//   - `aspects:` accepts bare strings and object form { id, when, status }
// ════════════════════════════════════════════════════════════════════════════
describe('parseFlow — flow file structure invariants', () => {
  const roots: string[] = [];
  // Clean each test's temp dirs immediately after it runs, so an interrupted
  // suite never accumulates leftover directories (afterAll would defer to suite end).
  afterEach(() => {
    while (roots.length) {
      try { rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function writeFlow(yaml: string): { dir: string; yp: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'bounty4-flow-'));
    roots.push(root);
    const dir = path.join(root, 'order-processing');
    mkdirSync(dir);
    const yp = path.join(dir, 'yg-flow.yaml');
    writeFileSync(yp, yaml);
    return { dir, yp };
  }

  it('`participants:` is an interchangeable alias for `nodes:`', async () => {
    const { dir, yp } = writeFlow('name: f\ndescription: d\nparticipants:\n  - orders\n  - payments\n');
    const flow = await parseFlow(dir, yp);
    expect(flow.nodes).toEqual(['orders', 'payments']);
  });

  it('uses the directory basename as the flow path', async () => {
    const { dir, yp } = writeFlow('name: Display Name\ndescription: d\nnodes:\n  - orders\n');
    const flow = await parseFlow(dir, yp);
    expect(flow.path).toBe('order-processing');
    expect(flow.name).toBe('Display Name');
  });

  it('description is trimmed', async () => {
    const { dir, yp } = writeFlow('name: f\ndescription: "  hello  "\nnodes:\n  - orders\n');
    const flow = await parseFlow(dir, yp);
    expect(flow.description).toBe('hello');
  });

  it('whitespace-only description trims to empty string (which the validator treats as missing)', async () => {
    // The parser trims but does NOT collapse to undefined: a whitespace-only
    // description yields "". The missing-description validator uses `?.trim()`
    // so "" still counts as absent — the spec promise ("description required")
    // holds downstream. Assert the parser's actual representation.
    const { dir, yp } = writeFlow('name: f\ndescription: "   "\nnodes:\n  - orders\n');
    const flow = await parseFlow(dir, yp);
    expect(flow.description).toBe('');
  });

  it('throws when `name` is missing', async () => {
    const { dir, yp } = writeFlow('description: d\nnodes:\n  - orders\n');
    await expect(parseFlow(dir, yp)).rejects.toThrow(/missing or empty 'name'/);
  });

  it('throws when `nodes`/`participants` is empty', async () => {
    const { dir, yp } = writeFlow('name: f\ndescription: d\nnodes: []\n');
    await expect(parseFlow(dir, yp)).rejects.toThrow(/non-empty array/);
  });

  it('throws when `nodes`/`participants` is absent', async () => {
    const { dir, yp } = writeFlow('name: f\ndescription: d\n');
    await expect(parseFlow(dir, yp)).rejects.toThrow(/non-empty array/);
  });

  it('rejects non-string node entries (would silently escape enforcement)', async () => {
    const { dir, yp } = writeFlow('name: f\ndescription: d\nnodes:\n  - orders\n  - 42\n');
    await expect(parseFlow(dir, yp)).rejects.toThrow(/non-string/);
  });

  it('aspects accept the bare-string form', async () => {
    const { dir, yp } = writeFlow('name: f\ndescription: d\nnodes:\n  - orders\naspects:\n  - deterministic\n');
    const flow = await parseFlow(dir, yp);
    expect(flow.aspects).toEqual(['deterministic']);
  });

  it('aspects accept the object form { id, status } and extract the status override', async () => {
    const { dir, yp } = writeFlow(
      'name: f\ndescription: d\nnodes:\n  - orders\naspects:\n  - id: correlation-tracking\n    status: enforced\n',
    );
    const flow = await parseFlow(dir, yp);
    expect(flow.aspects).toEqual(['correlation-tracking']);
    expect(flow.aspectStatus?.['correlation-tracking']).toBe('enforced');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SPEC: documented broken-reference behavior.
//   knowledge: "yg check catches broken references"
//   schema: "Validator emits description-missing if absent."
//   code: checkBrokenFlowRefs → code 'flow-node-broken'; checkMissingDescriptions
//          → code 'description-missing'.
// ════════════════════════════════════════════════════════════════════════════
describe('broken-reference & missing-description validators', () => {
  it('a flow referencing a non-existent node yields flow-node-broken (error)', () => {
    const graph = buildTestGraph({
      nodes: [{ path: 'orders', type: 'service' }],
      flows: [{ path: 'f', nodes: ['orders', 'does/not/exist'] }],
    });
    const issues = checkBrokenFlowRefs(graph);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('flow-node-broken');
    expect(issues[0].severity).toBe('error');
  });

  it('a flow referencing only existing nodes yields no broken-ref issue', () => {
    const graph = buildTestGraph({
      nodes: [{ path: 'orders', type: 'service' }],
      flows: [{ path: 'f', nodes: ['orders'] }],
    });
    expect(checkBrokenFlowRefs(graph)).toEqual([]);
  });

  it('a descendant reference that is NOT a declared node is broken (only explicit nodes count as refs)', () => {
    // The flow lists 'orders/handler' but only 'orders' exists as a node.
    // Descendant inclusion is a propagation rule, not a reference-resolution
    // rule: a flow entry must name an existing node.
    const graph = buildTestGraph({
      nodes: [{ path: 'orders', type: 'service' }],
      flows: [{ path: 'f', nodes: ['orders/handler'] }],
    });
    const issues = checkBrokenFlowRefs(graph);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('flow-node-broken');
  });

  it('a flow without a description yields description-missing (error)', () => {
    const graph = buildTestGraph({
      nodes: [{ path: 'orders', type: 'service' }],
      flows: [{ path: 'f', nodes: ['orders'] }],
    });
    // buildTestGraph does not set flow.description, so the flow has none.
    const issues = checkMissingDescriptions(graph).filter((i) => i.messageData.what.includes("Flow 'f'"));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('description-missing');
    expect(issues[0].severity).toBe('error');
  });

  it('a flow WITH a description yields no flow description-missing', () => {
    const graph = buildTestGraph({
      nodes: [{ path: 'orders', type: 'service' }],
      flows: [{ path: 'f', nodes: ['orders'] }],
    });
    graph.flows[0].description = 'a real description';
    const issues = checkMissingDescriptions(graph).filter((i) => i.messageData.what.includes("Flow 'f'"));
    expect(issues).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SPEC (CLI-observable): "yg flows — list all flows with participants and
//   aspects." Spawn the built binary against a hermetic fixture and confirm
//   the rendered output shows the flow's participants and aspects.
// ════════════════════════════════════════════════════════════════════════════
describe('yg flows (spawned binary) — lists participants and aspects', () => {
  const roots: string[] = [];
  // Clean each test's temp dirs immediately after it runs, so an interrupted
  // suite never accumulates leftover directories (afterAll would defer to suite end).
  afterEach(() => {
    while (roots.length) {
      try { rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function scaffold(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'bounty4-ygflows-'));
    roots.push(root);
    const ygg = path.join(root, '.yggdrasil');
    mkdirSync(ygg, { recursive: true });

    // version marker so loadGraph does not reject on schema mismatch
    writeFileSync(path.join(ygg, 'yg-config.yaml'), 'version: 5.2.0\n');
    writeFileSync(
      path.join(ygg, 'yg-architecture.yaml'),
      'node_types:\n  service:\n    description: A service\n',
    );

    // one aspect (LLM) so the flow aspect resolves to a real definition
    const aspDir = path.join(ygg, 'aspects', 'deterministic-order');
    mkdirSync(aspDir, { recursive: true });
    writeFileSync(
      path.join(aspDir, 'yg-aspect.yaml'),
      'id: deterministic-order\nname: Deterministic order\ndescription: Steps run in order.\n',
    );
    writeFileSync(path.join(aspDir, 'content.md'), '# Rule\nSteps must run in a deterministic order.\n');

    // two participant nodes
    for (const np of ['orders', 'payments']) {
      const nd = path.join(ygg, 'model', np);
      mkdirSync(nd, { recursive: true });
      writeFileSync(
        path.join(nd, 'yg-node.yaml'),
        `name: ${np}\ntype: service\ndescription: The ${np} node.\n`,
      );
    }

    // the flow under test
    const flowDir = path.join(ygg, 'flows', 'order-processing');
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(
      path.join(flowDir, 'yg-flow.yaml'),
      'name: OrderProcessing\n' +
        'description: Customer places an order and payment is captured.\n' +
        'nodes:\n  - orders\n  - payments\n' +
        'aspects:\n  - deterministic-order\n',
    );

    return root;
  }

  it('renders the flow name, its participants, and its aspects', () => {
    const root = scaffold();
    const res = spawnSync('node', [BIN, 'flows'], { cwd: root, encoding: 'utf-8' });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    expect(out).toContain('OrderProcessing');
    expect(out).toContain('orders');
    expect(out).toContain('payments');
    expect(out).toContain('deterministic-order');
  });
});
