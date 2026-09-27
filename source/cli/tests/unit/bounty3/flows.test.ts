import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkBrokenFlowRefs, checkMissingDescriptions } from '../../../src/core/checks/relations.js';
import { checkDanglingAspectRefs, checkOrphanedAspects } from '../../../src/core/checks/aspects.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from '../../../src/core/graph/aspects.js';
import { collectParticipatingFlows } from '../../../src/core/graph/flows.js';
import { buildTestGraph, cleanupTestGraphs } from '../helpers/build-test-graph.js';
import type { Graph, GraphNode, FlowDef } from '../../../src/model/graph.js';

// ============================================================================
// BOUNTY 3 — FLOWS: participation, descendant inclusion, propagation, broken
// refs.
//
// The EXISTING flow coverage is deep on the channel-5 *propagation* surface:
//   - tests/unit/bounty/eff-flows.test.ts exhaustively covers
//     computeEffectiveAspects / *Statuses / getAspectSource / collectParticipatingFlows
//     for participants, descendants, multi-flow accumulation, when-filters, implies.
//   - tests/e2e/cli-flows-*.test.ts cover flow YAML PARSE errors (empty name,
//     bad nodes shape, non-string entries, filesystem EISDIR/ENOENT) and the
//     approve/check lifecycle for channel-5 aspects.
//
// What those suites DO NOT touch — the gap this file fills — is the VALIDATION
// layer that fires AFTER a flow file parses cleanly: the structural integrity
// checks that protect the graph from silently-wrong flows. None of the three
// validator functions below has a single direct unit test:
//
//   * checkBrokenFlowRefs   — flow-node-broken / broken-flow-ref
//   * checkDanglingAspectRefs (flow branch) — aspect-undefined / dangling-aspect-ref
//   * checkMissingDescriptions (flow branch) — description-missing
//
// Plus the cross-cutting INVARIANTS that, if broken, mean false-green or lost
// enforcement: a broken participant must NOT suppress propagation to the valid
// participants; an aspect referenced only by a flow must NOT be flagged orphaned
// (which would tempt deletion and silently drop the flow contract); and the
// validator must report EVERY broken ref, not stop at the first.
//
// Assertions encode the CORRECT (documented / code-intended) behavior. Where an
// assertion could not be satisfied because the code is genuinely wrong, the
// bounty is recorded in structured output and the offending assertion removed
// so the saved file stays 100% green.
// ============================================================================

afterEach(() => cleanupTestGraphs());

// ---- low-level builder for cases buildTestGraph cannot express -------------
// buildTestGraph always wires architecture types and a tmp rootPath. For the
// validator unit tests we want a minimal hand-rolled graph so the assertion is
// about the function under test and nothing else.

function bareGraph(over: Partial<Graph>): Graph {
  return {
    config: {},
    architecture: { node_types: { service: { description: '' }, module: { description: '' } } },
    nodes: new Map<string, GraphNode>(),
    aspects: [],
    flows: [],
    rootPath: '/tmp/does-not-matter',
    ...over,
  } as unknown as Graph;
}

function node(p: string, type = 'service'): GraphNode {
  return { path: p, meta: { name: p, type, description: 'd' }, children: [], parent: null } as GraphNode;
}

function flow(over: Partial<FlowDef> & { path: string; nodes: string[] }): FlowDef {
  return { name: over.path, description: 'd', aspects: [], ...over } as FlowDef;
}

const codes = (issues: { code?: string }[]): (string | undefined)[] => issues.map((i) => i.code);

// ============================================================================
// 1. checkBrokenFlowRefs — flow-node-broken (INVARIANT: every flow participant
//    must resolve to an existing node path; this is the only guard against a
//    flow that silently enforces nothing because its participants are typos).
// ============================================================================

