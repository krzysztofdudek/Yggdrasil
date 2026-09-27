/**
 * Unit tests for formatters/impact-text.ts — the words of `yg impact`. The
 * formatter is pure: every fact arrives as data, so each branch of the text is
 * pinned from the shape it words.
 */
import { describe, it, expect } from 'vitest';
import {
  renderAspectImpact,
  renderFlowImpact,
  renderGraduationPreview,
  renderImpactTotal,
  renderNodeFillCost,
  renderStrictCoverageGap,
  renderTypeCoveredFiles,
  renderTypeHeader,
  renderTypeNext,
  renderTypeVerdictImpact,
} from '../../../src/formatters/impact-text.js';
import type { AspectImpact, FlowImpact, ImpactSummary } from '../../../src/model/impact.js';
import type { ArchitectureNodeType } from '../../../src/model/graph.js';

const aspect = (over: Partial<AspectImpact> = {}): AspectImpact => ({
  aspectId: 'r',
  affected: [{ path: 'a', source: 'own', status: 'enforced', refused: true }],
  indirectPaths: [],
  chains: [],
  propagatingFlows: [],
  impliedBy: [],
  implies: [],
  cost: { kind: 'llm', units: 3, reviewerCalls: 6, fileUnits: 0 },
  ...over,
});

describe('renderAspectImpact', () => {
  it('words a reviewer rule\'s cost with its calls and names the paid fill', () => {
    const out = renderAspectImpact(aspect({ chains: ['a → b'], propagatingFlows: ['F'], impliedBy: ['x'], implies: ['y'] }));
    expect(out).toContain('  a (own) [enforced] [refused]\n');
    expect(out).toContain('Indirectly affected (structural dependents):\n  a → b\n');
    expect(out).toContain('Flows propagating this aspect: F\n');
    expect(out).toContain('Implied by: x\nImplies: y\n');
    expect(out).toContain('re-verified by yg check --approve at 6 reviewer calls (consensus included)');
    expect(out).toContain('next: weigh the cost above before editing the aspect, then run yg check --approve  (3 reviewer pairs · 6 calls · paid)');
  });

  it('words a script rule as free, notes type-covered files, and warns on a high blast radius', () => {
    const out = renderAspectImpact(aspect({
      affected: Array.from({ length: 10 }, (_, i) => ({ path: `n${i}`, source: 'implied', status: 'advisory' as const, refused: false })),
      cost: { kind: 'deterministic', units: 11, reviewerCalls: 0, fileUnits: 1 },
    }));
    expect(out).toContain('(1 of them from a type-covered file, no owning component)');
    expect(out).toContain('re-verified for free by yg check --approve (script rule, no reviewer calls)');
    expect(out).toContain('High blast radius');
    expect(out).toContain('yg check --approve --only-deterministic  (11 script pairs · free)');
    expect(out).toContain('Flows propagating this aspect: (none)');
  });

  it('says when no component is reached but type-covered files are, and when nothing is', () => {
    const covered = renderAspectImpact(aspect({ affected: [], cost: { kind: 'llm', units: 2, reviewerCalls: 2, fileUnits: 2 } }));
    expect(covered).toContain('(none among components — 2 type-covered files would still be affected; see the cost below)');
    expect(covered).toContain('(2 of them from type-covered files, no owning component)');
    const none = renderAspectImpact(aspect({ affected: [], cost: { kind: 'unknown', units: 0, reviewerCalls: 0, fileUnits: 0 } }));
    expect(none).toContain('Directly affected (0):\n  (none)\n');
    expect(none).toContain('No verified pairs of this aspect exist yet');
    expect(none).toContain('then run yg check --approve to re-verify');
  });
});

describe('renderFlowImpact', () => {
  const flow = (over: Partial<FlowImpact> = {}): FlowImpact => ({
    flowName: 'F', participants: [{ path: 'a', declared: true }, { path: 'a/b', declared: false }], indirectPaths: [], chains: [], flowAspects: ['r'], ...over,
  });
  it('lists declared participants and descendants, and the flow rules', () => {
    const out = renderFlowImpact(flow({ chains: ['a → c'] }));
    expect(out).toContain('  a\n  a/b (descendant)\n');
    expect(out).toContain('Flow aspects: r');
    expect(out).toContain('Blast radius: 2 nodes');
    expect(out).toContain('All 2 participants would become unverified');
    expect(out).toContain('Indirectly affected (structural dependents):\n  a → c\n');
  });
  it('says (none) for an empty flow and warns on a high blast radius', () => {
    expect(renderFlowImpact(flow({ participants: [], flowAspects: [] }))).toContain('Participants:\n  (none)\n');
    const many = renderFlowImpact(flow({ participants: Array.from({ length: 10 }, (_, i) => ({ path: `p${i}`, declared: true })) }));
    expect(many).toContain('High blast radius');
  });
});

