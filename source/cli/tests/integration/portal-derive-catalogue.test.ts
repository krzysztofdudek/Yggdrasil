import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { readLock } from '../../src/io/lock-store.js';
import { verifyLock } from '../../src/core/verify-lock.js';
import { buildAspects, buildFlows, buildTypes } from '../../src/portal/derive-catalogue.js';
import { readPortalAsset } from '../../src/portal/serializer.js';
import { displayPairState } from '../../src/portal/derive-nodes.js';
import type { PortalAspect } from '../../src/portal/contract.js';
import type { Graph, AspectDef, FlowDef, GraphNode } from '../../src/model/graph.js';
import type { VerifiedPair, PairState } from '../../src/core/verify-lock.js';
import { nodeUnit } from '../../src/model/lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The REAL repo root (real .yggdrasil/ graph + real source).
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Aspect catalogue + flows + type model, derived from the REAL repo graph and the
// already-verified pairs. The three HONEST renderings (normal V/R/U, aggregating
// "judges nothing", vacuous "verifies nothing") and the honest flow state
// ("nothing-checked", never green when no participant carries a rule) are pinned.

describe('portal catalogue derivation (aspects / flows / types) — real repo', () => {
  let aspects: PortalAspect[];
  let graphAspectCount: number;
  let graphFlowCount: number;
  let graphTypeCount: number;

  beforeAll(async () => {
    const graph = await loadGraph(REPO_ROOT);
    const lock = readLock(graph.rootPath);
    const verification = await verifyLock(graph, lock);
    aspects = buildAspects(graph, verification.pairs);
    graphAspectCount = graph.aspects.length;
    graphFlowCount = graph.flows.length;
    graphTypeCount = Object.keys(graph.architecture.node_types).length;
  }, 180_000);

  it('aspect count is DERIVED (== graph.aspects.length), never a literal', () => {
    expect(aspects.length).toBe(graphAspectCount);
  });

  it('a rule-bearing aspect with zero expected pairs renders "verifies nothing" (vacuous)', () => {
    // provider-redaction-cascade reaches no node in the real graph → zero expected
    // pairs → the honest "vacuous" rendering, never a fabricated green.
    const vacuous = aspects.find((a) => a.tally.render === 'vacuous');
    expect(vacuous).toBeDefined();
    if (vacuous && vacuous.tally.render === 'vacuous') {
      expect(vacuous.tally.reason.length).toBeGreaterThan(0);
    }
  });

  it('each normal aspect tally sums V+R+W+U to its unit count', () => {
    // The tally is status-adjusted: an advisory refusal counts as `warning`, kept distinct from
    // the blocking `refused`, so the four buckets together account for every unit.
    for (const a of aspects) {
      if (a.tally.render === 'normal') {
        expect(a.tally.verified + a.tally.refused + a.tally.warning + a.tally.unverified).toBe(a.tally.units);
      }
    }
  });

  it('an advisory aspect with a refused unit tallies it as a warning, never a blocking refused', () => {
    // On the real repo `portal/focused-file-exports` is an ADVISORY deterministic aspect that
    // refuses a unit (5 exports > advisory cap 4). Its tally must show that as a `warning`, not a
    // blocking `refused` — the same honesty the count chips and node pills enforce.
    const fileExports = aspects.find((a) => a.id === 'portal/focused-file-exports');
    expect(fileExports).toBeDefined();
    expect(fileExports!.status).toBe('advisory');
    expect(fileExports!.tally.render).toBe('normal');
    if (fileExports!.tally.render === 'normal') {
      expect(fileExports!.tally.refused).toBe(0); // advisory refusal never inflates the blocking bucket
      expect(fileExports!.tally.warning).toBeGreaterThanOrEqual(1);
    }
  });

  it('every aspect carries scope, implies, hasWhen, and a kind', () => {
    for (const a of aspects) {
      expect(['node', 'file']).toContain(a.scope);
      expect(Array.isArray(a.implies)).toBe(true);
      expect(typeof a.hasWhen).toBe('boolean');
      expect(['llm', 'deterministic', 'aggregate']).toContain(a.kind);
    }
  });

  it('the type model lists every architecture type with a derived node count + matrix', () => {
    const graphPromise = loadGraph(REPO_ROOT);
    return graphPromise.then((graph) => {
      const types = buildTypes(graph);
      expect(types.length).toBe(graphTypeCount);
      const engine = types.find((t) => t.id === 'engine');
      expect(engine).toBeDefined();
      // node count is live over the graph, not a literal.
      let live = 0;
      for (const n of graph.nodes.values()) if (n.meta.type === 'engine') live += 1;
      expect(engine!.nodeCount).toBe(live);
      // The de-spidered pipeline matrix: the pipeline now calls the single facade type,
      // NOT the engine directly. The engine coupling moved to the portal-engine-api type.
      const pipeline = types.find((t) => t.id === 'portal-pipeline');
      expect(pipeline).toBeDefined();
      expect(pipeline!.allowedRelations['calls']).toContain('portal-engine-api');
      expect(pipeline!.allowedRelations['calls']).not.toContain('engine');
      expect(pipeline!.strict).toBe(true);
      expect(pipeline!.logRequired).toBe(true);

      // The facade type IS the seam: it calls the engine (the coupling concentrated here).
      const facade = types.find((t) => t.id === 'portal-engine-api');
      expect(facade).toBeDefined();
      expect(facade!.allowedRelations['calls']).toContain('engine');
      expect(facade!.allowedRelations['calls']).toContain('relations-adapter');
      expect(facade!.strict).toBe(true);
    });
  });

  // Re-loads the whole real graph and re-hashes the lock (loadGraph + verifyLock over
  // every node), the same heavy whole-repo work the beforeAll budgets 180s for. On a
  // slow CI runner this exceeds vitest's 5s default, so it carries the same explicit
  // budget — the work is bounded, the timeout only guards against a slow runner.
  it('flow count is derived and every real flow expands descendants', async () => {
    const graph = await loadGraph(REPO_ROOT);
    const lock = readLock(graph.rootPath);
    const verification = await verifyLock(graph, lock);
    const byNode = new Map<string, ('verified' | 'refused' | 'unverified')[]>();
    for (const vp of verification.pairs) {
      const l = byNode.get(vp.pair.nodePath) ?? [];
      l.push(vp.state.kind === 'verified' ? 'verified' : vp.state.kind === 'refused' ? 'refused' : 'unverified');
      byNode.set(vp.pair.nodePath, l);
    }
    const flows = buildFlows(graph, (p) => byNode.get(p));
    expect(flows.length).toBe(graphFlowCount);
    // Every flow's participant set is a SUPERSET of its declared nodes (descendants added).
    for (const f of flows) {
      const declared = graph.flows.find((d) => d.name === f.name)!;
      for (const declaredNode of declared.nodes) {
        expect(f.participants).toContain(declaredNode);
      }
    }
  }, 180_000);
});

