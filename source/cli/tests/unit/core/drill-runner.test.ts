// Drill runner — corpus discovery, classification, exit-code logic, and the
// runDrills orchestration with INJECTED impure ops (runDet / reviewUnit), over a
// real temp corpus. No mocking of the filesystem: cases are staged on disk.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  discoverDrillCases,
  runDrills,
  classifyOutcome,
  summarize,
  caseHashOf,
  type DrillCase,
  type DrillDeps,
  type DrillResult,
  type DrillRunContext,
} from '../../../src/core/drill-runner.js';
import type { AspectDef } from '../../../src/model/graph.js';

const CTX: DrillRunContext = { consensus: 1, maxPromptChars: 50000 };

function detAspect(id = 'demo'): AspectDef {
  return {
    name: id,
    id,
    reviewer: { type: 'deterministic' },
    artifacts: [{ filename: 'check.mjs', content: 'export function check(){return[];}' }],
  } as AspectDef;
}
function llmAspect(id = 'demo', extra: Partial<AspectDef> = {}): AspectDef {
  return {
    name: id,
    id,
    description: 'a rule',
    reviewer: { type: 'llm' },
    artifacts: [{ filename: 'content.md', content: '# Rule\nThe file must be fine.' }],
    ...extra,
  } as AspectDef;
}

/** Stage a project root whose aspect `id` has the given case files under drills/. */
function stageCorpus(id: string, files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-drill-runner-'));
  const drills = path.join(root, '.yggdrasil', 'aspects', id, 'drills');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(drills, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

/** DrillDeps that record the call sequence and drive verdicts from lookup maps. */
function makeDeps(opts: {
  det?: (files: string[]) => 'refused' | 'satisfied' | 'unsupported' | 'unrun';
  review?: (prompt: string) => { satisfied: boolean; votes: { satisfied: number; total: number } } | 'unrun';
} = {}): { deps: DrillDeps; seq: string[]; results: DrillResult[] } {
  const seq: string[] = [];
  const results: DrillResult[] = [];
  const deps: DrillDeps = {
    runDet: async (files) => {
      seq.push('det');
      return opts.det ? opts.det(files) : 'satisfied';
    },
    reviewUnit: async (prompt) => {
      seq.push('review');
      return opts.review ? opts.review(prompt) : { satisfied: true, votes: { satisfied: 1, total: 1 } };
    },
    onBudget: () => seq.push('budget'),
    onCaseResult: (r) => results.push(r),
  };
  return { deps, seq, results };
}

describe('drill-runner — discovery', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('decodes expect from the dir prefix, strips the extension for the label, and sorts', async () => {
    const root = stageCorpus('a', {
      'violates-star/star.ts': 'bad',
      'satisfies-plain/plain.ts': 'good',
    });
    roots.push(root);
    const cases = await discoverDrillCases({ aspectId: 'a', projectRoot: root });
    expect(cases.map((c) => c.caseLabel)).toEqual(['satisfies-plain/plain', 'violates-star/star']);
    const byLabel = Object.fromEntries(cases.map((c) => [c.caseLabel, c]));
    expect(byLabel['violates-star/star'].expect).toBe('refused');
    expect(byLabel['satisfies-plain/plain'].expect).toBe('satisfied');
    expect(byLabel['violates-star/star'].files).toEqual(['.yggdrasil/aspects/a/drills/violates-star/star.ts']);
    expect(cases.every((c) => c.src === 'dev' && c.corpus === 'dev')).toBe(true);
  });

  it('skips .md files, yg-aspect.yaml, and files outside a violates-/satisfies- dir', async () => {
    const root = stageCorpus('b', {
      'violates-x/bad.ts': 'x',
      'violates-x/README.md': 'docs',
      'violates-x/yg-aspect.yaml': 'nope',
      'notes/stray.ts': 'stray',
    });
    roots.push(root);
    const cases = await discoverDrillCases({ aspectId: 'b', projectRoot: root });
    expect(cases.map((c) => c.caseLabel)).toEqual(['violates-x/bad']);
  });

  it('--case glob filters case labels', async () => {
    const root = stageCorpus('c', {
      'violates-one/a.ts': '1',
      'violates-two/b.ts': '2',
      'satisfies-three/c.ts': '3',
    });
    roots.push(root);
    const cases = await discoverDrillCases({ aspectId: 'c', projectRoot: root, caseGlob: 'violates-*/**' });
    expect(cases.map((c) => c.caseLabel).sort()).toEqual(['violates-one/a', 'violates-two/b']);
  });

  it('--dir marks holdout src and derives the corpus label from the basename', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'yg-drill-holdout-'));
    roots.push(root);
    const ext = path.join(root, 'external-cases');
    mkdirSync(path.join(ext, 'violates-z'), { recursive: true });
    writeFileSync(path.join(ext, 'violates-z', 'z.ts'), 'z', 'utf-8');
    const cases = await discoverDrillCases({ aspectId: 'irrelevant', projectRoot: root, dir: 'external-cases' });
    expect(cases).toHaveLength(1);
    expect(cases[0].src).toBe('holdout');
    expect(cases[0].corpus).toBe('external-cases');
    expect(cases[0].caseLabel).toBe('violates-z/z');
  });

  it('missing corpus directory yields no cases', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'yg-drill-empty-'));
    roots.push(root);
    expect(await discoverDrillCases({ aspectId: 'nope', projectRoot: root })).toEqual([]);
  });
});

