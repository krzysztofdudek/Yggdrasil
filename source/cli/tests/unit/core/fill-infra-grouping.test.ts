/**
 * Unit tests verifying that repeated infrastructure/runtime dispositions
 * that share the same root-cause aspect are grouped into ONE message
 * instead of N near-identical per-pair messages.
 *
 * Task 4.3 of the `yg check --approve` output redesign.
 *
 * Coverage:
 *  1. Det runtime error on 3 per-file units of the same aspect → ONE grouped message.
 *  2. Det runtime error on 1 unit of aspect A and 1 unit of aspect B → TWO messages.
 *  3. Companion runtime error on 2 per-file units of the same aspect → ONE grouped message.
 *  4. Pool-level infra disposition (tier unresolvable) on 2 units of same aspect → ONE grouped message.
 *  5. Per-tier provider-unreachable (already grouped in fill.ts) → ONE message (unchanged).
 *
 * HERMETIC: real structure runner is mocked to control det outcomes; no network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
import type { IssueMessage } from '../../../src/model/validation.js';
import type { LlmProvider } from '../../../src/llm/types.js';
import type { RunStructureAspectResult } from '../../../src/structure/runner.js';

// ── Mock LLM provider factory ─────────────────────────────────────────────────
vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));
import { createLlmProvider } from '../../../src/llm/index.js';
const mockCreateLlmProvider = vi.mocked(createLlmProvider);

// ── Mock structure runner ─────────────────────────────────────────────────────
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

// ── Mock companion hook runner ────────────────────────────────────────────────
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

// ── Mock tier selector ────────────────────────────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    ...overrides,
  };
}

const V5_REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n';

const DET_PASS = 'export function check(ctx) { void ctx; return []; }\n';

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

/** Collected emitIssue calls + rendered text for assertion. */
function makeWriter() {
  let buf = '';
  const messages: IssueMessage[] = [];
  const write = (s: string) => { buf += s; };
  const emitIssue = (m: IssueMessage) => {
    messages.push(m);
    buf += buildIssueMessage(m) + '\n';
  };
  return { write, emitIssue, text: () => buf, messages: () => messages };
}

/**
 * Build a minimal Yggdrasil project with one node 'svc' mapping multiple files,
 * one deterministic aspect with scope: per: file, and an optional LLM aspect.
 */
async function setupMultiFileProject(opts: {
  detAspectId: string;
  detRule: string;
  files: string[]; // repo-relative mapped source files
  configYaml?: string;
  extraAspects?: Array<{ id: string; kind: 'llm' | 'deterministic'; rule: string; companion?: string; scopePer?: 'node' | 'file' }>;
}): Promise<{ projectRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-grouping-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });

  await writeFile(path.join(yggRoot, 'yg-config.yaml'), opts.configYaml ?? V5_REVIEWER_CONFIG);
  await writeFile(
    path.join(yggRoot, 'yg-architecture.yaml'),
    'node_types:\n  service:\n    description: s\n    log_required: false\n',
  );

  // Create all mapped source files.
  for (const rel of opts.files) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, `export const x = 1; // ${rel}\n`);
  }

  // Node YAML — maps all provided files; attaches the det aspect + any extras.
  const allAspectIds = [opts.detAspectId, ...(opts.extraAspects ?? []).map((a) => a.id)];
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    `name: svc\ntype: service\ndescription: x\nmapping:\n` +
      opts.files.map((f) => `  - ${f}`).join('\n') + '\n' +
      `aspects:\n` + allAspectIds.map((id) => `  - ${id}`).join('\n') + '\n',
  );

  // Det aspect with scope: per: file.
  const detDir = path.join(yggRoot, 'aspects', opts.detAspectId);
  await mkdir(detDir, { recursive: true });
  await writeFile(
    path.join(detDir, 'yg-aspect.yaml'),
    `name: ${opts.detAspectId}\ndescription: det rule\nreviewer:\n  type: deterministic\nstatus: enforced\nscope:\n  per: file\n`,
  );
  await writeFile(path.join(detDir, 'check.mjs'), opts.detRule);

  // Extra aspects.
  for (const asp of opts.extraAspects ?? []) {
    const aspDir = path.join(yggRoot, 'aspects', asp.id);
    await mkdir(aspDir, { recursive: true });
    const scopeBlock = asp.scopePer ? `scope:\n  per: ${asp.scopePer}\n` : '';
    await writeFile(
      path.join(aspDir, 'yg-aspect.yaml'),
      `name: ${asp.id}\ndescription: ${asp.id} rule\nreviewer:\n  type: ${asp.kind}\nstatus: enforced\n${scopeBlock}`,
    );
    const ruleFile = asp.kind === 'llm' ? 'content.md' : 'check.mjs';
    await writeFile(path.join(aspDir, ruleFile), asp.rule);
    if (asp.companion !== undefined) {
      await writeFile(path.join(aspDir, 'companion.mjs'), asp.companion);
    }
  }

  return { projectRoot: root };
}

