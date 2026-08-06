/**
 * Unit tests for the `yg check --approve` fill stage (core/fill.ts, spec §7).
 * LLM-focused tests: LLM fills, consensus, infra failures, FillGatingError (structural abort),
 * cached refusals, header/summary exact strings.
 *
 * HERMETIC: createLlmProvider is mocked exactly like
 * bounty3/approve-gates-failclosed.test.ts — no network, no real reviewer. Each
 * project is a fresh mkdtemp tree; the lock is written to / read from disk by the
 * fill stage. No wall clock is read in any assertion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  mkdtemp, mkdir, writeFile, rm, readFile,
} from 'node:fs/promises';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill, FillGatingError } from '../../../src/core/fill.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
import type { IssueMessage } from '../../../src/model/validation.js';
import { readLock } from '../../../src/io/lock-store.js';
import { EVENTS_FILENAME } from '../../../src/io/events-store.js';
import { verifyLock } from '../../../src/core/verify-lock.js';
import type { LlmProvider } from '../../../src/llm/types.js';
import type { RunStructureAspectResult } from '../../../src/structure/runner.js';

// ── Mock the LLM provider factory (no real reviewer) ──────────────────────────
vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));
import { createLlmProvider } from '../../../src/llm/index.js';
const mockCreateLlmProvider = vi.mocked(createLlmProvider);

// ── Mock the structure runner (pass-through by default; override per test) ────
// Same seam style as the createLlmProvider mock above.
// `var` avoids the temporal-dead-zone issue: vi.mock factories are hoisted to
// the very top of the file (before even `const`/`let` declarations), so only
// `var`-declared names are accessible inside the factory body.
// eslint-disable-next-line no-var
var structureRunnerRealFn: (typeof import('../../../src/structure/runner.js'))['runStructureAspect'] | undefined;
vi.mock('../../../src/structure/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/structure/runner.js')>();
  structureRunnerRealFn = actual.runStructureAspect;
  return {
    ...actual,
    // Wrap runStructureAspect as a vi.fn spy so mockImplementation is available.
    runStructureAspect: vi.fn(actual.runStructureAspect),
  };
});
import { runStructureAspect } from '../../../src/structure/runner.js';
const mockRunStructureAspect = vi.mocked(runStructureAspect);

// ── Mock the companion hook runner SEPARATELY from the reviewer provider ──────
// fill-llm.ts resolves companions through runCompanionHook (hook-loader.ts) BEFORE
// it ever calls the reviewer. Mocking it as its own spy lets each test assert the
// hook-run count and the reviewer-call count independently — the cost-ordering
// invariant (a torn companion observation set must NEVER reach the reviewer) is
// only provable when the two seams are counted apart. Default: delegate to the
// real runner so plain-path tests are unaffected.
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

// ── Mock tier resolution (pass-through by default; override per test) ─────────
// Same seam style as the two mocks above. A test that needs an UNRESOLVABLE tier
// (the per-pair "Cannot resolve a reviewer tier" infra disposition at fill.ts
// step 6) overrides this to return { ok: false }. By default it delegates to the
// real selector so every other test resolves tiers normally.
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
  // Restore the real structure runner so existing det tests keep working.
  // Tests that need a controlled result override this with mockImplementationOnce.
  if (structureRunnerRealFn) {
    const real = structureRunnerRealFn;
    mockRunStructureAspect.mockImplementation(
      (...args: Parameters<typeof runStructureAspect>) => real(...args),
    );
  }
  // Restore the real tier selector so existing LLM tests resolve tiers normally.
  if (tierSelectRealFn) {
    const real = tierSelectRealFn;
    mockSelectTierForAspect.mockImplementation(
      (...args: Parameters<typeof selectTierForAspect>) => real(...args),
    );
  }
  // Restore the real companion hook runner so plain-path tests are unaffected.
  // Companion tests override this with mockResolvedValueOnce / mockImplementation.
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
  /** content.md (llm) / check.mjs (deterministic) body. */
  rule: string;
  scopePer?: 'node' | 'file';
  references?: Array<{ path: string; description?: string }>;
  /** companion.mjs body — when set on an LLM aspect, the loader marks it
   *  hasCompanion and fill-llm runs the companion-resolution path. */
  companion?: string;
}

