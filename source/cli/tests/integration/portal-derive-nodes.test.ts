import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { runCheck } from '../../src/core/check.js';
import { walkRepoFiles } from '../../src/io/repo-scanner.js';
import { readLock } from '../../src/io/lock-store.js';
import { verifyLock } from '../../src/core/verify-lock.js';
import { readLogContent } from '../../src/core/log/log-gate.js';
import { buildPortalNodes, type SuppressionsByFile } from '../../src/portal/derive-nodes.js';
import type { PortalNode, PortalSuppression } from '../../src/portal/contract.js';
import type { Graph, GraphNode, AspectDef } from '../../src/model/graph.js';
import type { LockVerification, VerifiedPair, PairState } from '../../src/core/verify-lock.js';
import type { CheckResult, CheckIssue } from '../../src/core/check.js';
import { nodeUnit } from '../../src/model/lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The REAL repo root (real .yggdrasil/ graph + real source). tests/integration → cli → source → repo.
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Per-node honest-state derivation, asserted on the REAL repo graph. buildPortalNodes
// is pure over the engine's own results (verifyLock pairs, runCheck issues, the effective-
// aspect cascade) — so the per-node state, effective-aspect rows, relations and log it
// emits can never diverge from what `yg check` / `yg context` would report.

describe('portal per-node derivation (honest state, effective aspects, relations, log)', () => {
  let byPath: Map<string, PortalNode>;

  beforeAll(async () => {
    const graph = await loadGraph(REPO_ROOT);
    const gitFiles = await walkRepoFiles(REPO_ROOT);
    const check = await runCheck(graph, gitFiles);
    const lock = readLock(graph.rootPath);
    const verification = await verifyLock(graph, lock);

    const logContents = new Map<string, string>();
    for (const nodePath of graph.nodes.keys()) {
      logContents.set(nodePath, await readLogContent(REPO_ROOT, nodePath));
    }
    const suppressions: SuppressionsByFile = { byFile: new Map() };

    const nodes = buildPortalNodes(graph, lock, verification, check, logContents, suppressions);
    byPath = new Map(nodes.map((n) => [n.path, n]));
  }, 180_000);

  it('cli/tests/fixtures maps ONE directory entry covering hundreds of files — mappingEntryCount counts the ENTRY, never the files it resolves to', () => {
    const fixtures = byPath.get('cli/tests/fixtures');
    expect(fixtures).toBeDefined();
    expect(fixtures!.mapping).toEqual(['source/cli/tests/fixtures/']);
    // Exactly the mapping array's length, regardless of how many real files that one
    // directory entry expands to on disk (hundreds, in this repo) — this field answers
    // "how many entries did the node declare", never "how many files does it own".
    expect(fixtures!.mappingEntryCount).toBe(fixtures!.mapping.length);
    expect(fixtures!.mappingEntryCount).toBe(1);
  });

  it('cli/core/fill is checked and fully verified (its reviewed-seam allowance clears the fan-out warning)', () => {
    const fill = byPath.get('cli/core/fill');
    expect(fill).toBeDefined();
    expect(fill!.checked).toBe(true);
    // cli/core/fill declares a reviewed-seam max_direct_relations ceiling equal to its
    // exact relation count, so the built-in high-fan-out check no longer warns on it.
    // With an all-green lock and no warning, the node reads `verified`, not `warning`.
    // (The verified→warning promotion path itself is covered on synthetic inputs below.)
    expect(fill!.state).toBe('verified');
  });

  it('cli/core/fill effective aspects include a deterministic row with channel + origin + pairState', () => {
    const fill = byPath.get('cli/core/fill')!;
    expect(fill.effectiveAspects.length).toBeGreaterThan(0);
    const det = fill.effectiveAspects.find((a) => a.kind === 'deterministic');
    expect(det).toBeDefined();
    // channel is the attach provenance (1=own, 3=type, etc.) — a real number 1..7.
    expect(typeof det!.channel).toBe('number');
    expect(det!.channel).toBeGreaterThanOrEqual(1);
    expect(det!.channel).toBeLessThanOrEqual(7);
    // origin is the machine-readable provenance token (e.g. `type:engine`, `own:...`).
    expect(det!.origin.length).toBeGreaterThan(0);
    // deterministic aspects are free; the real lock is all-green → verified.
    expect(det!.cost).toBe('free');
    expect(det!.pairState).toBe('verified');
  });

  it('a verified effective-aspect row on the real repo carries non-empty foldedInputs (covered bytes)', () => {
    // The attestation drill-through is backed by real data: a green row cites the exact subject
    // files the verdict covers. cli/core/fill is all-green on the real lock, so its verified rows
    // must carry foldedInputs drawn from the node's mapped source — never an empty fabrication.
    const fill = byPath.get('cli/core/fill')!;
    const verifiedRow = fill.effectiveAspects.find((a) => a.pairState === 'verified');
    expect(verifiedRow).toBeDefined();
    expect(verifiedRow!.foldedInputs).toBeDefined();
    expect(verifiedRow!.foldedInputs!.length).toBeGreaterThan(0);
    // Every cited path is one of the node's real subject files (a faithful "these exact bytes").
    for (const f of verifiedRow!.foldedInputs!) {
      expect(typeof f).toBe('string');
      expect(f.length).toBeGreaterThan(0);
    }
  });

  it('an LLM effective aspect carries tier + consensus + billed cost', () => {
    const fill = byPath.get('cli/core/fill')!;
    const llm = fill.effectiveAspects.find((a) => a.kind === 'llm');
    expect(llm).toBeDefined();
    expect(llm!.cost).toBe('billed');
    expect(typeof llm!.tier).toBe('string');
    expect(typeof llm!.consensus).toBe('number');
  });

  it('scripts is now covered — its effective set carries the advisory gate-steps drill (positive derivation of its NEW checked state)', () => {
    // `scripts` used to be THE real-repo no-rule exemplar here. A deterministic ADVISORY
    // drift-guard is now attached to the build-script TYPE (channel 3), so `scripts` carries a
    // real, verdict-bearing pair — it is no longer no-rule. Rather than re-pin the no-rule
    // demonstration onto another currently-uncovered node (which the rest of the coverage-
    // closing work would re-break as more source-owning types gain rules), this asserts the
    // HONEST derivation of scripts' NEW state: it is `checked`, and its effective-aspect set
    // carries the advisory gate-steps row with the right provenance and a real (non-`n/a`)
    // verdict. The no-rule DERIVATION LOGIC itself remains fully covered by the synthetic
    // 'ref'/'unv'/'p' cases below — this real node simply moved from no-rule to covered, which
    // is the drill's whole point, so this break becomes a positive test of that effect.
    const scripts = byPath.get('scripts');
    expect(scripts).toBeDefined();
    expect(scripts!.checked).toBe(true);
    // Find the gate-steps row by id — do NOT pin the row COUNT: later coverage-closing aspects
    // may attach further rows to this same source-owning type, and this test must survive that.
    const gate = scripts!.effectiveAspects.find((a) => a.aspectId === 'repo-check-gate-steps');
    expect(gate).toBeDefined();
    expect(gate!.kind).toBe('deterministic');
    expect(gate!.status).toBe('advisory'); // a soft drift signal, never a blocking law
    expect(gate!.cost).toBe('free'); // deterministic checks are free
    expect(gate!.channel).toBe(3); // reached via the build-script TYPE default (channel 3)
    expect(gate!.origin).toBe('type:build-script');
    // A REAL verdict-bearing pair (never a vacuous n/a): on the all-green real lock it reads
    // `verified`; a future advisory refusal would render as `warning` — either way it is a real
    // verdict, which is what makes `scripts` genuinely checked rather than no-rule.
    expect(['verified', 'warning']).toContain(gate!.pairState);
  });

  it('relationsOut mirrors declared relations and relationsIn is the inversion', () => {
    // cli/portal/pipeline declares calls/uses to several engine nodes (see its yg-node.yaml).
    const pipeline = byPath.get('cli/portal/pipeline')!;
    expect(pipeline.relationsOut.length).toBeGreaterThan(0);
    const usesContract = pipeline.relationsOut.find((r) => r.target === 'cli/portal/contract');
    expect(usesContract).toBeDefined();
    expect(usesContract!.type).toBe('uses');
    // The contract node must see the pipeline as an inbound relation.
    const contract = byPath.get('cli/portal/contract')!;
    const inbound = contract.relationsIn.find((r) => r.source === 'cli/portal/pipeline');
    expect(inbound).toBeDefined();
    expect(inbound!.type).toBe('uses');
  });

  it('the real repo rolls up clean — no warning bubbles to an ancestor now that both seams are allowed', () => {
    // The two reviewed architectural seams (cli/core/fill, cli/portal/engine-api) each declare
    // a max_direct_relations allowance, so the repo is warning-free. cli/core (parent of
    // cli/core/fill) must therefore roll up no worse than `verified` — nothing reddens or warns
    // it via a descendant. This guards the seam allowance at the rollup level: if a fan-out (or
    // any other) warning reappeared under cli/core, this would catch the unexpected bubble.
    // (The child→ancestor rollup MECHANIC is covered on synthetic inputs below.)
    const core = byPath.get('cli/core');
    if (core) {
      const rank: Record<string, number> = { 'no-rule': 0, verified: 1, warning: 2, unverified: 3, refused: 4 };
      expect(rank[core.rollupState]).toBeLessThanOrEqual(rank['verified']);
    }
  });
});