// =============================================================================
// 1. Det runtime error on 3 per-file units → ONE grouped message
// =============================================================================

describe('det runtime errors grouped by aspectId', () => {
  it('3 per-file units of the same det aspect all crash → exactly one grouped message', async () => {
    const { projectRoot } = await setupMultiFileProject({
      detAspectId: 'det-crash',
      detRule: DET_PASS, // overridden by mock below
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
    const graph = await loadGraph(projectRoot);

    // All runs return succeeded:false → runtime error for all 3 units.
    mockRunStructureAspect.mockImplementation(async (): Promise<RunStructureAspectResult> => ({
      violations: [{ message: 'crash' }],
      touchedFiles: [],
      succeeded: false,
      observations: [],
      observationsTainted: false,
    }));

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    // 3 pairs all hit runtime-error.
    expect(result.runtimeErrors).toBe(3);

    // Exactly ONE per-aspect grouped message should mention both 'aspect-check-runtime-error'
    // AND the specific aspect ID (the aggregate summary says "N deterministic check(s)" but
    // does not name the aspect — so filtering on both tokens isolates the grouped notice).
    const errorMessages = w.messages().filter(
      (m) => m.what.includes('aspect-check-runtime-error') && m.what.includes('det-crash'),
    );
    expect(errorMessages).toHaveLength(1);

    // The grouped message should name all 3 units.
    const grouped = errorMessages[0];
    expect(grouped.what).toContain('3 units');
    expect(grouped.what).toContain('src/a.ts');
    expect(grouped.what).toContain('src/b.ts');
    expect(grouped.what).toContain('src/c.ts');
  });

  it('single-unit det runtime error → original per-pair message emitted unchanged', async () => {
    const { projectRoot } = await setupMultiFileProject({
      detAspectId: 'det-crash',
      detRule: DET_PASS,
      files: ['src/a.ts'],
    });
    const graph = await loadGraph(projectRoot);

    mockRunStructureAspect.mockImplementation(async (): Promise<RunStructureAspectResult> => ({
      violations: [{ message: 'crash' }],
      touchedFiles: [],
      succeeded: false,
      observations: [],
      observationsTainted: false,
    }));

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    expect(result.runtimeErrors).toBe(1);
    // Single unit → original per-pair message format (includes the unit key).
    // The per-aspect notice + the aggregate summary both contain the token; at least one is emitted.
    const singleNotices = w.messages().filter(
      (m) => m.what.includes('aspect-check-runtime-error') && m.what.includes('det-crash'),
    );
    expect(singleNotices).toHaveLength(1);
    // The single-unit notice includes the file path directly in what: (per-pair format).
    expect(singleNotices[0].what).toContain('src/a.ts');
    // No "N units" phrasing for the single-unit case.
    expect(singleNotices[0].what).not.toContain('units');
  });

  it('det runtime on 1 unit of aspect A and 1 unit of aspect B → TWO separate messages', async () => {
    // Two per-file aspects on the same node, 1 file → 1 pair each (different aspects).
    const root = await mkdtemp(path.join(tmpdir(), 'yg-grouping-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    const nodeDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });

    await writeFile(path.join(yggRoot, 'yg-config.yaml'), V5_REVIEWER_CONFIG);
    await writeFile(
      path.join(yggRoot, 'yg-architecture.yaml'),
      'node_types:\n  service:\n    description: s\n    log_required: false\n',
    );
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const x = 1;\n');

    await writeFile(
      path.join(nodeDir, 'yg-node.yaml'),
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/a.ts\naspects:\n  - det-a\n  - det-b\n',
    );

    for (const id of ['det-a', 'det-b']) {
      const dir = path.join(yggRoot, 'aspects', id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'yg-aspect.yaml'),
        `name: ${id}\ndescription: ${id}\nreviewer:\n  type: deterministic\nstatus: enforced\nscope:\n  per: file\n`,
      );
      await writeFile(path.join(dir, 'check.mjs'), DET_PASS);
    }

    const graph = await loadGraph(root);

    // Both det checks crash.
    mockRunStructureAspect.mockImplementation(async (): Promise<RunStructureAspectResult> => ({
      violations: [{ message: 'crash' }],
      touchedFiles: [],
      succeeded: false,
      observations: [],
      observationsTainted: false,
    }));

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    expect(result.runtimeErrors).toBe(2);
    // TWO separate per-aspect grouped messages — one per aspect (each aspect only has
    // 1 unit so the per-pair message is emitted; filter by aspect ID to isolate them
    // from the aggregate summary which also contains the runtime-error token).
    const msgA = w.messages().filter((m) => m.what.includes('aspect-check-runtime-error') && m.what.includes('det-a'));
    const msgB = w.messages().filter((m) => m.what.includes('aspect-check-runtime-error') && m.what.includes('det-b'));
    expect(msgA).toHaveLength(1);
    expect(msgB).toHaveLength(1);
  });
});

// =============================================================================
// 2. Companion runtime error on 2 per-file units → ONE grouped message
// =============================================================================

describe('companion runtime errors grouped by aspectId', () => {
  it('2 per-file units of the same companion aspect all fail → exactly one grouped message', async () => {
    // NOTE on mock strategy: verify-lock calls resolveCompanionsForPair (and thus
    // runCompanionHook) during pair classification (step 2). A companion-error result
    // there marks the pair as NOT unverified, so fill never processes them. We
    // therefore let verifyLock's calls succeed, then fail the fill-time calls.
    //
    // Order: verifyLock (2 calls for 2 per-file pairs) → fill (2 calls) → runCheck (2 calls).
    // We succeed the first 4 (verifyLock × 2 + fill × 0... actually verifyLock + fill both
    // go through the mock). Use a call counter to switch behavior after verifyLock.
    const COMPANION_SRC = 'export function getCompanionPaths() { return []; }\n';
    const { projectRoot } = await setupMultiFileProject({
      detAspectId: 'det-pass',
      detRule: DET_PASS,
      files: ['src/a.ts', 'src/b.ts'],
      extraAspects: [{
        id: 'llm-companion',
        kind: 'llm',
        rule: 'rule content',
        companion: COMPANION_SRC,
        scopePer: 'file',
      }],
    });
    const graph = await loadGraph(projectRoot);

    // verifyLock (step 2) calls the hook 2 times (one per per-file unit).
    // Fill calls the hook 2 more times (the infra disposition fires here).
    // runCheck at the end calls verifyLock again (2 more times = succeed again).
    // Strategy: use a counter — first 2 calls (verifyLock) succeed, next 2 (fill) fail.
    const inflightInfra = {
      kind: 'infra' as const,
      messageData: {
        what: "companion hook threw while resolving companions (aspect 'llm-companion'): hook crash",
        why: 'Error: hook crash\n    at companion.mjs:1',
        next: 'Fix the bug in companion.mjs, then re-run: yg check --approve',
      },
    };
    const inflightOk = {
      kind: 'ok' as const,
      descriptors: [] as Array<{ path: string; label?: string }>,
      touchedFiles: [] as string[],
      observations: [] as Array<[string, string]>,
      observationsTainted: false,
    };
    let callCount = 0;
    mockRunCompanionHook.mockImplementation(async () => {
      callCount++;
      // Calls 1-2: verifyLock classification → succeed so pairs are unverified.
      // Calls 3-4: fill-time companion resolution → infra (triggers companion-runtime-error).
      // Calls 5+: runCheck verifyLock re-run → succeed again (irrelevant for count).
      return (callCount <= 2 || callCount > 4) ? inflightOk : inflightInfra;
    });

    // Mock provider for the LLM aspect (won't be called since companion fails first).
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    // 2 companion failures.
    expect(result.companionRuntimeErrors).toBe(2);

    // Exactly ONE per-aspect grouped message should mention 'aspect-companion-runtime-error'
    // AND the specific aspect ID (the aggregate summary does not name the aspect).
    const errorMessages = w.messages().filter(
      (m) => m.what.includes('aspect-companion-runtime-error') && m.what.includes('llm-companion'),
    );
    expect(errorMessages).toHaveLength(1);

    // The grouped message names the count.
    const grouped = errorMessages[0];
    expect(grouped.what).toContain('2 units');
  });
});

// =============================================================================
// 3. Pool-level infra (tier unresolvable) on 2 per-file units → ONE grouped message
// =============================================================================

describe('pool infra (unresolvable tier) grouped by aspectId', () => {
  it('2 per-file units with unresolvable tier → exactly one grouped message', async () => {
    const { projectRoot } = await setupMultiFileProject({
      detAspectId: 'det-pass',
      detRule: DET_PASS,
      files: ['src/a.ts', 'src/b.ts'],
      extraAspects: [{
        id: 'llm-notier',
        kind: 'llm',
        rule: 'rule content',
        scopePer: 'file',
      }],
    });
    const graph = await loadGraph(projectRoot);

    // All tier lookups for 'llm-notier' fail.
    mockSelectTierForAspect.mockImplementation((...args) => {
      if (args[0].id === 'llm-notier') {
        return { ok: false as const, error: { what: 'no tier configured for llm-notier', why: 'no tier configured', next: 'add a tier' } };
      }
      // Delegate everything else to the real function.
      return tierSelectRealFn!(...args);
    });
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    // 2 infra failures.
    expect(result.infraFailures).toBe(2);

    // Only ONE message about the unresolvable tier for 'llm-notier'.
    // The grouped form names the aspect; the aggregate summary says "N pairs failed" (no aspect name).
    const tierMessages = w.messages().filter((m) =>
      m.what.includes('llm-notier') && !m.what.includes('pairs failed on provider'),
    );
    expect(tierMessages).toHaveLength(1);
    expect(tierMessages[0].what).toContain('2 units');
  });
});

// =============================================================================
// Task 4.3 fix — lossless grouping key: distinct why/next under same aspect
// =============================================================================

describe('distinct-reason grouping (lossless): same aspect, different why/next → separate messages', () => {
  it('two det pairs of the same aspect with DIFFERENT runtime-error messages → TWO grouped messages', async () => {
    // Two per-file units of the same det aspect each produce a runtime error with
    // a DISTINCT error message (different why/next).  The fix must emit TWO separate
    // grouped messages — one per distinct reason — not one merged message that silently
    // drops the second unit's distinct why/next.
    const { projectRoot } = await setupMultiFileProject({
      detAspectId: 'det-multierr',
      detRule: DET_PASS, // overridden by mock below
      files: ['src/a.ts', 'src/b.ts'],
    });
    const graph = await loadGraph(projectRoot);

    // Each call gets a DIFFERENT error message so the why/next differ per unit.
    let callCount = 0;
    mockRunStructureAspect.mockImplementation(async (): Promise<RunStructureAspectResult> => {
      callCount++;
      const suffix = callCount <= 1 ? 'alpha' : 'beta';
      return {
        violations: [{ message: `crash-${suffix}` }],
        touchedFiles: [],
        succeeded: false,
        observations: [],
        observationsTainted: false,
      };
    });

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    // Both units hit runtime-error.
    expect(result.runtimeErrors).toBe(2);

    // The two units produced DIFFERENT error messages → each must appear as a
    // SEPARATE grouped message.  Filter by the aspect-check-runtime-error token
    // and the aspect name to exclude the aggregate summary.
    const detMessages = w.messages().filter(
      (m) => m.what.includes('aspect-check-runtime-error') && m.what.includes('det-multierr'),
    );
    expect(detMessages).toHaveLength(2);

    // Each message must contain ONLY its own unit (a.ts or b.ts), not both.
    const msgA = detMessages.find((m) => m.what.includes('src/a.ts'));
    const msgB = detMessages.find((m) => m.what.includes('src/b.ts'));
    expect(msgA).toBeDefined();
    expect(msgB).toBeDefined();
    // The messages must be distinct (different why that includes the respective crash suffix).
    expect(msgA!.why).not.toEqual(msgB!.why);
  });

  it('two pool-infra pairs of the same aspect with DIFFERENT why/next → TWO grouped messages', async () => {
    // Two per-file units of the same LLM aspect each produce a tier-resolution infra
    // error with a DIFFERENT error reason.  The fix must emit TWO separate messages.
    const { projectRoot } = await setupMultiFileProject({
      detAspectId: 'det-pass',
      detRule: DET_PASS,
      files: ['src/a.ts', 'src/b.ts'],
      extraAspects: [{
        id: 'llm-distincterr',
        kind: 'llm',
        rule: 'rule content',
        scopePer: 'file',
      }],
    });
    const graph = await loadGraph(projectRoot);

    // Each invocation of selectTierForAspect for 'llm-distincterr' alternates
    // between two distinct failure reasons (odd calls → alpha, even calls → beta).
    // selectTierForAspect is called once per pair in the step-3 budget loop and
    // again per pair in the step-6 tier resolution loop; alternating ensures that
    // the two step-6 calls (which produce the poolInfraItems messageData) each
    // get a different reason regardless of how many step-3 calls precede them.
    let tierCallCount = 0;
    mockSelectTierForAspect.mockImplementation((...args) => {
      if (args[0].id === 'llm-distincterr') {
        tierCallCount++;
        const reason = tierCallCount % 2 === 1 ? 'reason-alpha' : 'reason-beta';
        return {
          ok: false as const,
          error: {
            what: `no tier for llm-distincterr (${reason})`,
            why: `no tier configured: ${reason}`,
            next: `add a tier (${reason})`,
          },
        };
      }
      return tierSelectRealFn!(...args);
    });
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    // 2 infra failures (one per unit).
    expect(result.infraFailures).toBe(2);

    // TWO separate messages for 'llm-distincterr' — distinct reasons must not merge.
    const distinctErrMessages = w.messages().filter(
      (m) => m.what.includes('llm-distincterr') && !m.what.includes('pairs failed on provider'),
    );
    expect(distinctErrMessages).toHaveLength(2);
    // Each message carries its own unit and its own why.
    const msgA = distinctErrMessages.find((m) => m.why.includes('reason-alpha'));
    const msgB = distinctErrMessages.find((m) => m.why.includes('reason-beta'));
    expect(msgA).toBeDefined();
    expect(msgB).toBeDefined();
    expect(msgA!.why).not.toEqual(msgB!.why);
  });

  it('identical why/next under same aspect still collapses to ONE message (regression guard)', async () => {
    // Sanity check: when both units truly share the same error message, the original
    // grouping behaviour (one message, both units listed) must be preserved.
    const { projectRoot } = await setupMultiFileProject({
      detAspectId: 'det-samerr',
      detRule: DET_PASS, // overridden by mock
      files: ['src/a.ts', 'src/b.ts'],
    });
    const graph = await loadGraph(projectRoot);

    // Both units produce the SAME error (identical why/next → should collapse).
    mockRunStructureAspect.mockImplementation(async (): Promise<RunStructureAspectResult> => ({
      violations: [{ message: 'same-crash' }],
      touchedFiles: [],
      succeeded: false,
      observations: [],
      observationsTainted: false,
    }));

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    expect(result.runtimeErrors).toBe(2);

    // Still ONE grouped message (identical reasons → collapsed).
    const grouped = w.messages().filter(
      (m) => m.what.includes('aspect-check-runtime-error') && m.what.includes('det-samerr'),
    );
    expect(grouped).toHaveLength(1);
    // The single grouped message lists both units and the count.
    expect(grouped[0].what).toContain('2 units');
    expect(grouped[0].what).toContain('src/a.ts');
    expect(grouped[0].what).toContain('src/b.ts');
  });
});

// =============================================================================
// 4. Per-tier provider-unreachable (already aggregated) → ONE message (unchanged)
// =============================================================================

describe('provider-unreachable already aggregated', () => {
  it('N pairs sharing an unreachable provider → exactly one per-tier message', async () => {
    const { projectRoot } = await setupMultiFileProject({
      detAspectId: 'det-pass',
      detRule: DET_PASS,
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      extraAspects: [{
        id: 'llm-a',
        kind: 'llm',
        rule: 'rule content',
        scopePer: 'file',
      }],
    });
    const graph = await loadGraph(projectRoot);

    // Provider unavailable.
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      isAvailable: async () => false,
    }));

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    // 3 pairs all hit provider-unreachable.
    expect(result.infraFailures).toBe(3);

    // The per-tier provider-unreachable message should be emitted ONCE (already
    // aggregated at the tier level in fill.ts — behavior is unchanged).
    const providerMessages = w.messages().filter((m) =>
      m.what.includes('unreachable') || m.what.includes('Reviewer provider'),
    );
    expect(providerMessages).toHaveLength(1);
    expect(providerMessages[0].what).toContain('3 pair(s)');
  });
});