// ── Honest-rendering branch coverage over the builder functions directly ──────
//
// The real repo currently has no aggregating aspect and no all-no-rule flow, so the
// "aggregate" (judges nothing) and "nothing-checked" branches are exercised here by
// driving the REAL builder functions with a minimal synthetic graph — never a
// fabricated PortalData, only minimal inputs that reach the honest branch. This
// mirrors the existing buildCounts synthetic block in portal-extract.test.ts.

function syntheticGraph(opts: { aspects: AspectDef[]; flows: FlowDef[]; nodes: Map<string, GraphNode> }): Graph {
  return {
    nodes: opts.nodes,
    aspects: opts.aspects,
    flows: opts.flows,
    architecture: { node_types: {} },
  } as unknown as Graph;
}

describe('portal catalogue — honest renderings on the branches the real graph does not reach', () => {
  it('an aggregating aspect renders "judges nothing"', () => {
    const agg: AspectDef = {
      name: 'Reference Bundle',
      id: 'reference',
      reviewer: { type: 'aggregate' },
      implies: ['child-a', 'child-b'],
      artifacts: [],
    } as unknown as AspectDef;
    const graph = syntheticGraph({ aspects: [agg], flows: [], nodes: new Map() });
    const built = buildAspects(graph, []);
    const ref = built.find((a) => a.id === 'reference')!;
    expect(ref.kind).toBe('aggregate');
    expect(ref.tally.render).toBe('aggregate'); // "judges nothing"
    expect(ref.implies).toEqual(['child-a', 'child-b']);
  });

  it('a flow whose participants are all no-rule yields "nothing-checked" (never green)', () => {
    // One participant node with no mapping and no aspects → hasNonDraftEffectiveAspects
    // is false → the flow is honestly nothing-checked, not verified.
    const node = {
      path: 'norule/node',
      meta: { name: 'NoRule', type: 'module', mapping: [] },
      children: [],
      parent: null,
    } as unknown as GraphNode;
    const flow: FlowDef = {
      path: 'empty-flow',
      name: 'Empty Flow',
      nodes: ['norule/node'],
      aspects: [],
    };
    const graph = syntheticGraph({
      aspects: [],
      flows: [flow],
      nodes: new Map([['norule/node', node]]),
    });
    const flows = buildFlows(graph, () => undefined);
    expect(flows).toHaveLength(1);
    expect(flows[0].state).toBe('nothing-checked');
    expect(flows[0].participants).toEqual(['norule/node']);
  });
});