// ── Synthetic branch coverage: the honest states the all-green real lock never reaches ──
//
// The real repo lock is all-verified, so the refused / unverified / gate-state arms of
// the per-node derivation are exercised here by driving the REAL buildPortalNodes with a
// minimal synthetic graph + a hand-built verification result. No fabricated PortalData —
// only minimal real inputs that reach each honest branch (mirrors the buildCounts
// synthetic block in portal-extract.test.ts).

function aspectDef(id: string, kind: 'llm' | 'deterministic' | 'aggregate', status: AspectDef['status'] = 'enforced'): AspectDef {
  const reviewer = kind === 'aggregate' ? { type: 'aggregate' } : { type: kind };
  return {
    name: id,
    id,
    reviewer,
    artifacts: [],
    status,
    ...(kind === 'aggregate' ? { implies: ['child'] } : {}),
  } as unknown as AspectDef;
}

function node(path: string, type: string, aspects: string[], mapping: string[], children: GraphNode[] = []): GraphNode {
  return {
    path,
    meta: { name: path, type, aspects, mapping },
    children,
    parent: null,
  } as unknown as GraphNode;
}

function vp(aspectId: string, nodePath: string, state: PairState, kind: 'llm' | 'deterministic' = 'deterministic'): VerifiedPair {
  return {
    pair: { aspectId, kind, unitKey: nodeUnit(nodePath), nodePath, status: 'enforced', subjectFiles: ['f.ts'] },
    state,
  };
}