describe('checkBrokenFlowRefs — flow-node-broken', () => {
  it('a flow referencing a non-existent node emits exactly one flow-node-broken error', () => {
    const g = bareGraph({
      nodes: new Map([['svc', node('svc')]]),
      flows: [flow({ path: 'f', nodes: ['ghost'] })],
    });
    const issues = checkBrokenFlowRefs(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('flow-node-broken');
    expect(issues[0].rule).toBe('broken-flow-ref');
    expect(issues[0].severity).toBe('error');
  });

  it('the message names the FLOW (by name) and the missing node — what/why/next', () => {
    const g = bareGraph({
      nodes: new Map([['svc', node('svc')]]),
      flows: [flow({ path: 'order-processing', name: 'OrderProcessing', nodes: ['svc', 'svc/ghost'] })],
    });
    const issues = checkBrokenFlowRefs(g);
    expect(issues).toHaveLength(1);
    const m = issues[0].messageData;
    expect(m.what).toBe("Flow 'OrderProcessing' references non-existent node 'svc/ghost'.");
    expect(m.why).toContain('Flow participants must exist');
    expect(m.next).toContain('yg-flow.yaml');
  });

  it('a flow whose participants ALL exist produces no error', () => {
    const g = bareGraph({
      nodes: new Map([
        ['svc', node('svc')],
        ['mod', node('mod', 'module')],
      ]),
      flows: [flow({ path: 'f', nodes: ['svc', 'mod'] })],
    });
    expect(checkBrokenFlowRefs(g)).toHaveLength(0);
  });

  it('membership is EXACT — a path that is only a PREFIX of an existing node is broken', () => {
    // 'mod' is a directory segment of the real node 'mod/svc' but is NOT itself
    // a node here. The check must require an exact node-path match, otherwise a
    // flow could "participate" a non-node directory and enforce nothing.
    const g = bareGraph({
      nodes: new Map([['mod/svc', node('mod/svc')]]),
      flows: [flow({ path: 'f', nodes: ['mod'] })],
    });
    const issues = checkBrokenFlowRefs(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].messageData.what).toContain("non-existent node 'mod'");
  });

  it('a deeper path under an existing node, but not itself a node, is broken (no descendant leniency)', () => {
    const g = bareGraph({
      nodes: new Map([['mod', node('mod', 'module')]]),
      flows: [flow({ path: 'f', nodes: ['mod/child'] })],
    });
    const issues = checkBrokenFlowRefs(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].messageData.what).toContain("non-existent node 'mod/child'");
  });

  it('EVERY broken ref in one flow is reported — the check does not stop at the first', () => {
    const g = bareGraph({
      nodes: new Map([['svc', node('svc')]]),
      flows: [flow({ path: 'f', nodes: ['ghost1', 'svc', 'ghost2'] })],
    });
    const issues = checkBrokenFlowRefs(g);
    expect(issues).toHaveLength(2);
    const missing = issues.map((i) => i.messageData.what).join(' ');
    expect(missing).toContain("'ghost1'");
    expect(missing).toContain("'ghost2'");
    expect(missing).not.toContain("'svc'");
  });

  it('the SAME broken ref listed twice is reported twice (per-occurrence, not de-duped)', () => {
    const g = bareGraph({
      nodes: new Map([['svc', node('svc')]]),
      flows: [flow({ path: 'f', nodes: ['ghost', 'ghost'] })],
    });
    expect(checkBrokenFlowRefs(g)).toHaveLength(2);
  });

  it('broken refs are reported independently across MULTIPLE flows', () => {
    const g = bareGraph({
      nodes: new Map([['svc', node('svc')]]),
      flows: [
        flow({ path: 'a', name: 'A', nodes: ['ghost-a'] }),
        flow({ path: 'b', name: 'B', nodes: ['svc'] }),
        flow({ path: 'c', name: 'C', nodes: ['ghost-c'] }),
      ],
    });
    const issues = checkBrokenFlowRefs(g);
    expect(issues).toHaveLength(2);
    const whats = issues.map((i) => i.messageData.what).join('\n');
    expect(whats).toContain("Flow 'A'");
    expect(whats).toContain("Flow 'C'");
    expect(whats).not.toContain("Flow 'B'");
  });

  it('a graph with no flows produces no broken-ref errors', () => {
    const g = bareGraph({ nodes: new Map([['svc', node('svc')]]) });
    expect(checkBrokenFlowRefs(g)).toHaveLength(0);
  });

  it('an empty graph (no nodes, no flows) produces no broken-ref errors and does not throw', () => {
    expect(checkBrokenFlowRefs(bareGraph({}))).toHaveLength(0);
  });
});

// ============================================================================
// 2. checkDanglingAspectRefs (FLOW branch) — aspect-undefined.
//    A flow may declare aspects that do not exist; the validator must catch it,
//    otherwise the flow's "contract" is a no-op that silently enforces nothing.
//    (eff-flows.test.ts asserts the channel walk still ATTACHES an undefined id
//    to the effective set — so without this validator a typo'd aspect would be
//    effective-but-unverifiable. This is the guard.)
// ============================================================================