// ── Synthetic branch coverage for the tally + flow-state arms the real graph misses ──

function detAspect(id: string, status: AspectDef['status'] = 'enforced'): AspectDef {
  return { name: id, id, reviewer: { type: 'deterministic' }, artifacts: [], status } as unknown as AspectDef;
}
function vpair(
  aspectId: string,
  nodePath: string,
  state: PairState,
  status: AspectDef['status'] = 'enforced',
): VerifiedPair {
  return {
    pair: { aspectId, kind: 'deterministic', unitKey: nodeUnit(nodePath), nodePath, status, subjectFiles: ['f.ts'] },
    state,
  };
}
function gnode(p: string, aspects: string[], mapping: string[]): GraphNode {
  return { path: p, meta: { name: p, type: 'module', aspects, mapping }, children: [], parent: null } as unknown as GraphNode;
}

describe('catalogue — tally + flow-state honest branches (synthetic)', () => {
  it('a normal tally counts refused and unverified, not only verified', () => {
    const a = detAspect('a');
    const n = gnode('n', ['a'], ['f.ts']);
    const graph = { nodes: new Map([['n', n]]), aspects: [a], flows: [], architecture: { node_types: {} } } as unknown as Graph;
    const pairs = [
      vpair('a', 'n', { kind: 'verified' }),
      vpair('a', 'n2', { kind: 'refused' }),
      vpair('a', 'n3', { kind: 'unverified' }),
      vpair('a', 'n4', { kind: 'prompt-too-large', chars: 9, limit: 4, tierName: 't' }),
    ];
    const [built] = buildAspects(graph, pairs);
    expect(built.tally.render).toBe('normal');
    if (built.tally.render === 'normal') {
      expect(built.tally.verified).toBe(1);
      expect(built.tally.refused).toBe(1);
      expect(built.tally.warning).toBe(0); // no advisory pair here
      expect(built.tally.unverified).toBe(2); // plain unverified + the gate state
      expect(built.tally.units).toBe(4);
    }
  });

  it('an advisory aspect tallies a refused unit as a warning, never a blocking refused', () => {
    // A refused verdict on an ADVISORY aspect is non-blocking signal: the tally counts it as a
    // `warning`, keeping the blocking `refused` bucket at zero. An enforced refusal on the SAME
    // aspect (if it had one) would still count as refused — status is per pair.
    const a = detAspect('adv', 'advisory');
    const n = gnode('n', ['adv'], ['f.ts']);
    const graph = { nodes: new Map([['n', n]]), aspects: [a], flows: [], architecture: { node_types: {} } } as unknown as Graph;
    const pairs = [
      vpair('adv', 'n', { kind: 'verified' }, 'advisory'),
      vpair('adv', 'n2', { kind: 'refused', reason: 'cap exceeded' }, 'advisory'),
    ];
    const [built] = buildAspects(graph, pairs);
    expect(built.tally.render).toBe('normal');
    if (built.tally.render === 'normal') {
      expect(built.tally.verified).toBe(1);
      expect(built.tally.refused).toBe(0); // the advisory refusal did NOT land in the blocking bucket
      expect(built.tally.warning).toBe(1); // it is a non-blocking warning instead
      expect(built.tally.unverified).toBe(0);
      expect(built.tally.units).toBe(2);
    }
  });

  it('a draft rule-bearing aspect renders vacuous with the draft reason', () => {
    const a = detAspect('drafty', 'draft');
    const graph = { nodes: new Map(), aspects: [a], flows: [], architecture: { node_types: {} } } as unknown as Graph;
    const [built] = buildAspects(graph, []);
    expect(built.tally.render).toBe('vacuous');
    if (built.tally.render === 'vacuous') expect(built.tally.reason).toContain('draft');
  });

  it('a vacuous aspect that reaches a node but has empty subjects reports the empty-subject reason', () => {
    // The aspect is effective on a node (own enforced) but the verification carries
    // zero pairs for it (empty subject set) → the "effective but empty" reason.
    const a = detAspect('eff-empty');
    const n = gnode('n', ['eff-empty'], ['f.ts']);
    const graph = { nodes: new Map([['n', n]]), aspects: [a], flows: [], architecture: { node_types: {} } } as unknown as Graph;
    const [built] = buildAspects(graph, []);
    expect(built.tally.render).toBe('vacuous');
    if (built.tally.render === 'vacuous') expect(built.tally.reason).toContain('every subject set is empty');
  });

  it('a flow with a checked, unverified participant renders state=attention', () => {
    const a = detAspect('a');
    const n = gnode('p', ['a'], ['f.ts']);
    const flow: FlowDef = { path: 'f', name: 'F', nodes: ['p'], aspects: [] };
    const graph = { nodes: new Map([['p', n]]), aspects: [a], flows: [flow], architecture: { node_types: {} } } as unknown as Graph;
    const flows = buildFlows(graph, () => ['unverified']);
    expect(flows[0].state).toBe('attention');
  });

  it('a flow with a checked, all-verified participant renders state=verified', () => {
    const a = detAspect('a');
    const n = gnode('p', ['a'], ['f.ts']);
    const flow: FlowDef = { path: 'f', name: 'F', nodes: ['p'], aspects: ['a'], description: 'd' };
    const graph = { nodes: new Map([['p', n]]), aspects: [a], flows: [flow], architecture: { node_types: {} } } as unknown as Graph;
    const flows = buildFlows(graph, () => ['verified']);
    expect(flows[0].state).toBe('verified');
    expect(flows[0].description).toBe('d');
  });

  it('buildTypes surfaces a type description, allowed relations, parents, and node count', () => {
    const graph = {
      nodes: new Map([['n', gnode('n', [], [])]]),
      aspects: [],
      flows: [],
      architecture: {
        node_types: {
          module: { description: 'mod', parents: ['root'], relations: { calls: ['engine'] }, aspects: ['x'], enforce: 'strict', log_required: true },
        },
      },
    } as unknown as Graph;
    const [t] = buildTypes(graph);
    expect(t.id).toBe('module');
    expect(t.description).toBe('mod');
    expect(t.parents).toEqual(['root']);
    expect(t.allowedRelations['calls']).toEqual(['engine']);
    expect(t.defaultAspects).toEqual(['x']);
    expect(t.strict).toBe(true);
    expect(t.logRequired).toBe(true);
    expect(t.nodeCount).toBe(1);
  });

  it('a draft aspect renders as vacuous with the draft reason', () => {
    const a = detAspect('d', 'draft');
    const graph = { nodes: new Map(), aspects: [a], flows: [], architecture: { node_types: {} } } as unknown as Graph;
    const [built] = buildAspects(graph, []);
    expect(built.tally.render).toBe('vacuous');
    if (built.tally.render === 'vacuous') expect(built.tally.reason).toMatch(/draft/);
  });

  it('buildFlows handles a flow with no aspects and a non-existent participant', () => {
    const flow = { path: 'f', name: 'F', nodes: ['ghost'] } as unknown as FlowDef;
    const graph = { nodes: new Map(), aspects: [], flows: [flow], architecture: { node_types: {} } } as unknown as Graph;
    const [built] = buildFlows(graph, () => undefined);
    expect(built.aspects).toEqual([]); // flow.aspects ?? []
    expect(built.participants).toEqual(['ghost']); // ghost added, not expanded (node not found)
    expect(built.state).toBe('nothing-checked'); // computeFlowState skips the missing node
  });

  it('buildTypes handles no description, null relation targets, and zero nodes; and no node_types', () => {
    const graph = {
      nodes: new Map(),
      aspects: [],
      flows: [],
      architecture: { node_types: { bare: { relations: { calls: null } } } },
    } as unknown as Graph;
    const [t] = buildTypes(graph);
    expect(t.description).toBeUndefined(); // def.description ? {} : {} false arm
    expect(t.allowedRelations['calls']).toEqual([]); // targets ?? []
    expect(t.parents).toEqual([]); // def.parents ?? []
    expect(t.nodeCount).toBe(0); // countByType.get(id) ?? 0
    const empty = { nodes: new Map(), aspects: [], flows: [], architecture: {} } as unknown as Graph;
    expect(buildTypes(empty)).toEqual([]); // node_types ?? {}
  });

  it('displayPairState keeps an enforced refusal blocking, an advisory refusal a warning', () => {
    expect(displayPairState('refused', 'enforced')).toBe('refused');
    expect(displayPairState('refused', 'advisory')).toBe('warning');
    expect(displayPairState('verified', 'enforced')).toBe('verified');
  });

  it('readPortalAsset rejects unsafe paths and serves committed assets with a content type', async () => {
    expect(await readPortalAsset('')).toBeNull(); // empty after strip
    expect(await readPortalAsset('//')).toBeNull(); // empty after leading-slash strip
    expect(await readPortalAsset('../escape')).toBeNull(); // path traversal out of the asset root
    expect(await readPortalAsset('no/such/file.js')).toBeNull(); // does not exist
    expect((await readPortalAsset('tokens.css'))?.contentType).toBe('text/css; charset=utf-8');
    expect((await readPortalAsset('js/namespace.js'))?.contentType).toBe('text/javascript; charset=utf-8');
    expect((await readPortalAsset('shell.html'))?.contentType).toBe('text/html; charset=utf-8');
  });
});