interface ProjectSpec {
  /** node `svc` aspects. */
  aspects: AspectSpec[];
  /** extra files at repo-relative paths (besides src/svc.ts). */
  files?: Record<string, string>;
  /** node mapping (default ['src/svc.ts']). */
  mapping?: string[];
  configYaml?: string;
  logContent?: string;
  logRequired?: boolean;
  /** extra repo-relative files NOT under the node mapping (e.g. references). */
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

  // Default source file (unless overridden by files/mapping).
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
  // Mirror the CLI layer: render structured diagnostics into the same buffer so
  // notice-text assertions hold (fill.ts itself no longer formats — it emits).
  return { write, emitIssue: (m) => { write(buildIssueMessage(m) + '\n'); }, text: () => buf };
}

const DET_PASS = 'export function check(ctx) { void ctx; return []; }\n';
const DET_FAIL = 'export function check(ctx) { void ctx; return [{ message: "bad", file: "src/svc.ts", line: 1 }]; }\n';

// =============================================================================
// 1. Pre-dispatch header + zero-calls summary — EXACT strings
// =============================================================================

describe('header + summary strings (exact)', () => {
  it('prints the exact pre-dispatch header', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    const w = makeWriter();
    await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });
    expect(w.text()).toContain(
      'Filling 2 unverified pairs across 1 nodes — 1 deterministic (no cost), 1 reviewer calls (consensus included)',
    );
  });

  it('prints the exact zero-calls summary when nothing is unverified', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
    });
    let graph = await loadGraph(projectRoot);
    // First fill records the verdict.
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    // Second fill: nothing unverified.
    graph = await loadGraph(projectRoot);
    const w = makeWriter();
    await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });
    expect(w.text()).toContain('0 reviewer calls made — all expected pairs hold valid verdicts');
  });
});

// =============================================================================
// 3. Cached refusal → second run = 0 reviewer calls; re-renders
// =============================================================================

describe('cached refusal', () => {
  it('a cached LLM refusal makes 0 reviewer calls on the second run', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    let graph = await loadGraph(projectRoot);
    let calls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { calls++; return { satisfied: false, reason: 'nope', errorSource: 'codeViolation' as const }; },
    }));
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    expect(calls).toBe(1);
    const lock1 = readLock(graph.rootPath);
    expect(lock1.verdicts['llm-a']?.['node:svc']?.verdict).toBe('refused');

    // Second run: same inputs → cached, no reviewer call.
    graph = await loadGraph(projectRoot);
    calls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { calls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    expect(calls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    // The cached refusal still renders (check report still errors).
    expect(result.checkResult.issues.some((i) => i.code === 'aspect-violation-enforced')).toBe(true);
  });
});

// =============================================================================
// 4. Infra no-write leaves the pair unverified + prior valid entries intact
// =============================================================================

describe('infra fail-closed', () => {
  it('provider unreachable → no write; a prior valid det entry stays intact', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({ isAvailable: async () => false }));
    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    const lock = readLock(graph.rootPath);
    // The free det pair was filled (it does not need the provider).
    expect(lock.verdicts['det-a']?.['node:svc']?.verdict).toBe('approved');
    // The LLM pair was NOT written (provider down).
    expect(lock.verdicts['llm-a']?.['node:svc']).toBeUndefined();
    expect(result.infraFailures).toBeGreaterThan(0);
    expect(w.text()).toContain('pairs failed on provider/config errors');
    // The unverified LLM pair stays red on the report.
    expect(result.checkResult.issues.some((i) => i.code === 'unverified')).toBe(true);
  });

  it('a missing reference is a LOUD infra failure (no write)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-ref', kind: 'llm', status: 'enforced', rule: 'rule', references: [{ path: 'refs/missing.md' }] }],
      // refs/missing.md is intentionally NOT created.
    });
    const graph = await loadGraph(projectRoot);
    let calls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { calls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // The reviewer must never be called — the reference is missing.
    expect(calls).toBe(0);
    expect(result.infraFailures).toBeGreaterThan(0);
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['llm-ref']?.['node:svc']).toBeUndefined();
  });
});

// =============================================================================
// 11. Side-fix B3: runtime-error run does NOT print the zero-calls summary line
// =============================================================================