describe('checkDanglingAspectRefs — flow aspect undefined', () => {
  function withFlowAspect(flowAspects: string[], defined: string[] = []): Graph {
    return buildTestGraph({
      aspects: defined.map((id) => ({ id })),
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'f', nodes: ['svc'], aspects: flowAspects }],
    });
  }

  it('a flow referencing an undefined aspect emits aspect-undefined / dangling-aspect-ref', () => {
    const issues = checkDanglingAspectRefs(withFlowAspect(['phantom']));
    const flowIssues = issues.filter((i) => i.messageData.what.includes('flow'));
    expect(flowIssues).toHaveLength(1);
    expect(flowIssues[0].code).toBe('aspect-undefined');
    expect(flowIssues[0].rule).toBe('dangling-aspect-ref');
    expect(flowIssues[0].severity).toBe('error');
  });

  it('the message attributes the dangling aspect to the FLOW and explains the propagation impact', () => {
    const g = buildTestGraph({
      aspects: [],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'order-processing', nodes: ['svc'], aspects: ['phantom'] }],
    });
    const m = checkDanglingAspectRefs(g).find((i) => i.messageData.what.includes('flow'))!.messageData;
    // buildTestGraph sets flow.name === flow.path
    expect(m.what).toBe("Aspect 'phantom' is referenced by flow 'order-processing' but not defined in aspects/.");
    expect(m.why).toContain('flow requirements cannot propagate');
    expect(m.next).toContain('aspects/phantom');
  });

  it('a flow referencing a DEFINED aspect produces no dangling error', () => {
    const issues = checkDanglingAspectRefs(withFlowAspect(['real'], ['real']));
    expect(issues.filter((i) => i.messageData.what.includes('flow'))).toHaveLength(0);
  });

  it('MULTIPLE undefined flow aspects are each reported', () => {
    const issues = checkDanglingAspectRefs(withFlowAspect(['p1', 'p2'], []));
    const flowIssues = issues.filter((i) => i.messageData.what.includes('flow'));
    expect(flowIssues).toHaveLength(2);
    expect(flowIssues.map((i) => i.messageData.what).join('\n')).toContain("'p1'");
    expect(flowIssues.map((i) => i.messageData.what).join('\n')).toContain("'p2'");
  });

  it('a mix of defined and undefined flow aspects reports only the undefined one', () => {
    const issues = checkDanglingAspectRefs(withFlowAspect(['real', 'phantom'], ['real']));
    const flowIssues = issues.filter((i) => i.messageData.what.includes('flow'));
    expect(flowIssues).toHaveLength(1);
    expect(flowIssues[0].messageData.what).toContain("'phantom'");
  });

  it('a flow with no aspects key contributes no dangling errors', () => {
    const g = buildTestGraph({
      aspects: [{ id: 'real' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'f', nodes: ['svc'] }],
    });
    expect(checkDanglingAspectRefs(g).filter((i) => i.messageData.what.includes('flow'))).toHaveLength(0);
  });

  it('node, port, and flow dangling refs are all reported in one pass (each attributed to its source)', () => {
    // Hand-rolled graph: one node with an undefined OWN aspect + an undefined
    // PORT aspect, plus a flow with an undefined aspect. All three branches fire.
    const n = node('svc');
    n.meta.aspects = ['undef-node'];
    n.meta.ports = { p: { aspects: ['undef-port'] } } as unknown as GraphNode['meta']['ports'];
    const g = bareGraph({
      aspects: [],
      nodes: new Map([['svc', n]]),
      flows: [flow({ path: 'f', name: 'F', nodes: ['svc'], aspects: ['undef-flow'] })],
    });
    const issues = checkDanglingAspectRefs(g);
    expect(codes(issues).every((c) => c === 'aspect-undefined')).toBe(true);
    const whats = issues.map((i) => i.messageData.what).join('\n');
    expect(whats).toContain('undef-node');
    expect(whats).toContain('undef-port');
    expect(whats).toContain('undef-flow');
    // exactly one of each
    expect(issues).toHaveLength(3);
  });
});

// ============================================================================
// 3. checkMissingDescriptions (FLOW branch) — description-missing.
// ============================================================================