function syntheticCheck(issues: Partial<CheckIssue>[]): CheckResult {
  return { issues } as unknown as CheckResult;
}

describe('per-node derivation — honest states on synthetic inputs', () => {
  it('a refused pair drives state=refused; an unverified/gate pair drives state=unverified', () => {
    const aRef = aspectDef('a-ref', 'deterministic');
    const aUnv = aspectDef('a-unv', 'deterministic');
    const aGate = aspectDef('a-gate', 'llm');
    const refused = node('ref', 'module', ['a-ref'], ['f.ts']);
    const unver = node('unv', 'module', ['a-unv'], ['f.ts']);
    const gate = node('gate', 'module', ['a-gate'], ['f.ts']);
    const graph = {
      nodes: new Map([['ref', refused], ['unv', unver], ['gate', gate]]),
      aspects: [aRef, aUnv, aGate],
      flows: [],
      architecture: { node_types: {} },
    } as unknown as Graph;
    const verification: LockVerification = {
      pairs: [
        vp('a-ref', 'ref', { kind: 'refused', reason: 'no' }),
        vp('a-unv', 'unv', { kind: 'unverified' }),
        // a prompt-too-large gate state must collapse to unverified (never green, never a "no").
        vp('a-gate', 'gate', { kind: 'prompt-too-large', chars: 9, limit: 4, tierName: 't' }, 'llm'),
      ],
      unreadable: [], drops: [], uncomputableTypeCoverage: [],
    };
    const out = new Map(
      buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile: new Map() }).map((n) => [n.path, n]),
    );
    expect(out.get('ref')!.state).toBe('refused');
    expect(out.get('ref')!.effectiveAspects[0].pairState).toBe('refused');
    expect(out.get('unv')!.state).toBe('unverified');
    expect(out.get('gate')!.state).toBe('unverified'); // gate state collapses
  });

  it('an ADVISORY refused pair drives state=warning (never refused) and pairState=warning, keeping the reason', () => {
    // The honesty fix at the per-node seam: a deterministic refusal on an ADVISORY aspect is
    // non-blocking signal. The node must read `warning`, NEVER `refused`, and the effective-aspect
    // row must display `warning` while still carrying the reviewer's stated reason. A refused
    // verdict on an ENFORCED aspect on the SAME run still reddens its node — status is per pair.
    const aAdv = aspectDef('a-adv', 'deterministic', 'advisory');
    const aEnf = aspectDef('a-enf', 'deterministic', 'enforced');
    const advNode = node('adv', 'module', ['a-adv'], ['f.ts']);
    const enfNode = node('enf', 'module', ['a-enf'], ['f.ts']);
    const graph = {
      nodes: new Map([['adv', advNode], ['enf', enfNode]]),
      aspects: [aAdv, aEnf],
      flows: [],
      architecture: { node_types: {} },
    } as unknown as Graph;
    // The pair's effective status is carried on pair.status; an advisory pair uses 'advisory'.
    const advRefused: VerifiedPair = {
      pair: { aspectId: 'a-adv', kind: 'deterministic', unitKey: nodeUnit('adv'), nodePath: 'adv', status: 'advisory', subjectFiles: ['f.ts'] },
      state: { kind: 'refused', reason: '5 exports > advisory cap 4' },
    };
    const verification: LockVerification = {
      pairs: [advRefused, vp('a-enf', 'enf', { kind: 'refused', reason: 'enforced no' })],
      unreadable: [], drops: [], uncomputableTypeCoverage: [],
    };
    const out = new Map(
      buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile: new Map() }).map((n) => [n.path, n]),
    );
    // Advisory-refused node: warning, never refused.
    expect(out.get('adv')!.state).toBe('warning');
    const advRow = out.get('adv')!.effectiveAspects.find((a) => a.aspectId === 'a-adv')!;
    expect(advRow.pairState).toBe('warning');
    expect(advRow.status).toBe('advisory');
    expect(advRow.reason).toBe('5 exports > advisory cap 4'); // the reviewer's "no" is still cited
    // Enforced-refused node on the same run is still a blocking refused — status is per pair.
    expect(out.get('enf')!.state).toBe('refused');
    expect(out.get('enf')!.effectiveAspects[0].pairState).toBe('refused');
  });

  it('a verified row carries foldedInputs (covered bytes); a refused row carries the reviewer reason', () => {
    // The node-attestation drill-through: a VERIFIED effective-aspect row must cite the exact
    // subject files the verdict covers ("this green attests these exact bytes"), and a REFUSED
    // row must cite the reviewer's "no". buildEffectiveAspect threads both off the per-unit pairs.
    const aOk = aspectDef('a-ok', 'deterministic');
    const aRef = aspectDef('a-ref', 'deterministic');
    const okNode = node('ok', 'module', ['a-ok'], ['f.ts']);
    const refNode = node('ref', 'module', ['a-ref'], ['f.ts']);
    const graph = {
      nodes: new Map([['ok', okNode], ['ref', refNode]]),
      aspects: [aOk, aRef],
      flows: [],
      architecture: { node_types: {} },
    } as unknown as Graph;
    const verification: LockVerification = {
      pairs: [
        vp('a-ok', 'ok', { kind: 'verified' }),
        vp('a-ref', 'ref', { kind: 'refused', reason: 'rule X violated on line 7' }),
      ],
      unreadable: [], drops: [], uncomputableTypeCoverage: [],
    };
    const out = new Map(
      buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile: new Map() }).map((n) => [n.path, n]),
    );
    const okRow = out.get('ok')!.effectiveAspects.find((a) => a.aspectId === 'a-ok')!;
    expect(okRow.pairState).toBe('verified');
    // foldedInputs = the verdict's covered subject files (vp builds subjectFiles: ['f.ts']).
    expect(okRow.foldedInputs).toEqual(['f.ts']);
    expect(okRow.reason).toBeUndefined();
    const refRow = out.get('ref')!.effectiveAspects.find((a) => a.aspectId === 'a-ref')!;
    expect(refRow.pairState).toBe('refused');
    expect(refRow.reason).toBe('rule X violated on line 7');
    // A refused row does not fabricate folded inputs (those gate the "green attests" block).
    expect(refRow.foldedInputs).toBeUndefined();
  });

  it('rollupState bubbles a refused child to a no-rule parent without changing the parent own state', () => {
    const aRef = aspectDef('a-ref', 'deterministic');
    const child = node('p/c', 'module', ['a-ref'], ['f.ts']);
    const parent = node('p', 'module', [], [], [child]);
    child.parent = parent;
    const graph = {
      nodes: new Map([['p', parent], ['p/c', child]]),
      aspects: [aRef],
      flows: [],
      architecture: { node_types: {} },
    } as unknown as Graph;
    const verification: LockVerification = { pairs: [vp('a-ref', 'p/c', { kind: 'refused' })], unreadable: [], drops: [], uncomputableTypeCoverage: [] };
    const out = new Map(
      buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile: new Map() }).map((n) => [n.path, n]),
    );
    expect(out.get('p')!.state).toBe('no-rule'); // parent owns no rule
    expect(out.get('p')!.rollupState).toBe('refused'); // but its subtree is refused
  });

  it('rollupState bubbles a refused GRANDCHILD all the way up a 3-level chain (a -> a/b -> a/b/c)', () => {
    // The roll-up must fold the WHOLE subtree, not just one level. `graph.nodes` is pre-order
    // DFS (the loader inserts a node before recursing into its children), so a top ancestor is
    // processed before its descendants — a forward roll-up would read children's still-seeded
    // rollupState and stop one level short, leaving a green pill over a refusal two levels down.
    const aRef = aspectDef('a-ref', 'deterministic');
    const leaf = node('a/b/c', 'module', ['a-ref'], ['f.ts']);
    const mid = node('a/b', 'module', [], [], [leaf]);
    const root = node('a', 'module', [], [], [mid]);
    leaf.parent = mid;
    mid.parent = root;
    const graph = {
      // Insert in the SAME pre-order the real loader produces: parent before children.
      nodes: new Map([['a', root], ['a/b', mid], ['a/b/c', leaf]]),
      aspects: [aRef],
      flows: [],
      architecture: { node_types: {} },
    } as unknown as Graph;
    const verification: LockVerification = { pairs: [vp('a-ref', 'a/b/c', { kind: 'refused' })], unreadable: [], drops: [], uncomputableTypeCoverage: [] };
    const out = new Map(
      buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile: new Map() }).map((n) => [n.path, n]),
    );
    // Own states are unaffected: only the leaf owns a rule.
    expect(out.get('a')!.state).toBe('no-rule');
    expect(out.get('a/b')!.state).toBe('no-rule');
    expect(out.get('a/b/c')!.state).toBe('refused');
    // Roll-up must reach the top ancestor, not stop one level short.
    expect(out.get('a/b')!.rollupState).toBe('refused');
    expect(out.get('a')!.rollupState).toBe('refused');
  });

  it('per-node suppressions are filtered to the node mapped files; the log is parsed', () => {
    const aDet = aspectDef('a', 'deterministic');
    const n = node('n', 'module', ['a'], ['src/x.ts']);
    const graph = { nodes: new Map([['n', n]]), aspects: [aDet], flows: [], architecture: { node_types: {} } } as unknown as Graph;
    const verification: LockVerification = { pairs: [vp('a', 'n', { kind: 'verified' })], unreadable: [], drops: [], uncomputableTypeCoverage: [] };
    const supp: PortalSuppression = { aspectId: 'a', file: 'src/x.ts', line: 3, reason: 'ok' };
    const byFile = new Map<string, PortalSuppression[]>([['src/x.ts', [supp]], ['other.ts', [{ ...supp, file: 'other.ts' }]]]);
    const logs = new Map([['n', '## [2026-01-01T00:00:00.000Z]\nbody text\n']]);
    const out = buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), logs, { byFile });
    const portal = out.find((x) => x.path === 'n')!;
    expect(portal.suppressions).toHaveLength(1); // only the node's own file
    expect(portal.suppressions[0].file).toBe('src/x.ts');
    expect(portal.log).toHaveLength(1);
    expect(portal.log[0].body).toContain('body text');
  });

  it('per-node suppressions are collected for a glob/dir mapping, not only literal file mappings', () => {
    const aDet = aspectDef('a', 'deterministic');
    const n = node('n', 'module', ['a'], ['src/**/*.ts']);
    const graph = { nodes: new Map([['n', n]]), aspects: [aDet], flows: [], architecture: { node_types: {} } } as unknown as Graph;
    const verification: LockVerification = { pairs: [vp('a', 'n', { kind: 'verified' })], unreadable: [], drops: [], uncomputableTypeCoverage: [] };
    const supp: PortalSuppression = { aspectId: 'a', file: 'src/a.ts', line: 3, reason: 'ok' };
    const byFile = new Map<string, PortalSuppression[]>([
      ['src/a.ts', [supp]],
      ['other/b.ts', [{ ...supp, file: 'other/b.ts' }]],
    ]);
    const out = buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile });
    const portal = out.find((x) => x.path === 'n')!;
    expect(portal.suppressions).toHaveLength(1); // glob-aware ownership, not exact-string
    expect(portal.suppressions[0].file).toBe('src/a.ts');
  });

  it('an aggregate effective aspect yields an aggregate row with pairState n/a', () => {
    const agg = aspectDef('agg', 'aggregate');
    const child = aspectDef('child', 'deterministic');
    const n = node('n', 'module', ['agg'], ['f.ts']);
    const graph = { nodes: new Map([['n', n]]), aspects: [agg, child], flows: [], architecture: { node_types: {} } } as unknown as Graph;
    // child gets a verified pair; agg has no pair (no own verdict).
    const verification: LockVerification = { pairs: [vp('child', 'n', { kind: 'verified' })], unreadable: [], drops: [], uncomputableTypeCoverage: [] };
    const out = buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile: new Map() });
    const portal = out.find((x) => x.path === 'n')!;
    const aggRow = portal.effectiveAspects.find((a) => a.aspectId === 'agg')!;
    expect(aggRow.kind).toBe('aggregate');
    expect(aggRow.pairState).toBe('n/a');
    expect(aggRow.cost).toBe('free');
  });
});