describe('drill-runner — classification + summary', () => {
  it('classifyOutcome maps the verdict quadrant + no-verdict dispositions', () => {
    expect(classifyOutcome('refused', 'refused')).toBe('pass');
    expect(classifyOutcome('refused', 'satisfied')).toBe('miss');
    expect(classifyOutcome('satisfied', 'satisfied')).toBe('pass');
    expect(classifyOutcome('satisfied', 'refused')).toBe('false-alarm');
    expect(classifyOutcome('refused', 'unrun')).toBe('unrun');
    expect(classifyOutcome('satisfied', 'unsupported')).toBe('unsupported');
  });

  it('exit code: 1 on any miss/false-alarm; else 2 on any unrun; else 0', () => {
    const mk = (outcome: DrillResult['outcome']): DrillResult =>
      ({ case: {} as DrillCase, got: 'satisfied', outcome, kind: 'llm', caseHash: 'h', ruleHash: 'r' });
    expect(summarize([mk('pass'), mk('unsupported')]).exitCode).toBe(0);
    expect(summarize([mk('pass'), mk('unrun')]).exitCode).toBe(2);
    expect(summarize([mk('miss'), mk('unrun')]).exitCode).toBe(1);
    expect(summarize([mk('false-alarm')]).exitCode).toBe(1);
  });
});

describe('drill-runner — runDrills (deterministic path)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function stageTwoCases(): { root: string; cases: Promise<DrillCase[]> } {
    const root = stageCorpus('d', {
      'violates-bad/bad.ts': 'BAD',
      'satisfies-good/good.ts': 'GOOD',
    });
    roots.push(root);
    return { root, cases: discoverDrillCases({ aspectId: 'd', projectRoot: root }) };
  }

  it('a correct check → pass/pass, exit 0, no reviewer calls', async () => {
    const { root, cases } = stageTwoCases();
    const { deps, seq } = makeDeps({
      det: (files) => (files[0].includes('violates-') ? 'refused' : 'satisfied'),
    });
    const summary = await runDrills(detAspect('d'), root, await cases, CTX, deps);
    expect(summary.counts.pass).toBe(2);
    expect(summary.exitCode).toBe(0);
    expect(seq).not.toContain('review'); // deterministic: reviewer never called
    expect(seq).not.toContain('budget');
    expect(summary.results.every((r) => r.kind === 'deterministic')).toBe(true);
  });

  it('a check that UNDER-fires on the violates case → MISS, exit 1', async () => {
    const { root, cases } = stageTwoCases();
    const { deps } = makeDeps({ det: () => 'satisfied' }); // never fires
    const summary = await runDrills(detAspect('d'), root, await cases, CTX, deps);
    expect(summary.counts.miss).toBe(1);
    expect(summary.counts['false-alarm']).toBe(0);
    expect(summary.exitCode).toBe(1);
  });

  it('a check that OVER-fires on the satisfies case → FALSE-ALARM, exit 1', async () => {
    const { root, cases } = stageTwoCases();
    const { deps } = makeDeps({ det: () => 'refused' }); // always fires
    const summary = await runDrills(detAspect('d'), root, await cases, CTX, deps);
    expect(summary.counts['false-alarm']).toBe(1);
    expect(summary.exitCode).toBe(1);
  });

  it('a graph-context check → unsupported (recorded, not scored), exit 0', async () => {
    const { root, cases } = stageTwoCases();
    const { deps } = makeDeps({ det: () => 'unsupported' });
    const summary = await runDrills(detAspect('d'), root, await cases, CTX, deps);
    expect(summary.counts.unsupported).toBe(2);
    expect(summary.counts.pass).toBe(0);
    expect(summary.exitCode).toBe(0);
  });
});