describe('zero-calls summary gated on runtimeErrors === 0 (side-fix B3)', () => {
  it('a run with det runtime errors does NOT print the zero-calls summary', async () => {
    // A check.mjs that throws — a runtime error, not a violation verdict.
    const CRASHING_CHECK = 'export function check() { throw new Error("kaboom"); }\n';
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-crash', kind: 'deterministic', status: 'enforced', rule: CRASHING_CHECK }],
    });
    const graph = await loadGraph(projectRoot);
    // No LLM provider needed — this run is all deterministic.
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });
    // The check crashed → runtime error (no write, no reviewer call).
    expect(result.runtimeErrors).toBeGreaterThan(0);
    expect(result.reviewerCallsMade).toBe(0);
    // The zero-calls summary MUST NOT appear when there was a runtime error.
    expect(w.text()).not.toContain('0 reviewer calls made — all expected pairs hold valid verdicts');
  });
});

// =============================================================================
// 12b. Consensus: 3 — refuse/approve/approve → majority approves; 3 calls made
// =============================================================================

describe('consensus=3 majority-approve', () => {
  it('refuse/approve/approve votes → entry written approved, reviewerCallsMade=3, header shows 3 calls', async () => {
    const configConsensus3 =
      'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 3\n      config:\n        model: llama3\n        temperature: 0\n';
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
      configYaml: configConsensus3,
    });
    const graph = await loadGraph(projectRoot);

    // Per-call sequence: refused first, then approved twice → majority (2/3) approves.
    let callIndex = 0;
    const responses = [
      { satisfied: false, reason: 'nope', errorSource: 'codeViolation' as const },
      { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const },
      { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const },
    ];
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { return responses[callIndex++]!; },
    }));

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    // Header must show 3 reviewer calls (consensus included).
    expect(w.text()).toContain('3 reviewer calls (consensus included)');

    // The verdict entry must be approved (majority).
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['llm-a']?.['node:svc']?.verdict).toBe('approved');

    // reviewerCallsMade reflects 3 actual provider calls.
    expect(result.reviewerCallsMade).toBe(3);
  });
});

// =============================================================================
// 13. Structural abort — gating code aborts fill before any runner/provider call
// =============================================================================

describe('structural abort — FillGatingError', () => {
  it('a gating config error throws FillGatingError with zero runner and provider invocations', async () => {
    // Trigger aspect-tier-on-deterministic: a det aspect with reviewer.tier set.
    // This is a member of APPROVE_GATING_CODES so the fill stage aborts immediately
    // in step 1, before any pair is dispatched.
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
    });
    // Overwrite the aspect YAML to add tier: — triggers aspect-tier-on-deterministic.
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'aspects', 'det-a', 'yg-aspect.yaml'),
      'name: det-a\ndescription: det-a rule\nreviewer:\n  type: deterministic\n  tier: standard\nstatus: enforced\n',
    );
    const graph = await loadGraph(projectRoot);

    let providerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        providerCalls++;
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      },
    }));
    // Track runner calls independently (default passthrough is suppressed so we
    // can count cleanly; this test aborts before any runner call anyway).
    let runnerCallCount = 0;
    const real = structureRunnerRealFn!;
    mockRunStructureAspect.mockImplementation(async (...args) => {
      runnerCallCount++;
      return real(...args);
    });

    // The fill must throw FillGatingError — zero fills dispatched.
    await expect(
      runFill(graph, { coverageVisibleFiles: null, write: () => {} }),
    ).rejects.toBeInstanceOf(FillGatingError);

    expect(runnerCallCount).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it('a genuine implies cycle throws FillGatingError, dispatches nothing, and writes no verdict', async () => {
    // Two real aspects whose `implies` point at each other — checkImpliesNoCycles
    // walks every aspect in the graph regardless of node attachment, so neither
    // needs to be attached anywhere to close the cycle. Declaring `implies:` alone
    // (no content.md/check.mjs) makes each an aggregating aspect, so no reviewer
    // config is needed to reach the cycle check. A third, unrelated deterministic
    // aspect on the node proves the abort is total: even a pair with nothing to do
    // with the cycle never gets dispatched.
    const { projectRoot, yggRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
    });
    await mkdir(path.join(yggRoot, 'aspects', 'cyc-a'), { recursive: true });
    await writeFile(
      path.join(yggRoot, 'aspects', 'cyc-a', 'yg-aspect.yaml'),
      'name: cyc-a\ndescription: cycle a\nimplies:\n  - cyc-b\n',
    );
    await mkdir(path.join(yggRoot, 'aspects', 'cyc-b'), { recursive: true });
    await writeFile(
      path.join(yggRoot, 'aspects', 'cyc-b', 'yg-aspect.yaml'),
      'name: cyc-b\ndescription: cycle b\nimplies:\n  - cyc-a\n',
    );
    const graph = await loadGraph(projectRoot);

    let providerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        providerCalls++;
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      },
    }));
    let runnerCallCount = 0;
    const real = structureRunnerRealFn!;
    mockRunStructureAspect.mockImplementation(async (...args) => {
      runnerCallCount++;
      return real(...args);
    });

    const w = makeWriter();
    await expect(
      runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue }),
    ).rejects.toBeInstanceOf(FillGatingError);

    expect(runnerCallCount).toBe(0);
    expect(providerCalls).toBe(0);
    // The cycle's own diagnostic — what it is and how to fix it — reaches the
    // user, not just the generic gating header.
    expect(w.text()).toContain('Aspect implies cycle:');
    expect(w.text()).toContain('Break the cycle by removing one implies edge.');
    // Nothing was written — not even the unrelated deterministic pair.
    expect(readLock(graph.rootPath).verdicts['det-a']?.['node:svc']).toBeUndefined();
  });
});