describe('a type', () => {
  it('prints the declared type, its when predicate and aspects, and its components', () => {
    const def = { description: 'services', enforce: 'strict', when: { path: 'src/**' }, aspects: ['r'] } as unknown as ArchitectureNodeType;
    const out = renderTypeHeader('svc', def, ['a']);
    expect(out).toBe('\nType: svc\nDescription: services\nenforce: strict\nwhen:\n  path: src/**\naspects: [r]\n\nNodes of this type (1):\n  a\n');
    const bare = renderTypeHeader('mod', { description: 'm' } as unknown as ArchitectureNodeType, []);
    expect(bare).toBe('\nType: mod\nDescription: m\n\nNodes of this type (0):\n');
  });

  it('caps the covered file list at twenty', () => {
    const files = Array.from({ length: 22 }, (_, i) => ({ path: `f${i}.ts`, label: 'in a' }));
    const out = renderTypeCoveredFiles(files);
    expect(out).toContain('Source files covered (22):');
    expect(out).toContain('  ... (2 more)\n');
  });

  it('words what is at stake, with greens only when there are any', () => {
    expect(renderTypeVerdictImpact({ typeCoveredFiles: 1, detPairs: 1, llmPairs: 1, reviewerCalls: 2, greensAtStake: 0 }))
      .toBe('\nFiles enforced by this type: 1\nAt stake: 1 free check, 1 review = 2 reviewer calls\n');
    expect(renderTypeVerdictImpact({ typeCoveredFiles: 2, detPairs: 2, llmPairs: 0, reviewerCalls: 0, greensAtStake: 1 }))
      .toContain('  1 currently-green verdict at stake.');
  });

  it('words a strict coverage gap, capped at ten per list', () => {
    expect(renderStrictCoverageGap('svc', { preview: false, orphans: [], misplaced: [], conflicts: [], unreadable: [] })).toContain('Strict coverage gap (0 files): None');
    const orphans = Array.from({ length: 11 }, (_, i) => `o${i}.ts`);
    const misplaced = Array.from({ length: 11 }, (_, i) => ({ file: `m${i}.ts`, owner: 'x', ownerType: 'other' }));
    const out = renderStrictCoverageGap('svc', { preview: false, orphans, misplaced, conflicts: [], unreadable: [] });
    expect(out).toContain('Orphans (matching files not in any mapping): 11');
    expect(out).toContain('    ... (1 more)\n  Misplaced');
    expect(out).toContain('    m0.ts → x (type: other)');
    expect(out.endsWith('    ... (1 more)\n')).toBe(true);
  });

  it('names the files the type\'s when could not be evaluated on, and never calls such a gap empty', () => {
    const out = renderStrictCoverageGap('svc', { preview: true, orphans: [], misplaced: [], conflicts: [], unreadable: [{ file: 'src/huge.ts', reason: 'too large' }] });
    expect(out).not.toContain('None');
    expect(out).toContain('Unreadable (when could not be evaluated, so belonging is unknown): 1');
    expect(out).toContain('    src/huge.ts (too large)');
  });

  it('ends with the step, naming the covered files only when there are some', () => {
    expect(renderTypeNext(true)).toContain('review the nodes and covered files of this type');
    expect(renderTypeNext(false)).toContain('review the nodes of this type above');
  });
});

describe('a file, a component, a type-covered file', () => {
  const summary = (over: Partial<ImpactSummary> = {}): ImpactSummary => ({
    billedReviewerCalls: 2, freeDeterministic: 1, greensReRolled: 0, byNode: [], unresolved: [], fileLevelPairs: 0, ...over,
  });
  it('lists every component row with its reasons, the totals, the nodeless share and unresolved units', () => {
    const out = renderImpactTotal(summary({
      byNode: [{ nodePath: 'a', llmPairs: 1, reviewerCalls: 2, detPairs: 1, reasons: ['own', 'cold-potential-companion'] }, { nodePath: 'b', llmPairs: 0, reviewerCalls: 0, detPairs: 1, reasons: ['reference'] }],
      fileLevelPairs: 2,
      unresolved: [{ aspectId: 'r', unitKey: 'node:a', nodePath: 'a', why: 'boom' }],
    }), 'src/a.ts');
    expect(out).toContain('Editing src/a.ts invalidates:');
    expect(out).toContain('  a  1 reviewer = 2 reviewer calls, 1 script  (own pairs, companion may observe this file (cold-start; companion not run))');
    expect(out).toContain('  b  1 script  (references this file)');
    expect(out).toContain('(2 of these pairs belong to a type-covered file');
    expect(out).toContain("Unresolved (companion failed");
    expect(out).toContain("  a  aspect 'r'  boom");
  });
  it('words a component\'s re-verification cost', () => {
    expect(renderNodeFillCost({ llmPairs: 1, detPairs: 2, reviewerCalls: 3, greensReRolled: 1 }, 'file'))
      .toBe('  Editing this file re-verifies: 1 reviewer pair = 3 reviewer calls (consensus included); 2 script = free; 1 currently-green verdict re-rolled.\n');
  });
  it('words a graduation preview, and one with nothing to re-check', () => {
    expect(renderGraduationPreview({ file: 'f', currentType: 't', llmPairsReVerified: 0, detPairsReVerified: 0, reviewerCalls: 0 }))
      .toContain('re-checks nothing');
    const out = renderGraduationPreview({ file: 'f', currentType: 't', llmPairsReVerified: 2, detPairsReVerified: 1, reviewerCalls: 4 });
    expect(out).toContain('re-checks 1 check, 2 reviews ≈ 4 reviewer calls');
  });
});