describe('drill-runner — runDrills (LLM path)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('reviewer verdicts → pass/pass; the budget prints BEFORE the first review', async () => {
    const root = stageCorpus('l', {
      'violates-bad/bad.ts': 'BAD',
      'satisfies-good/good.ts': 'GOOD',
    });
    roots.push(root);
    const cases = await discoverDrillCases({ aspectId: 'l', projectRoot: root });
    const { deps, seq, results } = makeDeps({
      // Refuse the violates case, approve the satisfies case (by file content).
      review: (prompt) => (prompt.includes('BAD')
        ? { satisfied: false, votes: { satisfied: 0, total: 1 } }
        : { satisfied: true, votes: { satisfied: 1, total: 1 } }),
    });
    const summary = await runDrills(llmAspect('l'), root, cases, { consensus: 1, tierName: 'standard', maxPromptChars: 50000 }, deps);
    expect(summary.counts.pass).toBe(2);
    expect(summary.exitCode).toBe(0);
    // Budget MUST precede the first reviewer call.
    expect(seq[0]).toBe('budget');
    expect(seq.indexOf('budget')).toBeLessThan(seq.indexOf('review'));
    // LLM results carry the tier + votes.
    expect(results.every((r) => r.kind === 'llm' && r.tier === 'standard' && r.votes?.total === 1)).toBe(true);
  });

  it('an over-limit prompt → unrun (exit 2), and the reviewer is NEVER called for it', async () => {
    const root = stageCorpus('big', { 'violates-huge/huge.ts': 'x'.repeat(200) });
    roots.push(root);
    const cases = await discoverDrillCases({ aspectId: 'big', projectRoot: root });
    const { deps, seq } = makeDeps();
    const summary = await runDrills(llmAspect('big'), root, cases, { consensus: 1, tierName: 'standard', maxPromptChars: 10 }, deps);
    expect(summary.counts.unrun).toBe(1);
    expect(summary.exitCode).toBe(2);
    expect(seq).not.toContain('review');
  });

  it('a companion aspect → every case unsupported, reviewer never called', async () => {
    const root = stageCorpus('comp', {
      'violates-a/a.ts': 'a',
      'satisfies-b/b.ts': 'b',
    });
    roots.push(root);
    const cases = await discoverDrillCases({ aspectId: 'comp', projectRoot: root });
    const { deps, seq } = makeDeps();
    const summary = await runDrills(llmAspect('comp', { hasCompanion: true }), root, cases, { consensus: 1, tierName: 'standard', maxPromptChars: 50000 }, deps);
    expect(summary.counts.unsupported).toBe(2);
    expect(summary.exitCode).toBe(0);
    expect(seq).not.toContain('review');
    expect(seq).not.toContain('budget');
  });

  it('a provider infra failure on the unit → unrun, exit 2', async () => {
    const root = stageCorpus('infra', { 'satisfies-ok/ok.ts': 'ok' });
    roots.push(root);
    const cases = await discoverDrillCases({ aspectId: 'infra', projectRoot: root });
    const { deps } = makeDeps({ review: () => 'unrun' });
    const summary = await runDrills(llmAspect('infra'), root, cases, { consensus: 1, tierName: 'standard', maxPromptChars: 50000 }, deps);
    expect(summary.counts.unrun).toBe(1);
    expect(summary.exitCode).toBe(2);
  });
});

describe('drill-runner — caseHashOf', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('hashes case file content, stable across runs and sensitive to edits', async () => {
    const root = stageCorpus('h', { 'violates-a/a.ts': 'ORIGINAL' });
    roots.push(root);
    const rel = '.yggdrasil/aspects/h/drills/violates-a/a.ts';
    const h1 = await caseHashOf([rel], root);
    const h2 = await caseHashOf([rel], root);
    expect(h1).toBe(h2);
    writeFileSync(path.join(root, rel), 'CHANGED', 'utf-8');
    expect(await caseHashOf([rel], root)).not.toBe(h1);
  });
});