// =============================================================================
// 14. Fail-closed edge branches — provider-error verdict, reviewer throw,
//     LLM-specific infra errors, isAvailable throw, no-reviewer tier failure,
//     mapping-less closure.
// =============================================================================

describe('fill — fail-closed edge branches', () => {
  it('a provider-sourced refusal (errorSource: provider) is infra → NO write', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      // satisfied=false BUT the failure is a provider error, not a code violation.
      async verifyAspect() { return { satisfied: false, reason: 'rate limited', errorSource: 'provider' as const }; },
    }));
    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    // No verdict written — a provider error never becomes a `refused` verdict.
    expect(readLock(graph.rootPath).verdicts['llm-a']?.['node:svc']).toBeUndefined();
    expect(result.infraFailures).toBeGreaterThan(0);
    expect(w.text()).toContain('pairs failed on provider/config errors');
  });

  it('a reviewer THROW is infra → NO write', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { throw new Error('socket hang up'); },
    }));
    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    expect(readLock(graph.rootPath).verdicts['llm-a']?.['node:svc']).toBeUndefined();
    expect(result.infraFailures).toBeGreaterThan(0);
  });

  it('provider.isAvailable THROWING is treated as unreachable → infra, no write', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async isAvailable() { throw new Error('dns failure'); },
    }));
    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });
    expect(readLock(graph.rootPath).verdicts['llm-a']?.['node:svc']).toBeUndefined();
    expect(result.infraFailures).toBeGreaterThan(0);
    expect(w.text()).toContain('is unreachable');
  });

  it('an LLM aspect with NO reviewer configured aborts the fill (gating) — nothing written', async () => {
    // A config with NO reviewer block at all is a gating config error
    // (config-reviewer-missing ∈ APPROVE_GATING_CODES): the whole fill aborts in
    // step 1 with a FillGatingError BEFORE any pair is dispatched, and the gating
    // details are written to the sink first.
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
      configYaml: 'quality:\n  max_direct_relations: 10\n',
    });
    const graph = await loadGraph(projectRoot);
    const w = makeWriter();
    await expect(runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue })).rejects.toBeInstanceOf(FillGatingError);
    expect(w.text()).toContain('aborted — 1 problem must be fixed before anything runs');
    // No lock verdict was written.
    let lockHasEntry: boolean;
    try { lockHasEntry = readLock(graph.rootPath).verdicts['llm-a']?.['node:svc'] !== undefined; } catch { lockHasEntry = false; }
    expect(lockHasEntry).toBe(false);
  });

  it('a non-gating UNRESOLVABLE reviewer tier leaves the LLM pair UNVERIFIED (fail-closed, no write, infra counted)', async () => {
    // Distinct from the gating cases above: the config IS structurally valid (the
    // validator emits no APPROVE_GATING_CODES, so the fill is NOT aborted in step
    // 1), yet tier resolution still fails for this aspect at dispatch time. fill.ts
    // step 6 must treat that as an infrastructure disposition — write NOTHING and
    // leave the pair unverified (fail-closed), never approving or crashing.
    //
    // We force the unresolvable tier through the tier-selection seam (the same
    // mocking pattern this file uses for the provider and the structure runner),
    // because every NATURAL trigger of selectTierForAspect → { ok: false } is
    // itself a gating config error that aborts the whole fill before this per-pair
    // branch is ever reached. The seam isolates exactly the per-pair fail-closed
    // contract under test.
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    const graph = await loadGraph(projectRoot);

    // Tier resolution fails for the aspect (no gating code involved).
    mockSelectTierForAspect.mockReturnValue({
      ok: false,
      error: {
        what: 'tier unresolvable (test)',
        why: 'forced unresolvable tier for the fail-closed contract',
        next: 'fix the tier',
      },
    });

    // The provider must never be reached: an unresolvable tier short-circuits
    // before any provider is created or queried.
    let providerVerifyCalls = 0;
    let providerCreated = 0;
    mockCreateLlmProvider.mockImplementation(() => {
      providerCreated++;
      return makeMockProvider({
        async verifyAspect() {
          providerVerifyCalls++;
          return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
        },
      });
    });

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    // Fail-closed: NO verdict written for the unresolvable-tier pair.
    expect(readLock(graph.rootPath).verdicts['llm-a']?.['node:svc']).toBeUndefined();
    // Counted as an infra failure, not a code violation.
    expect(result.infraFailures).toBeGreaterThan(0);
    // No provider was ever created or asked — the disposition is decided before dispatch.
    expect(providerCreated).toBe(0);
    expect(providerVerifyCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    // The exact per-pair infra notice was emitted.
    expect(w.text()).toContain(
      "Cannot resolve a reviewer tier for aspect 'llm-a' on node:svc — left unverified.",
    );
    // The pair stays red on the report (no false-green over the unreviewed aspect).
    expect(result.checkResult.issues.some((i) => i.code === 'unverified')).toBe(true);
  });

  it('a det check returning succeeded:false is a runtime error → no write, runtimeErrors counted', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
    });
    const graph = await loadGraph(projectRoot);
    mockRunStructureAspect.mockImplementation(async (): Promise<RunStructureAspectResult> => ({
      violations: [{ message: 'check crashed' }],
      touchedFiles: [],
      succeeded: false,
      observations: [],
      observationsTainted: false,
    }));
    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });
    expect(readLock(graph.rootPath).verdicts['det-a']?.['node:svc']).toBeUndefined();
    expect(result.runtimeErrors).toBeGreaterThan(0);
    expect(w.text()).toContain('aspect-check-runtime-error');
  });

  it('a det check tainted on BOTH runs fails closed (runtime error, no write)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
    });
    const graph = await loadGraph(projectRoot);
    // Always tainted → re-run once, still tainted → runtime error.
    mockRunStructureAspect.mockImplementation(async (): Promise<RunStructureAspectResult> => ({
      violations: [],
      touchedFiles: [],
      succeeded: true,
      observations: [],
      observationsTainted: true,
    }));
    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });
    expect(readLock(graph.rootPath).verdicts['det-a']?.['node:svc']).toBeUndefined();
    expect(result.runtimeErrors).toBeGreaterThan(0);
    expect(w.text()).toContain('aspect-check-runtime-error');
  });

  it('a det refusal records a reason with the violation file:line rendered', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_FAIL }],
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    const entry = readLock(graph.rootPath).verdicts['det-a']?.['node:svc'];
    expect(entry?.verdict).toBe('refused');
    // DET_FAIL reports { message: 'bad', file: 'src/svc.ts', line: 1 } → "src/svc.ts:1: bad".
    expect(entry?.reason).toContain('src/svc.ts:1: bad');
  });

  it('a det refusal reason omits the line segment when a violation has no line (no ":?:")', async () => {
    // Three legal Violation shapes: file without line, file+column without line
    // (column-without-line renders identically to no-line), and message-only.
    const rule =
      'export function check(ctx) { void ctx; return [' +
      '{ message: "no line", file: "src/svc.ts" }, ' +
      '{ message: "col only", file: "src/svc.ts", column: 2 }, ' +
      '{ message: "graph-level" }]; }\n';
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule }],
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    const entry = readLock(graph.rootPath).verdicts['det-a']?.['node:svc'];
    expect(entry?.verdict).toBe('refused');
    expect(entry?.reason).toContain('src/svc.ts: no line');
    expect(entry?.reason).toContain('src/svc.ts: col only');
    expect(entry?.reason).toContain('graph-level');
    expect(entry?.reason).not.toContain(':?:');
  });

  it('the infra summary names the provider and tier when an LLM pair fails on infra', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({ isAvailable: async () => false }));
    const w = makeWriter();
    await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });
    // The summary's parenthetical id carries the provider / tier.
    expect(w.text()).toContain('ollama');
    expect(w.text()).toContain('standard');
  });

  it('a mapping-less node records only the log baseline at closure (no source fingerprint)', async () => {
    // A node with an empty mapping has no source fingerprint; closure still records
    // its log baseline when a log.md exists.
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
      mapping: [],
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    const nodeEntry = readLock(graph.rootPath).nodes['svc'];
    // No source fingerprint (mapping-less), but the log baseline is recorded.
    expect(nodeEntry?.source).toBeUndefined();
    expect(nodeEntry?.log?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');
  });
});