describe('checkMissingDescriptions — flow description', () => {
  it('a flow with no description emits description-missing naming the flow', () => {
    const g = bareGraph({ flows: [{ path: 'f', name: 'MyFlow', nodes: ['svc'] } as FlowDef] });
    const flowIssues = checkMissingDescriptions(g).filter((i) => i.messageData.what.includes('Flow'));
    expect(flowIssues).toHaveLength(1);
    expect(flowIssues[0].code).toBe('description-missing');
    expect(flowIssues[0].severity).toBe('error');
    expect(flowIssues[0].messageData.what).toBe("Flow 'MyFlow' has no description.");
  });

  it('a whitespace-only description is treated as missing (trim) ', () => {
    const g = bareGraph({ flows: [{ path: 'f', name: 'MyFlow', nodes: ['svc'], description: '   ' } as FlowDef] });
    const flowIssues = checkMissingDescriptions(g).filter((i) => i.messageData.what.includes('Flow'));
    expect(flowIssues).toHaveLength(1);
  });

  it('a flow with a real description produces no description-missing for the flow', () => {
    const g = bareGraph({ flows: [{ path: 'f', name: 'MyFlow', nodes: ['svc'], description: 'real' } as FlowDef] });
    expect(checkMissingDescriptions(g).filter((i) => i.messageData.what.includes('Flow'))).toHaveLength(0);
  });
});

// ============================================================================
// 4. checkOrphanedAspects — an aspect referenced ONLY by a flow is NOT orphaned.
//    INVARIANT: deleting such an aspect (because it looked orphaned) would
//    silently drop the flow's contract. Flow references must count.
// ============================================================================

describe('checkOrphanedAspects — flow references count as usage', () => {
  it('an aspect referenced only by a flow is NOT reported orphaned', () => {
    const g = buildTestGraph({
      aspects: [{ id: 'flow-only' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'f', nodes: ['svc'], aspects: ['flow-only'] }],
    });
    expect(checkOrphanedAspects(g).filter((i) => i.code === 'orphaned-aspect')).toHaveLength(0);
  });

  it('an aspect referenced by NOBODY (no node/type/flow) IS reported orphaned (warning)', () => {
    const g = buildTestGraph({
      aspects: [{ id: 'lonely' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'f', nodes: ['svc'] }],
    });
    const orphans = checkOrphanedAspects(g).filter((i) => i.code === 'orphaned-aspect' && i.messageData.what.includes('lonely'));
    expect(orphans).toHaveLength(1);
    expect(orphans[0].severity).toBe('warning');
  });

  it('an unattached rule installed from a package names yg pack remove, never a hand deletion', () => {
    const g = buildTestGraph({
      aspects: [{ id: 'packages/acme/law/house-style/example' }, { id: 'lonely' }],
      nodes: [{ path: 'svc', type: 'service' }],
    });
    const orphans = checkOrphanedAspects(g).filter((i) => i.code === 'orphaned-aspect');
    const installed = orphans.find((i) => i.messageData.what.includes('packages/acme/law/house-style/example'));
    expect(installed?.messageData.next).toContain('yg pack remove house-style');
    expect(installed?.messageData.next).not.toContain('or remove it');
    const own = orphans.find((i) => i.messageData.what.includes("'lonely'"));
    expect(own?.messageData.next).toContain('remove it');
  });

  it('an aspect IMPLIED by a flow-referenced aspect is also exempt (implies fixpoint over flow refs)', () => {
    const g = buildTestGraph({
      aspects: [
        { id: 'bundle', implies: ['child'] },
        { id: 'child' },
      ],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'f', nodes: ['svc'], aspects: ['bundle'] }],
    });
    expect(checkOrphanedAspects(g).filter((i) => i.code === 'orphaned-aspect')).toHaveLength(0);
  });
});

// ============================================================================
// 5. CROSS-CUTTING INVARIANTS — propagation must survive broken/undefined refs
//    (no false-green: a valid participant still gets the aspect; a flow whose
//    only participants are broken attaches to nobody).
// ============================================================================

