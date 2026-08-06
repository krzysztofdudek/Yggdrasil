/**
 * Companion-resolution tests for the `yg check --approve` fill stage (core/fill.ts).
 * Split from fill-llm.test.ts to keep each file under the reviewer's 50 000-char
 * prompt limit (the `test-deterministic` aspect is per:file).
 *
 * Covers Task 5 companion resolution in the LLM fill path:
 *   taint guard, normalize/dedupe/sort, subject-dedupe, fail-closed infra branches,
 *   []-companion, companionHash/touched folding, and the companion happy-path.
 *
 * HERMETIC: createLlmProvider is mocked — no network, no real reviewer. Each
 * project is a fresh mkdtemp tree; the lock is written to / read from disk by the
 * fill stage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  mkdtemp, mkdir, writeFile, rm, readFile,
} from 'node:fs/promises';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
import type { IssueMessage } from '../../../src/model/validation.js';
import { readLock } from '../../../src/io/lock-store.js';
import type { LlmProvider } from '../../../src/llm/types.js';
import type { RunCompanionHookResult } from '../../../src/structure/hook-loader.js';
import { computeLlmInputHash } from '../../../src/core/pair-hash.js';
import { observationKey, hashReadObservation } from '../../../src/core/pair-hash.js';
import { companionHashFor, ruleHashFor, tierHashViewFromTier } from '../../../src/core/pair-inputs.js';
import { hashBytes } from '../../../src/io/hash.js';

// ── Mock the LLM provider factory (no real reviewer) ──────────────────────────
vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));
import { createLlmProvider } from '../../../src/llm/index.js';
const mockCreateLlmProvider = vi.mocked(createLlmProvider);

// ── Mock the structure runner (pass-through by default) ────────────────────────
// eslint-disable-next-line no-var
var structureRunnerRealFn: (typeof import('../../../src/structure/runner.js'))['runStructureAspect'] | undefined;
vi.mock('../../../src/structure/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/structure/runner.js')>();
  structureRunnerRealFn = actual.runStructureAspect;
  return {
    ...actual,
    runStructureAspect: vi.fn(actual.runStructureAspect),
  };
});
import { runStructureAspect } from '../../../src/structure/runner.js';
const mockRunStructureAspect = vi.mocked(runStructureAspect);

// ── Mock the companion hook runner separately from the reviewer provider ───────
// eslint-disable-next-line no-var
var companionRealFn: (typeof import('../../../src/structure/hook-loader.js'))['runCompanionHook'] | undefined;
vi.mock('../../../src/structure/hook-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/structure/hook-loader.js')>();
  companionRealFn = actual.runCompanionHook;
  return {
    ...actual,
    runCompanionHook: vi.fn(actual.runCompanionHook),
  };
});
import { runCompanionHook } from '../../../src/structure/hook-loader.js';
const mockRunCompanionHook = vi.mocked(runCompanionHook);

// ── Mock tier resolution (pass-through by default) ────────────────────────────
// eslint-disable-next-line no-var
var tierSelectRealFn: (typeof import('../../../src/core/tier-selection.js'))['selectTierForAspect'] | undefined;
vi.mock('../../../src/core/tier-selection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/tier-selection.js')>();
  tierSelectRealFn = actual.selectTierForAspect;
  return {
    ...actual,
    selectTierForAspect: vi.fn(actual.selectTierForAspect),
  };
});
import { selectTierForAspect } from '../../../src/core/tier-selection.js';
const mockSelectTierForAspect = vi.mocked(selectTierForAspect);

function makeMockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    ...overrides,
  };
}

const V5_REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
beforeEach(() => {
  vi.resetAllMocks();
  if (structureRunnerRealFn) {
    const real = structureRunnerRealFn;
    mockRunStructureAspect.mockImplementation(
      (...args: Parameters<typeof runStructureAspect>) => real(...args),
    );
  }
  if (tierSelectRealFn) {
    const real = tierSelectRealFn;
    mockSelectTierForAspect.mockImplementation(
      (...args: Parameters<typeof selectTierForAspect>) => real(...args),
    );
  }
  if (companionRealFn) {
    const real = companionRealFn;
    mockRunCompanionHook.mockImplementation(
      (...args: Parameters<typeof runCompanionHook>) => real(...args),
    );
  }
});

// ── Project builder ───────────────────────────────────────────────────────────

interface AspectSpec {
  id: string;
  kind: 'llm' | 'deterministic';
  status?: 'draft' | 'advisory' | 'enforced';
  rule: string;
  scopePer?: 'node' | 'file';
  references?: Array<{ path: string; description?: string }>;
  companion?: string;
}

interface ProjectSpec {
  aspects: AspectSpec[];
  files?: Record<string, string>;
  mapping?: string[];
  configYaml?: string;
  logContent?: string;
  logRequired?: boolean;
  extraFiles?: Record<string, string>;
}

async function setupProject(spec: ProjectSpec): Promise<{ projectRoot: string; yggRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), spec.configYaml ?? V5_REVIEWER_CONFIG);
  await writeFile(
    path.join(yggRoot, 'yg-architecture.yaml'),
    `node_types:\n  service:\n    description: s\n    log_required: ${spec.logRequired ?? false}\n`,
  );
  const mapping = spec.mapping ?? ['src/svc.ts'];
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    `name: svc\ntype: service\ndescription: x\nmapping:\n${mapping.map((m) => `  - ${m}`).join('\n')}\naspects:\n${spec.aspects.map((a) => `  - ${a.id}`).join('\n')}\n`,
  );
  await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  for (const [rel, content] of Object.entries(spec.extraFiles ?? {})) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  if (spec.logContent !== undefined) await writeFile(path.join(nodeDir, 'log.md'), spec.logContent);
  for (const asp of spec.aspects) {
    const aspDir = path.join(yggRoot, 'aspects', asp.id);
    await mkdir(aspDir, { recursive: true });
    const refLines = (asp.references ?? [])
      .map((r) => `  - path: ${r.path}${r.description ? `\n    description: ${r.description}` : ''}`)
      .join('\n');
    const yaml =
      `name: ${asp.id}\ndescription: ${asp.id} rule\nreviewer:\n  type: ${asp.kind}\n` +
      `${asp.status ? `status: ${asp.status}\n` : ''}` +
      `${asp.scopePer ? `scope:\n  per: ${asp.scopePer}\n` : ''}` +
      `${asp.references ? `references:\n${refLines}\n` : ''}`;
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), yaml);
    await writeFile(path.join(aspDir, asp.kind === 'llm' ? 'content.md' : 'check.mjs'), asp.rule);
    if (asp.companion !== undefined) await writeFile(path.join(aspDir, 'companion.mjs'), asp.companion);
  }
  return { projectRoot: root, yggRoot };
}

/** Capture fill output as a string so exact strings can be asserted. */
function makeWriter(): { write: (s: string) => void; emitIssue: (m: IssueMessage) => void; text: () => string } {
  let buf = '';
  const write = (s: string) => { buf += s; };
  return { write, emitIssue: (m) => { write(buildIssueMessage(m) + '\n'); }, text: () => buf };
}