// =============================================================================
// 15. Bug 1: a BOM-prefixed reference must round-trip fill → verify as VERIFIED.
//
// The producer (fill) and verifier (verify-lock) must hash the SAME bytes for
// every reference. Before the fix the producer read references via
// stripBom(readTextFile(...)) and folded the BOM-stripped, UTF-8-re-encoded
// bytes, while the verifier reads raw disk bytes (readFileBytes) and folds those.
// For a reference carrying a UTF-8 BOM the two byte streams differ, so the
// freshly-written verdict reproduces a different hash at verify time and reads
// `unverified` FOREVER — a permanent false-red with no in-product remedy. This
// test pins the round-trip: after fill the pair must verify clean.
// =============================================================================

describe('Bug 1 — BOM/non-UTF-8 reference round-trips fill → verify', () => {
  it('a reference file with a UTF-8 BOM verifies after fill (no permanent false-red)', async () => {
    // U+FEFF encodes as the UTF-8 BOM bytes EF BB BF when written as UTF-8
    // (escape sequence, not a literal BOM char, to stay lint-clean).
    const BOM_REFERENCE = '\uFEFF# Catalogue\nallowed: a, b, c\n';
    const { projectRoot } = await setupProject({
      aspects: [
        {
          id: 'llm-ref',
          kind: 'llm',
          status: 'enforced',
          rule: 'rule body',
          references: [{ path: 'refs/catalogue.md', description: 'lookup table' }],
        },
      ],
      extraFiles: { 'refs/catalogue.md': BOM_REFERENCE },
    });

    // Sanity: the reference really carries the BOM on disk (EF BB BF).
    const rawRef = await readFile(path.join(projectRoot, 'refs', 'catalogue.md'));
    expect(rawRef[0]).toBe(0xef);
    expect(rawRef[1]).toBe(0xbb);
    expect(rawRef[2]).toBe(0xbf);

    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider()); // approves
    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // The fill wrote an approved verdict (the provider was reachable and approved).
    const entry = readLock(graph.rootPath).verdicts['llm-ref']?.['node:svc'];
    expect(entry?.verdict).toBe('approved');

    // The final check report carries NO unverified for this aspect — the pair the
    // fill just wrote re-verifies against the same raw reference bytes.
    expect(
      result.checkResult.issues.some(
        (i) => i.code === 'unverified',
      ),
    ).toBe(false);

    // And an independent verifyLock pass agrees: the pair is `verified`, not
    // `unverified` (this is the assertion that fails against the pre-fix producer,
    // where the BOM-stripped hash never matched the raw-bytes recompute).
    const freshGraph = await loadGraph(projectRoot);
    const verification = await verifyLock(freshGraph, readLock(freshGraph.rootPath));
    const vp = verification.pairs.find(
      (p) => p.pair.aspectId === 'llm-ref' && p.pair.unitKey === 'node:svc',
    );
    expect(vp?.state.kind).toBe('verified');
  });
});