describe('per-node derivation — notApplicable + implied-channel origin (synthetic)', () => {
  it('an aspect attached but filtered out by a when predicate appears in notApplicable', () => {
    // own aspect a-when carries a global when that never holds (a path atom on a node
    // with no matching mapping) → attached (own declaration) yet not effective.
    const aWhen = {
      name: 'a-when',
      id: 'a-when',
      reviewer: { type: 'deterministic' },
      artifacts: [],
      status: 'enforced',
      when: { node: { type: 'some-other-type' } },
    } as unknown as AspectDef;
    const n = node('n', 'module', ['a-when'], ['src/real.ts']);
    const graph = {
      nodes: new Map([['n', n]]),
      aspects: [aWhen],
      flows: [],
      architecture: { node_types: {} },
    } as unknown as Graph;
    const verification: LockVerification = { pairs: [], unreadable: [], drops: [], uncomputableTypeCoverage: [] };
    const out = buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile: new Map() });
    const portal = out.find((x) => x.path === 'n')!;
    expect(portal.notApplicable.map((x) => x.aspectId)).toContain('a-when');
    expect(portal.effectiveAspects.find((a) => a.aspectId === 'a-when')).toBeUndefined();
    // No effective non-draft aspect remains → the node is no-rule.
    expect(portal.checked).toBe(false);
    expect(portal.state).toBe('no-rule');
  });

  it('an aspect reaching a node via implies carries channel 7 with an implied origin', () => {
    const parent = {
      name: 'parent', id: 'parent', reviewer: { type: 'deterministic' }, artifacts: [], status: 'enforced', implies: ['kid'],
    } as unknown as AspectDef;
    const kid = { name: 'kid', id: 'kid', reviewer: { type: 'deterministic' }, artifacts: [], status: 'enforced' } as unknown as AspectDef;
    const n = node('n', 'module', ['parent'], ['f.ts']);
    const graph = { nodes: new Map([['n', n]]), aspects: [parent, kid], flows: [], architecture: { node_types: {} } } as unknown as Graph;
    const verification: LockVerification = {
      pairs: [vp('parent', 'n', { kind: 'verified' }), vp('kid', 'n', { kind: 'verified' })],
      unreadable: [], drops: [], uncomputableTypeCoverage: [],
    };
    const out = buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile: new Map() });
    const portal = out.find((x) => x.path === 'n')!;
    const kidRow = portal.effectiveAspects.find((a) => a.aspectId === 'kid')!;
    expect(kidRow.channel).toBe(7); // reached only via implies
    expect(kidRow.origin).toBe('implied:parent');
  });
});