// =============================================================================
// Task 5: companion resolution in the LLM fill path
//
// fill-llm.ts resolves an aspect's companion.mjs BEFORE the reviewer runs (so a
// torn observation set never costs a reviewer call), normalizes + dedupes +
// subject-drops the returned paths, validates each against allowed-reads, reads
// its bytes into the prompt, folds the companion-read observations into `touched`,
// and folds companionHash UNCONDITIONALLY. Every companion failure path is
// fail-closed: NOTHING written, callsMade: 0.
//
// The companion hook runner is mocked as its OWN spy (mockRunCompanionHook), so
// the hook-run count and the reviewer-call count are asserted independently.
// =============================================================================

describe('Task 5 — companion resolution in the LLM fill path', () => {
  it('happy path: resolved companion appears in touched and the hash folds touched + companionHash', async () => {
    // companion.mjs returns one path (src/partner.ts), a RELATION-REACHABLE file
    // owned by a node svc declares a `uses` relation to — so it is in svc's
    // allowed-reads but is NOT a subject of svc's aspect. (A mapped own-file would
    // be a subject for a per:node LLM aspect and get subject-dropped instead.)
    const COMPANION_CONTENT = 'export const partner = 7;\n';
    const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), V5_REVIEWER_CONFIG);
    await writeFile(
      path.join(yggRoot, 'yg-architecture.yaml'),
      'node_types:\n  service:\n    description: s\n    log_required: false\n    relations:\n      uses: [service]\n',
    );
    await mkdir(path.join(yggRoot, 'model', 'svc'), { recursive: true });
    await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'),
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\nrelations:\n  - type: uses\n    target: partner\naspects:\n  - llm-c\n',
    );
    await mkdir(path.join(yggRoot, 'model', 'partner'), { recursive: true });
    await writeFile(path.join(root, 'src', 'partner.ts'), COMPANION_CONTENT);
    await writeFile(
      path.join(yggRoot, 'model', 'partner', 'yg-node.yaml'),
      'name: partner\ntype: service\ndescription: p\nmapping:\n  - src/partner.ts\n',
    );
    const aspDir = path.join(yggRoot, 'aspects', 'llm-c');
    await mkdir(aspDir, { recursive: true });
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), 'name: llm-c\ndescription: llm-c rule\nreviewer:\n  type: llm\nstatus: enforced\n');
    await writeFile(path.join(aspDir, 'content.md'), 'rule c\n');
    await writeFile(path.join(aspDir, 'companion.mjs'), 'export function companion() { return [{ path: "src/partner.ts" }]; }\n');

    const graph = await loadGraph(root);

    let reviewerCalls = 0;
    let promptSeen = '';
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect(prompt: string) {
        reviewerCalls++;
        promptSeen = prompt;
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      },
    }));

    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // Reviewer ran exactly once (consensus 1). The companion hook now runs MORE than
    // once: since v5.2.0 the §4 prompt-size gate is unconditional (an omitted
    // max_prompt_chars defaults to 50000), so verify-lock resolves the companion LIVE
    // on every pass to size the gate — in addition to fill's own resolution. The hook
    // is a pure resolver (never a judge), so extra invocations are harmless; we assert
    // it ran (≥1) rather than pinning a brittle pass-count.
    expect(reviewerCalls).toBe(1);
    expect(mockRunCompanionHook).toHaveBeenCalled();
    expect(result.reviewerCallsMade).toBe(1);

    // The companion content reached the reviewer prompt.
    expect(promptSeen).toContain('<companions>');
    expect(promptSeen).toContain(COMPANION_CONTENT.trim());

    const entry = readLock(graph.rootPath).verdicts['llm-c']?.['node:svc'];
    expect(entry?.verdict).toBe('approved');
    // touched carries the companion-read observation.
    expect(entry?.touched?.map(([k]) => k)).toContain('read:src/partner.ts');

    // The stored hash equals computeLlmInputHash with companionHash AND touched
    // folded — proving the producer threaded both into the hash.
    const aspect = graph.aspects.find((a) => a.id === 'llm-c')!;
    const svcBytes = await readFile(path.join(root, 'src', 'svc.ts'));
    const compBytes = await readFile(path.join(root, 'src', 'partner.ts'));
    const expectedHash = computeLlmInputHash({
      aspectId: 'llm-c',
      aspectDescription: aspect.description ?? '',
      scope: aspect.scope,
      nodePath: 'svc',
      ruleHash: ruleHashFor(aspect, 'content.md'),
      files: [['src/svc.ts', hashBytes(svcBytes)]],
      references: [],
      tier: tierHashViewFromTier('standard'),
      companionHash: companionHashFor(aspect),
      touched: [[observationKey('read', 'src/partner.ts'), hashReadObservation(compBytes)]],
      verdict: 'approved',
    });
    expect(entry?.hash).toBe(expectedHash);
    // companionHash actually exists (sanity: the aspect ships a companion).
    expect(companionHashFor(aspect)).toBeDefined();
  });

  it('[] companion → no touched, but companionHash still folds', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-empty',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        companion: 'export function companion() { return []; }\n',
      }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    const entry = readLock(graph.rootPath).verdicts['llm-empty']?.['node:svc'];
    expect(entry?.verdict).toBe('approved');
    // A []-resolving companion records NO touched.
    expect(entry?.touched).toBeUndefined();

    // But companionHash STILL folds (presence is by artifact existence).
    const aspect = graph.aspects.find((a) => a.id === 'llm-empty')!;
    const svcBytes = await readFile(path.join(projectRoot, 'src', 'svc.ts'));
    const withCompanion = computeLlmInputHash({
      aspectId: 'llm-empty',
      aspectDescription: aspect.description ?? '',
      scope: aspect.scope,
      nodePath: 'svc',
      ruleHash: ruleHashFor(aspect, 'content.md'),
      files: [['src/svc.ts', hashBytes(svcBytes)]],
      references: [],
      tier: tierHashViewFromTier('standard'),
      companionHash: companionHashFor(aspect),
      verdict: 'approved',
    });
    const withoutCompanion = computeLlmInputHash({
      aspectId: 'llm-empty',
      aspectDescription: aspect.description ?? '',
      scope: aspect.scope,
      nodePath: 'svc',
      ruleHash: ruleHashFor(aspect, 'content.md'),
      files: [['src/svc.ts', hashBytes(svcBytes)]],
      references: [],
      tier: tierHashViewFromTier('standard'),
      verdict: 'approved',
    });
    // The stored hash matches the companion-folded form, NOT the plain form.
    expect(entry?.hash).toBe(withCompanion);
    expect(entry?.hash).not.toBe(withoutCompanion);
  });

  it('tainted on BOTH runs → 2 hook runs, 0 reviewer calls, companion-runtime-error (callsMade:0), no write', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-taint',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        companion: 'export function companion() { return []; }\n',
      }],
    });
    const graph = await loadGraph(projectRoot);

    // The companion hook ALWAYS returns a tainted observation set.
    const tainted: RunCompanionHookResult = {
      kind: 'ok',
      descriptors: [],
      touchedFiles: [],
      observations: [],
      observationsTainted: true,
    };
    mockRunCompanionHook.mockResolvedValue(tainted);

    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { reviewerCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // Since v5.2.0 the §4 gate is unconditional (omitted max_prompt_chars → 50000),
    // so verify-lock resolves the companion LIVE to size the gate — running the A6
    // taint guard (run once → retry once → torn). A torn set yields a companion-error
    // at the gate, the pair is no longer `unverified`, and fill SKIPS it. The hook
    // therefore runs ≥2 times (the gate's taint guard alone runs it twice); the
    // reviewer never runs and nothing is written. The fail-closed contract is intact;
    // only the surfacing site moved from the fill stage to the verify-lock gate.
    expect(mockRunCompanionHook.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(reviewerCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    expect(result.infraFailures).toBe(0);
    expect(readLock(graph.rootPath).verdicts['llm-taint']?.['node:svc']).toBeUndefined();
    // The torn companion surfaces as a blocking companion-resolution diagnostic in the
    // check report (the verify-lock gate's companion-error → aspect-companion-runtime-error).
    expect(result.checkResult.issues.some((i) => i.code === 'aspect-companion-runtime-error')).toBe(true);
  });

  it('tainted once then settles → verdict IS written (one re-run)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-settle',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        companion: 'export function companion() { return []; }\n',
      }],
    });
    const graph = await loadGraph(projectRoot);

    // First resolution taints, every subsequent resolution settles. Since v5.2.0 the
    // §4 gate is unconditional, so verify-lock resolves the companion LIVE before fill;
    // the A6 taint guard (run once → retry once) absorbs the single transient taint and
    // settles. A one-shot `.mockResolvedValueOnce(settled)` would run dry once the gate
    // consumed the slot, so we use a durable fallback that converges on the settled set.
    const taintedOnce: RunCompanionHookResult = { kind: 'ok', descriptors: [], touchedFiles: [], observations: [], observationsTainted: true };
    const settled: RunCompanionHookResult = { kind: 'ok', descriptors: [], touchedFiles: [], observations: [], observationsTainted: false };
    mockRunCompanionHook
      .mockResolvedValueOnce(taintedOnce)
      .mockResolvedValue(settled);

    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { reviewerCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // The transient taint settled, so the reviewer ran once and the verdict was written.
    expect(reviewerCalls).toBe(1);
    expect(result.reviewerCallsMade).toBe(1);
    expect(readLock(graph.rootPath).verdicts['llm-settle']?.['node:svc']?.verdict).toBe('approved');
  });

  it('hook throws (infra) → 0 reviewer calls, infra (callsMade:0), no write, message reaches the sink', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-throw',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        companion: 'export function companion() { throw new Error("boom"); }\n',
      }],
    });
    const graph = await loadGraph(projectRoot);

    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { reviewerCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    expect(reviewerCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    expect(result.infraFailures).toBe(0);
    expect(readLock(graph.rootPath).verdicts['llm-throw']?.['node:svc']).toBeUndefined();
    // Since v5.2.0 the §4 gate is unconditional (omitted max_prompt_chars → 50000), so
    // verify-lock resolves the companion LIVE to size the gate; a throwing hook fails
    // there as a companion-error, the pair is no longer `unverified`, and fill SKIPS it.
    // The throw therefore surfaces as a blocking aspect-companion-runtime-error in the
    // check report rather than via the fill-stage counter. Fail-closed contract intact.
    const ce = result.checkResult.issues.find((i) => i.code === 'aspect-companion-runtime-error');
    expect(ce).toBeDefined();
    // The companion message (carrying the hook throw) reaches the agent via the check report.
    const ceText = `${ce!.messageData.what}\n${ce!.messageData.why}\n${ce!.messageData.next}`;
    expect(ceText).toMatch(/companion/i);
  });

  it('companion path missing on disk → infra (callsMade:0), no write', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-missing',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        // Returns an allowed-reads path (own mapping) that does NOT exist on disk.
        companion: 'export function companion() { return [{ path: "src/ghost.ts" }]; }\n',
      }],
      mapping: ['src/svc.ts', 'src/ghost.ts'],
      // src/ghost.ts is intentionally NOT created (mapping references a missing file).
    });
    const graph = await loadGraph(projectRoot);

    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { reviewerCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    expect(reviewerCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    expect(result.infraFailures).toBe(0);
    expect(readLock(graph.rootPath).verdicts['llm-missing']?.['node:svc']).toBeUndefined();
    // Since v5.2.0 the unconditional §4 gate resolves the companion LIVE; a path that
    // is allowed but missing on disk fails there → companion-error, the pair is skipped
    // by fill, and the failure surfaces as a blocking aspect-companion-runtime-error in
    // the check report (not via the fill-stage counter). Fail-closed contract intact.
    expect(result.checkResult.issues.some((i) => i.code === 'aspect-companion-runtime-error')).toBe(true);
  });

  it('companion path outside allowed-reads → infra (callsMade:0), NEXT names node as relation source', async () => {
    // The companion returns a path owned by an UNRELATED node (no relation declared
    // from svc to it) — outside svc's allowed-reads. fill-llm must fail closed and
    // the NEXT must frame svc as the relation SOURCE and the owner as the TARGET.
    const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), V5_REVIEWER_CONFIG);
    await writeFile(
      path.join(yggRoot, 'yg-architecture.yaml'),
      'node_types:\n  service:\n    description: s\n    log_required: false\n',
    );
    // svc node — carries the companion aspect, maps only src/svc.ts.
    await mkdir(path.join(yggRoot, 'model', 'svc'), { recursive: true });
    await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'),
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - llm-out\n',
    );
    // other node — owns src/other.ts; svc declares NO relation to it.
    await mkdir(path.join(yggRoot, 'model', 'other'), { recursive: true });
    await writeFile(path.join(root, 'src', 'other.ts'), 'export const o = 9;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'other', 'yg-node.yaml'),
      'name: other\ntype: service\ndescription: y\nmapping:\n  - src/other.ts\n',
    );
    // Aspect llm-out — companion returns src/other.ts (outside svc allowed-reads).
    const aspDir = path.join(yggRoot, 'aspects', 'llm-out');
    await mkdir(aspDir, { recursive: true });
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), 'name: llm-out\ndescription: out rule\nreviewer:\n  type: llm\nstatus: enforced\n');
    await writeFile(path.join(aspDir, 'content.md'), 'rule\n');
    await writeFile(path.join(aspDir, 'companion.mjs'), 'export function companion() { return [{ path: "src/other.ts" }]; }\n');

    const graph = await loadGraph(root);
    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { reviewerCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    expect(reviewerCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    expect(result.infraFailures).toBe(0);
    expect(readLock(graph.rootPath).verdicts['llm-out']?.['node:svc']).toBeUndefined();
    // Since v5.2.0 the unconditional §4 gate resolves the companion LIVE; an out-of-reach
    // path fails there → companion-error, fill skips the pair, and the failure surfaces in
    // the check report (not the fill-stage write stream). The diagnostic's NEXT still frames
    // svc as the relation SOURCE and other (the owner) as TARGET — and never interpolates the
    // .md/unit as the relation site. Assert it on the check-report issue's messageData.
    const ce = result.checkResult.issues.find((i) => i.code === 'aspect-companion-runtime-error');
    expect(ce).toBeDefined();
    const ceText = `${ce!.messageData.what}\n${ce!.messageData.why}\n${ce!.messageData.next}`;
    expect(ceText).toContain('declare a relation from svc to other');
    expect(ceText).toContain('.yggdrasil/model/svc/yg-node.yaml');
  });

  it('bad shape (non-array return) → companion-runtime-error (callsMade:0), no write', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-badshape',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        companion: 'export function companion() { return "oops"; }\n',
      }],
    });
    const graph = await loadGraph(projectRoot);
    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { reviewerCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    expect(reviewerCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    expect(result.infraFailures).toBe(0);
    expect(readLock(graph.rootPath).verdicts['llm-badshape']?.['node:svc']).toBeUndefined();
    // Since v5.2.0 the unconditional §4 gate resolves the companion LIVE; a bad-shape
    // (non-array) return fails there → companion-error, fill skips the pair, and the
    // failure surfaces as a blocking aspect-companion-runtime-error in the check report.
    expect(result.checkResult.issues.some((i) => i.code === 'aspect-companion-runtime-error')).toBe(true);
  });

  it('a companion path equal to a subject is dropped (no inject, no touched)', async () => {
    // per:node aspect; companion returns the subject file itself. It must be
    // dropped (already a subject) — NOT injected as a companion, NOT recorded.
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-self',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        companion: 'export function companion() { return [{ path: "src/svc.ts" }]; }\n',
      }],
    });
    const graph = await loadGraph(projectRoot);
    let promptSeen = '';
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect(prompt: string) { promptSeen = prompt; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    const entry = readLock(graph.rootPath).verdicts['llm-self']?.['node:svc'];
    expect(entry?.verdict).toBe('approved');
    // The subject was dropped → no companion block, no touched entry for it.
    expect(promptSeen).not.toContain('<companions>');
    expect(entry?.touched).toBeUndefined();
    // The hash still folds companionHash (the aspect ships a companion).
    const aspect = graph.aspects.find((a) => a.id === 'llm-self')!;
    const svcBytes = await readFile(path.join(projectRoot, 'src', 'svc.ts'));
    const expectedHash = computeLlmInputHash({
      aspectId: 'llm-self',
      aspectDescription: aspect.description ?? '',
      scope: aspect.scope,
      nodePath: 'svc',
      ruleHash: ruleHashFor(aspect, 'content.md'),
      files: [['src/svc.ts', hashBytes(svcBytes)]],
      references: [],
      tier: tierHashViewFromTier('standard'),
      companionHash: companionHashFor(aspect),
      verdict: 'approved',
    });
    expect(entry?.hash).toBe(expectedHash);
  });

  it('companion prompt over max_prompt_chars on FIRST fill → verify-lock gate (prompt-too-large), reviewer never called, no write', async () => {
    // Build a project whose companion content makes the assembled prompt exceed a
    // deliberately tiny max_prompt_chars limit. verify-lock now resolves the
    // companion LIVE — even on a first fill with no stored entry — so it classifies
    // the pair as `prompt-too-large` directly; fill SKIPS prompt-too-large pairs
    // (gate precedence), so the reviewer is never called and nothing is written.
    // (The fill-time gate in fill-llm.ts remains as defense-in-depth; it no longer
    // needs to fire here because verify-lock catches the over-limit prompt first.)
    const LARGE_COMPANION_CONTENT = 'x'.repeat(10_000); // large enough to exceed 500-char limit
    const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-sizelimit-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    // Set a limit that is above the base prompt (~1.2k chars without companions)
    // but below the companion-augmented prompt (~11k chars with the large file).
    // verify-lock resolves the companion live and measures the augmented prompt, so
    // it classifies the pair prompt-too-large on the first fill — before the
    // reviewer ever runs.
    const cfgWithLimit =
      'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      max_prompt_chars: 2000\n      config:\n        model: llama3\n        temperature: 0\n';
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), cfgWithLimit);
    await writeFile(
      path.join(yggRoot, 'yg-architecture.yaml'),
      'node_types:\n  service:\n    description: s\n    log_required: false\n    relations:\n      uses: [service]\n',
    );
    await mkdir(path.join(yggRoot, 'model', 'svc'), { recursive: true });
    await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'),
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\nrelations:\n  - type: uses\n    target: companion-node\naspects:\n  - llm-toolarge\n',
    );
    await mkdir(path.join(yggRoot, 'model', 'companion-node'), { recursive: true });
    await writeFile(path.join(root, 'src', 'big-companion.ts'), LARGE_COMPANION_CONTENT);
    await writeFile(
      path.join(yggRoot, 'model', 'companion-node', 'yg-node.yaml'),
      'name: companion-node\ntype: service\ndescription: c\nmapping:\n  - src/big-companion.ts\n',
    );
    const aspDir = path.join(yggRoot, 'aspects', 'llm-toolarge');
    await mkdir(aspDir, { recursive: true });
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), 'name: llm-toolarge\ndescription: llm-toolarge rule\nreviewer:\n  type: llm\nstatus: enforced\n');
    await writeFile(path.join(aspDir, 'content.md'), 'rule\n');
    // Companion hook returns the large file.
    await writeFile(
      path.join(aspDir, 'companion.mjs'),
      'export function companion() { return [{ path: "src/big-companion.ts" }]; }\n',
    );

    const graph = await loadGraph(root);

    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        reviewerCalls++;
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      },
    }));

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    // ZERO reviewer calls — the gate intercepted before the reviewer ran.
    expect(reviewerCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    // No infra failure: the pair is a gate SKIP (prompt-too-large), not an infra
    // disposition — fill never ran it, so it bills nothing and writes nothing.
    expect(result.infraFailures).toBe(0);
    // No lock entry for the pair.
    expect(readLock(graph.rootPath).verdicts['llm-toolarge']?.['node:svc']).toBeUndefined();
    // The verify-lock gate reported the pair as prompt-too-large, naming the aspect
    // and the tier limit (caught from the live-measured companion prompt). The
    // message is on the trailing check report, not the fill-stage emission stream.
    const ptl = result.checkResult.issues.find((i) => i.code === 'prompt-too-large');
    expect(ptl).toBeDefined();
    expect(ptl!.messageData.what).toContain('llm-toolarge');
    expect(ptl!.messageData.what).toContain('2000');
  });

  it('companion prompt over the DEFAULT (omitted max_prompt_chars) on FIRST fill → prompt-too-large at 50000, reviewer never called, no write', async () => {
    // Mirror of the explicit-limit case above, but the tier OMITS max_prompt_chars.
    // Before v5.2.0 an omitted key meant "no gate" — an oversized companion prompt
    // would slip through, the reviewer would be billed, and a verdict written. Now
    // an omitted key defaults to DEFAULT_MAX_PROMPT_CHARS (50000), so verify-lock
    // resolves the companion live, measures the augmented prompt, classifies the pair
    // prompt-too-large at limit 50000, fill SKIPS it — reviewer never called, no write.
    const LARGE_COMPANION_CONTENT = 'x'.repeat(60_000); // exceeds the 50000 default
    const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-defaultlimit-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    // Tier omits max_prompt_chars entirely — the 50000 default must apply.
    const cfgNoLimit =
      'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n';
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), cfgNoLimit);
    await writeFile(
      path.join(yggRoot, 'yg-architecture.yaml'),
      'node_types:\n  service:\n    description: s\n    log_required: false\n    relations:\n      uses: [service]\n',
    );
    await mkdir(path.join(yggRoot, 'model', 'svc'), { recursive: true });
    await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'),
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\nrelations:\n  - type: uses\n    target: companion-node\naspects:\n  - llm-toolarge\n',
    );
    await mkdir(path.join(yggRoot, 'model', 'companion-node'), { recursive: true });
    await writeFile(path.join(root, 'src', 'big-companion.ts'), LARGE_COMPANION_CONTENT);
    await writeFile(
      path.join(yggRoot, 'model', 'companion-node', 'yg-node.yaml'),
      'name: companion-node\ntype: service\ndescription: c\nmapping:\n  - src/big-companion.ts\n',
    );
    const aspDir = path.join(yggRoot, 'aspects', 'llm-toolarge');
    await mkdir(aspDir, { recursive: true });
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), 'name: llm-toolarge\ndescription: llm-toolarge rule\nreviewer:\n  type: llm\nstatus: enforced\n');
    await writeFile(path.join(aspDir, 'content.md'), 'rule\n');
    await writeFile(
      path.join(aspDir, 'companion.mjs'),
      'export function companion() { return [{ path: "src/big-companion.ts" }]; }\n',
    );

    const graph = await loadGraph(root);

    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        reviewerCalls++;
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      },
    }));

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    // ZERO reviewer calls — the default gate intercepted before the reviewer ran.
    expect(reviewerCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    // No infra failure: the pair is a gate SKIP (prompt-too-large), not an infra disposition.
    expect(result.infraFailures).toBe(0);
    // Nothing written for the pair.
    expect(readLock(graph.rootPath).verdicts['llm-toolarge']?.['node:svc']).toBeUndefined();
    // The gate reported prompt-too-large at the DEFAULT limit of 50000.
    const ptl = result.checkResult.issues.find((i) => i.code === 'prompt-too-large');
    expect(ptl).toBeDefined();
    expect(ptl!.messageData.what).toContain('llm-toolarge');
    expect(ptl!.messageData.what).toContain('50000');
  });

  // Shared scaffold: a per:node LLM aspect whose companion.mjs THROWS, with a tier
  // limit set so verify-lock runs the resolver live to size the gate. The hook throws
  // → the pair is classified companion-error (a clear diagnostic), the reviewer is
  // never called, and nothing is written. `status` flips enforced/advisory rendering.
  async function buildThrowingCompanionProject(status: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-companion-throw-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    await mkdir(path.join(yggRoot, 'model', 'svc'), { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(
      path.join(yggRoot, 'yg-config.yaml'),
      'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      max_prompt_chars: 2000\n      config:\n        model: llama3\n        temperature: 0\n',
    );
    await writeFile(
      path.join(yggRoot, 'yg-architecture.yaml'),
      'node_types:\n  service:\n    description: s\n    log_required: false\n    relations:\n      uses: [service]\n',
    );
    await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'),
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - llm-throw\n',
    );
    const aspDir = path.join(yggRoot, 'aspects', 'llm-throw');
    await mkdir(aspDir, { recursive: true });
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), `name: llm-throw\ndescription: llm-throw rule\nreviewer:\n  type: llm\nstatus: ${status}\n`);
    await writeFile(path.join(aspDir, 'content.md'), 'rule\n');
    await writeFile(path.join(aspDir, 'companion.mjs'), 'export function companion() { throw new Error("companion boom"); }\n');
    return root;
  }

  it('an enforced companion that throws during the verify-lock size gate → blocking companion-error, reviewer never called, nothing written', async () => {
    const root = await buildThrowingCompanionProject('enforced');
    const graph = await loadGraph(root);
    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(
      makeMockProvider({
        async verifyAspect() {
          reviewerCalls++;
          return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
        },
      }),
    );

    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // Reviewer never called — the companion failed to resolve at the gate (gate precedence).
    expect(reviewerCalls).toBe(0);
    // The check report carries a clear, blocking companion-resolution diagnostic.
    const ce = result.checkResult.issues.find((i) => i.code === 'aspect-companion-runtime-error');
    expect(ce).toBeDefined();
    expect(ce!.severity).toBe('error');
    expect(ce!.messageData.what).toContain('llm-throw');
    expect(JSON.stringify(ce!.messageData)).toContain('boom');
    // Nothing written for the pair.
    expect(readLock(graph.rootPath).verdicts['llm-throw']?.['node:svc']).toBeUndefined();
  });

  it('an advisory companion that throws during the size gate → companion-error renders as a non-blocking warning', async () => {
    const root = await buildThrowingCompanionProject('advisory');
    const graph = await loadGraph(root);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());

    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    const ce = result.checkResult.issues.find((i) => i.code === 'aspect-companion-runtime-error');
    expect(ce).toBeDefined();
    expect(ce!.severity).toBe('warning');
  });

  it('plain LLM aspect (no companion) — hook is never run and the hash is companion-free', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-plain', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // The companion hook was NEVER invoked for a plain aspect (byte-identical path).
    expect(mockRunCompanionHook).not.toHaveBeenCalled();

    const entry = readLock(graph.rootPath).verdicts['llm-plain']?.['node:svc'];
    expect(entry?.verdict).toBe('approved');
    expect(entry?.touched).toBeUndefined();
    // The stored hash is the plain (companion-free) form.
    const aspect = graph.aspects.find((a) => a.id === 'llm-plain')!;
    const svcBytes = await readFile(path.join(projectRoot, 'src', 'svc.ts'));
    const plainHash = computeLlmInputHash({
      aspectId: 'llm-plain',
      aspectDescription: aspect.description ?? '',
      scope: aspect.scope,
      nodePath: 'svc',
      ruleHash: ruleHashFor(aspect, 'content.md'),
      files: [['src/svc.ts', hashBytes(svcBytes)]],
      references: [],
      tier: tierHashViewFromTier('standard'),
      verdict: 'approved',
    });
    expect(entry?.hash).toBe(plainHash);
    expect(companionHashFor(aspect)).toBeUndefined();
  });

  // ── aspect-companion-runtime-error surfacing ────────────────────────────────
  // Since v5.2.0 the §4 prompt-size gate is unconditional (omitted max_prompt_chars
  // defaults to 50000). verify-lock resolves the companion LIVE to size the gate, so a
  // throwing companion fails there as a companion-error BEFORE fill, the pair is no
  // longer `unverified`, and fill SKIPS it. The aspect-companion-runtime-error therefore
  // surfaces as a blocking issue in the CHECK report — not via the fill-stage per-pair
  // message / summary counter, which now serve as defense-in-depth only. These two tests
  // (formerly asserting the fill-stage token + summary line) assert the unified surfacing.

  it('hook throw → blocking aspect-companion-runtime-error in the check report, nothing written', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-token',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        companion: 'export function companion() { throw new Error("boom"); }\n',
      }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());

    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // The diagnostic surfaces with the aspect-companion-runtime-error code (the mirror
    // of the deterministic aspect-check-runtime-error), severity error (enforced).
    const ce = result.checkResult.issues.find((i) => i.code === 'aspect-companion-runtime-error');
    expect(ce).toBeDefined();
    expect(ce!.severity).toBe('error');
    // Fail-closed: no infra failure, nothing written.
    expect(result.infraFailures).toBe(0);
    expect(readLock(graph.rootPath).verdicts['llm-token']?.['node:svc']).toBeUndefined();
  });

  it('multiple failing companion hooks each surface a blocking aspect-companion-runtime-error', async () => {
    // Two aspects whose companions both throw → two blocking companion-resolution
    // diagnostics in the check report, both fail-closed (nothing written).
    const { projectRoot } = await setupProject({
      aspects: [
        {
          id: 'llm-summary-a',
          kind: 'llm',
          status: 'enforced',
          rule: 'rule',
          companion: 'export function companion() { throw new Error("summary-test-a"); }\n',
        },
        {
          id: 'llm-summary-b',
          kind: 'llm',
          status: 'enforced',
          rule: 'rule',
          companion: 'export function companion() { throw new Error("summary-test-b"); }\n',
        },
      ],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());

    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    const companionErrors = result.checkResult.issues.filter((i) => i.code === 'aspect-companion-runtime-error');
    expect(companionErrors.length).toBeGreaterThanOrEqual(2);
    expect(companionErrors.every((i) => i.severity === 'error')).toBe(true);
    expect(result.infraFailures).toBe(0);
    expect(readLock(graph.rootPath).verdicts['llm-summary-a']?.['node:svc']).toBeUndefined();
    expect(readLock(graph.rootPath).verdicts['llm-summary-b']?.['node:svc']).toBeUndefined();
  });
});