// =============================================================================
// 16. Item #10: per-pair durability — a completed LLM verdict is persisted the
// moment its pair finishes (inside the runPairPool worker continuation), so an
// interrupt / mid-pool failure keeps every already-finished verdict and the next
// run resumes only the rest. Pins the persist-per-pair form at fill.ts (commit
// ca39916a) and the `outcome.kind === 'verdict'` write guard (commit fb950eea).
// =============================================================================

const PARALLEL_1_CONFIG = `parallel: 1\n${V5_REVIEWER_CONFIG}`;
const PARALLEL_2_CONFIG = `parallel: 2\n${V5_REVIEWER_CONFIG}`;

describe('per-pair durability under mid-pool failure (item #10)', () => {
  it('completed LLM pair is durable before a later mid-pool failure', async () => {
    // Two enforced LLM aspects on one node, consensus 1, parallel 1 → the pool
    // dispatches them one at a time. The provider approves the first pair, then
    // throws on the second (simulating a Ctrl+C / crash mid-pool). The first
    // verdict must already be on disk; the second must be absent.
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
        { id: 'llm-b', kind: 'llm', status: 'enforced', rule: 'rule b' },
      ],
      configYaml: PARALLEL_1_CONFIG,
    });
    const graph = await loadGraph(projectRoot);

    let calls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        calls++;
        if (calls === 1) return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
        throw new Error('ctrl-c interrupt');
      },
    }));

    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // The first pair to complete persisted its approved verdict before the
    // second pair's throw — exactly one approved verdict survives on disk.
    const verdicts = readLock(graph.rootPath).verdicts;
    const approved = Object.entries(verdicts).flatMap(([aspectId, byUnit]) =>
      Object.entries(byUnit ?? {})
        .filter(([, entry]) => entry.verdict === 'approved')
        .map(([unitKey]) => `${aspectId}:${unitKey}`),
    );
    expect(approved).toHaveLength(1);
    // The throwing pair wrote nothing (infra disposition, fail-closed).
    expect(result.infraFailures).toBeGreaterThanOrEqual(1);
    // Sanity: exactly one of the two aspect entries exists; the other is absent.
    const aPresent = verdicts['llm-a']?.['node:svc'] !== undefined;
    const bPresent = verdicts['llm-b']?.['node:svc'] !== undefined;
    expect(aPresent !== bPresent).toBe(true);
  });

  it('second run bills only the remaining pair', async () => {
    // After the mid-pool failure above, the surviving verdict is cached and the
    // second run re-verifies ONLY the still-unverified pair — one provider call.
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
        { id: 'llm-b', kind: 'llm', status: 'enforced', rule: 'rule b' },
      ],
      configYaml: PARALLEL_1_CONFIG,
    });
    let graph = await loadGraph(projectRoot);

    // First run: approve pair #1, throw on pair #2.
    let calls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        calls++;
        if (calls === 1) return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
        throw new Error('ctrl-c interrupt');
      },
    }));
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // Second run: approve-all + count calls. The cached pair is NOT re-billed.
    graph = await loadGraph(projectRoot);
    let secondRunCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        secondRunCalls++;
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      },
    }));
    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // Exactly one reviewer call — only the remaining (previously-thrown) pair.
    expect(secondRunCalls).toBe(1);
    expect(result.reviewerCallsMade).toBe(1);
    // Both aspects are now approved on disk.
    const verdicts = readLock(graph.rootPath).verdicts;
    expect(verdicts['llm-a']?.['node:svc']?.verdict).toBe('approved');
    expect(verdicts['llm-b']?.['node:svc']?.verdict).toBe('approved');
  });

  it('infra outcome inside the pool writes nothing', async () => {
    // A single LLM pair whose provider returns a provider-sourced non-satisfaction
    // is an infra disposition INSIDE the pool worker — the `outcome.kind ===
    // 'verdict'` guard skips the write, so the lock holds no entry for it.
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
      configYaml: PARALLEL_1_CONFIG,
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { return { satisfied: false, reason: 'rate limited', errorSource: 'provider' as const }; },
    }));
    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // No verdict written — the in-pool infra disposition is fail-closed.
    expect(readLock(graph.rootPath).verdicts['llm-a']?.['node:svc']).toBeUndefined();
    expect(result.infraFailures).toBeGreaterThanOrEqual(1);
  });

  it('parallel:2 both completed pairs durable, lock not torn', async () => {
    // Two LLM pairs dispatched concurrently (parallel 2), both approved. Both
    // verdicts must land on disk uncorrupted, and a fresh verifyLock pass must
    // classify both as `verified` (the lock was not torn by concurrent writes).
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
        { id: 'llm-b', kind: 'llm', status: 'enforced', rule: 'rule b' },
      ],
      configYaml: PARALLEL_2_CONFIG,
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider()); // approves both
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // Both verdicts are approved on disk.
    const verdicts = readLock(graph.rootPath).verdicts;
    expect(verdicts['llm-a']?.['node:svc']?.verdict).toBe('approved');
    expect(verdicts['llm-b']?.['node:svc']?.verdict).toBe('approved');

    // A fresh verifyLock pass classifies BOTH pairs as verified — the lock is
    // intact and re-hashes cleanly against the same inputs.
    const freshGraph = await loadGraph(projectRoot);
    const verification = await verifyLock(freshGraph, readLock(freshGraph.rootPath));
    for (const aspectId of ['llm-a', 'llm-b']) {
      const vp = verification.pairs.find(
        (p) => p.pair.aspectId === aspectId && p.pair.unitKey === 'node:svc',
      );
      expect(vp?.state.kind).toBe('verified');
    }
  });
});

