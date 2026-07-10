import { describe, it, expect } from 'vitest';
import { checkAspectErrsDirection } from '../../../src/core/checks/aspect-contracts.js';
import type { Graph } from '../../../src/model/graph.js';

/**
 * checkAspectErrsDirection — the presence-gated cross-field contract for the
 * `errs` label. errs declares a DETERMINISTIC check's error direction, so it is
 * legal only on deterministic aspects. The validation fires ONLY where the field
 * exists (a malformed placement must never silently never-fire); an absent field
 * is a clean pass.
 */

function mkGraph(aspects: Array<Record<string, unknown>>): Graph {
  return {
    config: {},
    architecture: { node_types: { service: { description: 'svc' } } },
    nodes: new Map(),
    aspects,
    flows: [],
    rootPath: '/tmp/does-not-matter/.yggdrasil',
  } as unknown as Graph;
}

describe('checkAspectErrsDirection', () => {
  it('flags errs on an LLM aspect as aspect-errs-invalid', () => {
    const issues = checkAspectErrsDirection(
      mkGraph([{ id: 'a', name: 'a', reviewer: { type: 'llm' }, artifacts: [], errs: 'over' }]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('aspect-errs-invalid');
    expect(issues[0].severity).toBe('error');
    // WHY explains errs is a deterministic-check concept and this aspect is LLM-reviewed.
    expect(issues[0].messageData!.why).toContain("errs declares a deterministic check's error direction");
    expect(issues[0].messageData!.why).toContain('LLM-reviewed');
    // NEXT points at the fix + the census reference (verbatim).
    expect(issues[0].messageData!.next).toBe(
      'Set errs to one of over|under|exact, or remove the field — see .yggdrasil/aspects/README.md, section "errs census".',
    );
  });

  it('flags errs on an aggregating aspect as aspect-errs-invalid', () => {
    const issues = checkAspectErrsDirection(
      mkGraph([{ id: 'agg', name: 'agg', reviewer: { type: 'aggregate' }, artifacts: [], implies: ['x'], errs: 'exact' }]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('aspect-errs-invalid');
  });

  it('does NOT flag errs on a deterministic aspect (legal placement)', () => {
    const issues = checkAspectErrsDirection(
      mkGraph([{ id: 'd', name: 'd', reviewer: { type: 'deterministic' }, artifacts: [], errs: 'under' }]),
    );
    expect(issues).toHaveLength(0);
  });

  it('absent errs → no issue (presence gate)', () => {
    const issues = checkAspectErrsDirection(
      mkGraph([
        { id: 'd', name: 'd', reviewer: { type: 'deterministic' }, artifacts: [] },
        { id: 'l', name: 'l', reviewer: { type: 'llm' }, artifacts: [] },
      ]),
    );
    expect(issues).toHaveLength(0);
  });
});