describe('flow propagation invariants under broken/partial input', () => {
  it('a broken participant does NOT suppress propagation to a VALID participant in the same flow', () => {
    // flow lists [svc (real), ghost (broken)] — svc must still get the aspect.
    const g = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'f', nodes: ['svc', 'ghost'], aspects: ['F'] }],
    });
    expect(computeEffectiveAspects(g.nodes.get('svc')!, g).has('F')).toBe(true);
    expect(computeEffectiveAspectStatuses(g.nodes.get('svc')!, g).get('F')).toBe('enforced');
    // and the broken ref is still flagged so CI catches the typo.
    expect(checkBrokenFlowRefs(g)).toHaveLength(1);
  });

  it('a flow whose participants are ALL broken attaches its aspect to nobody', () => {
    const g = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'f', nodes: ['ghost'], aspects: ['F'] }],
    });
    expect(computeEffectiveAspects(g.nodes.get('svc')!, g).has('F')).toBe(false);
  });

  it('descendant inclusion: declaring a PARENT participant covers its child, even when a sibling broken ref is present', () => {
    const g = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [
        { path: 'mod', type: 'module' },
        { path: 'mod/svc', type: 'service', parent: 'mod' },
      ],
      flows: [{ path: 'f', nodes: ['mod', 'ghost'], aspects: ['F'] }],
    });
    // child gets the aspect via parent participation
    expect(computeEffectiveAspects(g.nodes.get('mod/svc')!, g).has('F')).toBe(true);
    // collectParticipatingFlows mirrors the same descendant rule for the child
    expect(collectParticipatingFlows(g, g.nodes.get('mod/svc')!).map((x) => x.path)).toEqual(['f']);
  });

  it('a node in MULTIPLE flows accumulates aspects even when one of those flows ALSO has a broken ref', () => {
    const g = buildTestGraph({
      aspects: [
        { id: 'F1', status: 'enforced' },
        { id: 'F2', status: 'enforced' },
      ],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [
        { path: 'a', nodes: ['svc'], aspects: ['F1'] },
        { path: 'b', nodes: ['svc', 'ghost'], aspects: ['F2'] },
      ],
    });
    expect([...computeEffectiveAspects(g.nodes.get('svc')!, g)].sort()).toEqual(['F1', 'F2']);
    // both flows participate for the node
    expect(collectParticipatingFlows(g, g.nodes.get('svc')!).map((x) => x.path).sort()).toEqual(['a', 'b']);
    // the broken ref in flow 'b' is still reported
    expect(checkBrokenFlowRefs(g)).toHaveLength(1);
  });
});

// ============================================================================
// 6. E2E — spawn the real binary against a temp copy of the e2e-lifecycle
//    fixture. Hermetic: the LLM aspect is stripped so the reviewer endpoint is
//    never contacted; only deterministic check.mjs aspects + structural
//    validation drive the outcome. No network, no clock, no randomness.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

const archPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
const flowYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');

/** Copy the fixture and strip the LLM aspect so the suite is fully hermetic. */
function deterministicFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-bounty3-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  const arch = readFileSync(archPath(dir), 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath(dir), arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });
  return dir;
}

function writeFlow(dir: string, lines: string[]): void {
  writeFileSync(flowYaml(dir), lines.join('\n') + '\n', 'utf-8');
}

describe.skipIf(!distExists)('CLI E2E — flow structural validation (broken node ref / undefined aspect)', () => {
  it('E1: a flow referencing a non-existent node blocks check with flow-node-broken (exit 1)', () => {
    const dir = deterministicFixture('e1');
    try {
      writeFlow(dir, [
        'name: OrderProcessing',
        'description: End-to-end processing of a customer order.',
        'nodes:',
        '  - services/orders',
        '  - services/ghost',
        'aspects:',
        '  - no-todo-comments',
      ]);
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('flow-node-broken');
      expect(check.all).toContain("references non-existent node 'services/ghost'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E2: a flow referencing an undefined aspect blocks check with aspect-undefined attributed to the flow (exit 1)', () => {
    const dir = deterministicFixture('e2');
    try {
      writeFlow(dir, [
        'name: OrderProcessing',
        'description: End-to-end processing of a customer order.',
        'nodes:',
        '  - services/orders',
        '  - services/payments',
        'aspects:',
        '  - no-todo-comments',
        '  - phantom-aspect',
      ]);
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('aspect-undefined');
      expect(check.all).toContain("Aspect 'phantom-aspect' is referenced by flow 'OrderProcessing'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E3: the committed (valid) flow does NOT trip either structural check — check passes after the lock is filled (exit 0)', () => {
    const dir = deterministicFixture('e3');
    try {
      // Fill the lock for the deterministic participants (free, no reviewer),
      // then plain check is clean.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
      expect(check.all).not.toContain('flow-node-broken');
      expect(check.all).not.toContain('aspect-undefined');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