// =============================================================================
// 17. RZ-2: judge identity (provider + model) on LLM event lines.
//
// The verdict-events sidecar records WHICH judge produced each LLM verdict, so a
// later analysis can separate judge regimes. Tier re-pointing is invisible to
// the lock, so without this field telemetry mixes regimes undetectably. Judge is
// telemetry ONLY (never a hash ingredient) and is recorded on LLM lines at every
// site where the tier resolved — the verdict site AND the LLM infra sites.
// Deterministic lines never carry it.
// =============================================================================

/** Read and parse the sidecar's JSONL lines for a project's `.yggdrasil/` root. */
async function readEventsFor(rootPath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path.join(rootPath, EVENTS_FILENAME), 'utf-8');
  return raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('judge identity on LLM event lines (RZ-2)', () => {
  it('an approved LLM line records judge {provider, model} from the resolved tier; a deterministic line omits judge', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider()); // approves
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    const events = await readEventsFor(graph.rootPath);
    const llmEvent = events.find((e) => e.aspectId === 'llm-a' && e.disposition === 'approved');
    const detEvent = events.find((e) => e.aspectId === 'det-a' && e.disposition === 'approved');
    expect(llmEvent).toBeDefined();
    expect(detEvent).toBeDefined();
    // The tier config (V5_REVIEWER_CONFIG) is provider ollama, model llama3.
    expect(llmEvent!.judge).toEqual({ provider: 'ollama', model: 'llama3' });
    // Deterministic verdicts never carry a judge (LLM-only telemetry).
    expect('judge' in detEvent!).toBe(false);
  });

  it('an LLM infra line (provider unreachable) still records the resolved judge', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({ isAvailable: async () => false }));
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    const events = await readEventsFor(graph.rootPath);
    const infraEvent = events.find((e) => e.aspectId === 'llm-a' && e.disposition === 'infra');
    expect(infraEvent).toBeDefined();
    // The tier resolved (provider is only found unreachable afterwards), so the
    // judge identity is known and recorded even though no verdict was written.
    expect(infraEvent!.judge).toEqual({ provider: 'ollama', model: 'llama3' });
  });

  it('a tier that never resolves records NO judge (regime unknown)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    const graph = await loadGraph(projectRoot);
    // Force tier resolution to fail for the pair — no resolved judge exists.
    mockSelectTierForAspect.mockReturnValue({
      ok: false,
      error: { what: 'tier unresolvable (test)', why: 'forced', next: 'fix the tier' },
    });
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    const events = await readEventsFor(graph.rootPath);
    const infraEvent = events.find((e) => e.aspectId === 'llm-a' && e.disposition === 'infra');
    expect(infraEvent).toBeDefined();
    // No tier resolved → no judge identity to record → the key is absent.
    expect('judge' in infraEvent!).toBe(false);
  });
});

// Companion-resolution tests have been moved to fill-llm-companion.test.ts
// to keep both files under the reviewer's 50 000-char prompt limit.
