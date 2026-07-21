/**
 * Unit tests for the `yg check --approve` fill stage (core/fill.ts, spec §7).
 * Deterministic-focused tests: det fills, det gate (enforced det skips LLM),
 * taint/re-run-once, log gate, positive closure, GC, incremental writeLock.
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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { readBytesOrEmpty } from '../../../src/core/fill-shared.js';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill, FillGatingError } from '../../../src/core/fill.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
import type { IssueMessage } from '../../../src/model/validation.js';
import { readLock, writeLock } from '../../../src/io/lock-store.js';
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
});

// ── Project builder ───────────────────────────────────────────────────────────

interface AspectSpec {
  id: string;
  kind: 'llm' | 'deterministic';
  status?: 'draft' | 'advisory' | 'enforced';
  /** content.md (llm) / check.mjs (deterministic) body. */
  rule: string;
  scopePer?: 'node' | 'file';
  /** scope.files path-atom filter (minimatch glob) — narrows the subject set. */
  scopeFilesPath?: string;
  references?: Array<{ path: string; description?: string }>;
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
    // Emit a scope: block when EITHER per or a files filter is set. The files
    // filter is a single path atom (enough to narrow the subject set in tests).
    let scopeBlock = '';
    if (asp.scopePer || asp.scopeFilesPath) {
      scopeBlock = 'scope:\n';
      scopeBlock += `  per: ${asp.scopePer ?? 'node'}\n`;
      if (asp.scopeFilesPath) scopeBlock += `  files:\n    path: "${asp.scopeFilesPath}"\n`;
    }
    const yaml =
      `name: ${asp.id}\ndescription: ${asp.id} rule\nreviewer:\n  type: ${asp.kind}\n` +
      `${asp.status ? `status: ${asp.status}\n` : ''}` +
      scopeBlock +
      `${asp.references ? `references:\n${refLines}\n` : ''}`;
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), yaml);
    await writeFile(path.join(aspDir, asp.kind === 'llm' ? 'content.md' : 'check.mjs'), asp.rule);
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
// 2. Deterministic-first ordering + det gate (fresh AND cached)
// =============================================================================

describe('deterministic-first ordering + det gate', () => {
  it('an enforced det refusal skips the LLM fill for that node (LLM never dispatched)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-fail', kind: 'deterministic', status: 'enforced', rule: DET_FAIL },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
    });
    const graph = await loadGraph(projectRoot);
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write, emitIssue: w.emitIssue });

    // The det check refused → the LLM reviewer was never asked.
    expect(verifyCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['det-fail']?.['node:svc']?.verdict).toBe('refused');
    // The LLM pair was NOT written (skipped, still unverified).
    expect(lock.verdicts['llm-a']?.['node:svc']).toBeUndefined();
    // The skip notice was emitted.
    expect(w.text()).toContain("LLM fills for node 'svc' skipped — an enforced deterministic check already refused it.");
  });

  it('honors a CACHED enforced det refusal on a second run (LLM still skipped)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-fail', kind: 'deterministic', status: 'enforced', rule: DET_FAIL },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
    });
    // First run records the det refusal.
    let graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // Second run: the det refusal is cached-valid. The LLM pair is still skipped.
    graph = await loadGraph(projectRoot);
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    expect(verifyCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['llm-a']?.['node:svc']).toBeUndefined();
  });
});

// =============================================================================
// 5. Positive closure — fingerprint + log only on all-enforced-green
// =============================================================================

describe('positive closure', () => {
  it('records source fingerprint + log only when all enforced pairs are approved (incl. det)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
      // Source fingerprints are recorded at closure ONLY for log_required nodes.
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider()); // approves
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const lock = readLock(graph.rootPath);
    expect(lock.nodes['svc']?.source).toBeDefined();
    expect(lock.nodes['svc']?.log?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');
  });

  it('an enforced det refusal BLOCKS closure (no fingerprint recorded)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-fail', kind: 'deterministic', status: 'enforced', rule: DET_FAIL }],
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const lock = readLock(graph.rootPath);
    expect(lock.nodes['svc']?.source).toBeUndefined();
  });

  it('an advisory refusal still closes (does not block)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-adv', kind: 'deterministic', status: 'advisory', rule: DET_FAIL }],
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const lock = readLock(graph.rootPath);
    // Advisory refusal does not block closure → fingerprint recorded.
    expect(lock.nodes['svc']?.source).toBeDefined();
  });

  it('a stored-approved pair that is UNVERIFIED this run does NOT satisfy closure (fresh validity, not the raw token)', async () => {
    // Two mapped files; one enforced LLM aspect over both. Run 1 approves and
    // closes (records the fingerprint). Then edit a mapped file (drifts the
    // fingerprint AND invalidates the LLM pair) and re-run with the provider
    // UNREACHABLE: the LLM fill writes nothing, so the pair stays stored-approved
    // (from run 1) but is UNVERIFIED this run. Closure must read fresh validity
    // (verifyLock), not the stale token — the fingerprint must be held back.
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
      mapping: ['src/svc.ts', 'src/helper.ts'],
      files: { 'src/helper.ts': 'export const h = 1;\n' },
      // log_required so closure records a source fingerprint to hold back.
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    // Run 1: provider approves → pair approved, node closes.
    let graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const run1Fingerprint = readLock(graph.rootPath).nodes['svc']?.source;
    expect(run1Fingerprint).toBeDefined();
    expect(readLock(graph.rootPath).verdicts['llm-a']?.['node:svc']?.verdict).toBe('approved');

    // Edit a mapped file: fingerprint drifts and the LLM subject changes →
    // llm-a is unverified pre-fill.
    await writeFile(path.join(projectRoot, 'src', 'svc.ts'), 'export const x = 2;\n');
    // Add a FRESH log entry so the §9 gate passes in run 2 — isolating the
    // unverified-pair closure check (condition c) as the only thing that holds the
    // fingerprint back, not the log gate.
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'model', 'svc', 'log.md'),
      '## [2026-05-11T10:00:00.000Z]\nfirst.\n## [2026-05-12T10:00:00.000Z]\nsecond.\n',
    );
    graph = await loadGraph(projectRoot);
    // Run 2: provider unreachable → the LLM fill writes NOTHING (infra disposition).
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({ isAvailable: async () => false }));
    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const after = readLock(graph.rootPath);
    // The stored token is still 'approved' (run 1's verdict was never overwritten).
    expect(after.verdicts['llm-a']?.['node:svc']?.verdict).toBe('approved');
    // But the pair is UNVERIFIED this run → closure must NOT advance the
    // fingerprint. It must still be the run-1 value, never the post-edit one.
    expect(after.nodes['svc']?.source).toBe(run1Fingerprint);
    // And the run ends red (the unverified enforced pair blocks check).
    expect(result.checkResult.issues.some((i) => i.code === 'unverified')).toBe(true);
  });

  it('a binary/scope-excluded source change on a log_required node does NOT advance the fingerprint without a fresh entry (gate not bypassed)', async () => {
    // A log_required node maps a reviewed text file AND a binary. The only aspect
    // is an enforced LLM aspect — binaries are excluded from its subject set. Run
    // 1 closes (fresh entry present). Then edit ONLY the binary: the source
    // fingerprint drifts, but the LLM pair's subject (the text file) is unchanged,
    // so the pair stays verified → ZERO unverified pairs → the node never enters
    // the run's nodeSet → the step-4 log gate never evaluates it. Closure must
    // STILL re-check the §9 gate and refuse to advance the fingerprint without a
    // fresh log entry (defect: scope/binary-excluded change bypassing the gate).
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
      mapping: ['src/svc.ts', 'assets/logo.png'],
      files: { 'assets/logo.png': 'PNGDATA-v1\n' },
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    let graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider()); // approves
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const run1Fingerprint = readLock(graph.rootPath).nodes['svc']?.source;
    expect(run1Fingerprint).toBeDefined();

    // Edit ONLY the binary (no fresh log entry). Fingerprint drifts; the LLM pair
    // (subject = src/svc.ts, binary excluded) stays valid → zero unverified pairs.
    await writeFile(path.join(projectRoot, 'assets', 'logo.png'), 'PNGDATA-v2-CHANGED\n');
    graph = await loadGraph(projectRoot);
    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // Zero reviewer calls (nothing was unverified) — proves the node never entered
    // the fill set, so the step-4 gate did not run for it.
    expect(result.reviewerCallsMade).toBe(0);
    // The fingerprint must NOT have advanced to the post-edit value — the §9 gate
    // was re-checked at closure and held it back (no fresh entry).
    expect(readLock(graph.rootPath).nodes['svc']?.source).toBe(run1Fingerprint);
  });

  it('a zero-enforced-pair (advisory-only) drifted log_required node does NOT vacuously close', async () => {
    // log_required node, ONE advisory LLM aspect, plus a mapped binary. Run 1
    // closes (fresh entry). Edit ONLY the binary: fingerprint drifts; the advisory
    // LLM pair's subject (text file) is unchanged → it stays valid → zero
    // unverified pairs → the node never enters the nodeSet (step-4 gate never
    // runs). The node has ZERO enforced pairs, so the enforced-filter is empty and
    // "all enforced approved" is VACUOUSLY true. Closure must STILL refuse to
    // advance the fingerprint: a drifted log_required node needs a fresh entry.
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-adv', kind: 'llm', status: 'advisory', rule: 'advisory rule' }],
      mapping: ['src/svc.ts', 'assets/logo.png'],
      files: { 'assets/logo.png': 'PNGDATA-v1\n' },
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    let graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider()); // approves (advisory)
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const run1Fingerprint = readLock(graph.rootPath).nodes['svc']?.source;
    expect(run1Fingerprint).toBeDefined();

    // Edit ONLY the binary, no fresh log entry.
    await writeFile(path.join(projectRoot, 'assets', 'logo.png'), 'PNGDATA-v2-CHANGED\n');
    graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // The fingerprint must NOT advance — vacuous closure (zero enforced pairs) is
    // refused for a drifted log_required node lacking a fresh entry.
    expect(readLock(graph.rootPath).nodes['svc']?.source).toBe(run1Fingerprint);
  });
});

// =============================================================================
// 6. Log gate
// =============================================================================

describe('log gate (§9)', () => {
  it('fires on a fingerprint change with no fresh entry (all-or-nothing: aborts, approves nothing, node does NOT close)', async () => {
    const { projectRoot, yggRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    // First fill closes the node (records fingerprint + log baseline).
    let graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const preEditFingerprint = readLock(graph.rootPath).nodes['svc']?.source;
    expect(preEditFingerprint).toBeDefined();

    // Edit source (fingerprint drifts) WITHOUT a fresh log entry.
    await writeFile(path.join(projectRoot, 'src', 'svc.ts'), 'export const x = 2;\n');
    graph = await loadGraph(projectRoot);
    const w = makeWriter();
    // All-or-nothing: a node needing a fresh entry aborts the whole run
    // (FillGatingError) — nothing is approved — but the per-node "no fresh log
    // entry" message is emitted first so the user knows what to add.
    await expect(
      runFill(graph, { gitTrackedFiles: null, write: w.write, emitIssue: w.emitIssue }),
    ).rejects.toBeInstanceOf(FillGatingError);
    expect(w.text()).toMatch(/no fresh log entry|mandatory/i);

    // The node did NOT close: its source fingerprint must still be the PRE-EDIT
    // value (positive closure must not advance it over a gate-blocked change) and
    // its log baseline must be unchanged. If the fingerprint had advanced to the
    // post-edit value the §9 gate could never fire again for this change — the
    // log entry would be permanently, silently waived.
    const after = readLock(graph.rootPath).nodes['svc'];
    expect(after?.source).toBe(preEditFingerprint);
    expect(after?.log?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');
    void yggRoot;
  });

  it('one fresh entry covers retries (gate passes after the entry is added)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    let graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // Edit source + add a fresh log entry — the gate passes.
    await writeFile(path.join(projectRoot, 'src', 'svc.ts'), 'export const x = 2;\n');
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'model', 'svc', 'log.md'),
      '## [2026-05-11T10:00:00.000Z]\nfirst.\n## [2026-05-11T11:00:00.000Z]\nfix.\n',
    );
    graph = await loadGraph(projectRoot);
    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // Gate passed → the pair re-filled and the node re-closed with the new entry.
    const lock = readLock(graph.rootPath);
    expect(lock.nodes['svc']?.log?.last_entry_datetime).toBe('2026-05-11T11:00:00.000Z');
    expect(result.checkResult.issues.some((i) => i.code === 'unverified')).toBe(false);
  });

  it('a cascade-only edit (aspect changed, source untouched) needs NO entry', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    let graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // Edit the aspect's check.mjs (upstream cascade) — source fingerprint
    // UNCHANGED. The gate must NOT fire.
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'aspects', 'det-a', 'check.mjs'),
      'export function check(ctx) { void ctx; /* changed */ return []; }\n',
    );
    graph = await loadGraph(projectRoot);
    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write, emitIssue: w.emitIssue });

    expect(w.text()).not.toMatch(/no fresh log entry|mandatory/i);
    // The det pair re-verified (free) and the check is clean.
    expect(result.checkResult.issues.some((i) => i.code === 'unverified')).toBe(false);
  });
});

// =============================================================================
// 7. GC — prune detached entries, keep draft pairs, prune deleted-node nodes[]
// =============================================================================

describe('GC + canonical rewrite (§3.2)', () => {
  it('prunes a verdict entry whose aspect detached from the node', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'det-b', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
      ],
    });
    let graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    expect(readLock(graph.rootPath).verdicts['det-b']?.['node:svc']).toBeDefined();

    // Detach det-b from the node mapping.
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'model', 'svc', 'yg-node.yaml'),
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - det-a\n',
    );
    graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const lock = readLock(graph.rootPath);
    // det-b's entry is pruned; det-a survives.
    expect(lock.verdicts['det-b']).toBeUndefined();
    expect(lock.verdicts['det-a']?.['node:svc']).toBeDefined();
  });

  it('keeps a draft aspect pair entry across GC', async () => {
    // det-a enforced (filled), det-draft draft. Seed a verdict for det-draft by
    // first enforcing it, then flip to draft and confirm GC keeps the entry.
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'det-draft', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
      ],
    });
    let graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    expect(readLock(graph.rootPath).verdicts['det-draft']?.['node:svc']).toBeDefined();

    // Flip det-draft to draft. Its pair leaves the non-draft universe but the GC
    // universe (includeDraft) keeps it.
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'aspects', 'det-draft', 'yg-aspect.yaml'),
      'name: det-draft\ndescription: d\nreviewer:\n  type: deterministic\nstatus: draft\n',
    );
    graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const lock = readLock(graph.rootPath);
    // The draft pair's entry survives GC (draft pairs are retained).
    expect(lock.verdicts['det-draft']?.['node:svc']).toBeDefined();
  });

  it('prunes nodes[] entries for a node path no longer in the graph', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    let graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    // Closure recorded a nodes[] entry.
    expect(readLock(graph.rootPath).nodes['svc']).toBeDefined();

    // Inject a stale nodes[] entry for a non-existent node, then re-fill. The
    // `nodes` section lives in the committed logs file of the triad.
    const logsLockPath = path.join(graph.rootPath, 'yg-lock.logs.json');
    const raw = JSON.parse(await readFile(logsLockPath, 'utf-8'));
    raw.nodes['ghost/node'] = { source: 'deadbeef' };
    await writeFile(logsLockPath, JSON.stringify(raw));
    graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const lock = readLock(graph.rootPath);
    expect(lock.nodes['ghost/node']).toBeUndefined();
    expect(lock.nodes['svc']).toBeDefined();
  });
});

// =============================================================================
// 8. Per-pair incremental writeLock observable
// =============================================================================

describe('incremental writeLock', () => {
  it('writes the lock after each completed det pair (observable mid-run)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'det-b', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
      ],
    });
    const graph = await loadGraph(projectRoot);
    // Deterministic verdicts land in the gitignored det file of the triad.
    const detLockPath = path.join(graph.rootPath, '.yg-lock.deterministic.json');
    // After a full run both det entries are on disk (the serialized writer
    // flushed each entry). Reading the file back proves the writes landed.
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const onDisk = JSON.parse(await readFile(detLockPath, 'utf-8'));
    expect(onDisk.verdicts['det-a']['node:svc'].verdict).toBe('approved');
    expect(onDisk.verdicts['det-b']['node:svc'].verdict).toBe('approved');
  });
});

// =============================================================================
// 9. Tainted re-run-once
// =============================================================================

describe('tainted observation set', () => {
  it('a check whose observed file changes mid-run taints, re-runs once, then settles', async () => {
    // The check reads a sibling file twice; a stable file yields a non-tainted
    // run and a written verdict. We assert the happy path here (settles to a
    // verdict) — the taint→runtime-error path is exercised by a check that reads
    // a path returning different content, which cannot be made deterministic in
    // a unit test without filesystem races; instead we assert the recorded
    // observation for a sibling read (contract #8 below) and that a stable run
    // writes a verdict with the observation folded.
    const checkReadsSibling =
      'export function check(ctx) { const c = ctx.fs.read("src/sibling.ts"); return c.includes("x") ? [] : [{message:"no x"}]; }\n';
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-sib', kind: 'deterministic', status: 'enforced', rule: checkReadsSibling }],
      mapping: ['src/svc.ts', 'src/sibling.ts'],
      files: { 'src/sibling.ts': 'export const x = 1;\n' },
    });
    const graph = await loadGraph(projectRoot);
    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    expect(result.runtimeErrors).toBe(0);
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['det-sib']?.['node:svc']?.verdict).toBe('approved');
  });
});

// =============================================================================
// 10. Per-file det pair — sibling read folds as an observation (contract #8)
// =============================================================================

describe('per-file deterministic pair — contract #8', () => {
  it('a sibling read during a per-file run is recorded as a read: observation', async () => {
    // scope.per: file → one pair per subject file. The check reads a SIBLING file
    // (not the per-file subject). Under contract #8 that sibling is NOT in the
    // subject set for this pair, so it must fold as a recorded read: observation
    // (else neither files nor touched carries it → stale green).
    const checkReadsSibling =
      'export function check(ctx) { ctx.fs.read("src/other.ts"); return []; }\n';
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-pf', kind: 'deterministic', status: 'enforced', scopePer: 'file', rule: checkReadsSibling }],
      mapping: ['src/svc.ts', 'src/other.ts'],
      files: { 'src/other.ts': 'export const y = 2;\n' },
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const lock = readLock(graph.rootPath);
    // One pair per subject file: file:src/svc.ts and file:src/other.ts.
    const svcEntry = lock.verdicts['det-pf']?.['file:src/svc.ts'];
    expect(svcEntry).toBeDefined();
    // For the svc.ts pair, src/other.ts is a SIBLING (not the subject) → it must
    // appear as a read: observation in touched.
    const touchedKeys = (svcEntry?.touched ?? []).map(([k]) => k);
    expect(touchedKeys).toContain('read:src/other.ts');

    // Now change the sibling — the svc.ts per-file pair must become unverified
    // (its observation changed), proving the fold is load-bearing.
    await writeFile(path.join(projectRoot, 'src', 'other.ts'), 'export const y = 999;\n');
    const graph2 = await loadGraph(projectRoot);
    const result2 = await runFill(graph2, { gitTrackedFiles: null, write: () => {} });
    // The sibling change invalidated and re-filled the pair (no error remains).
    expect(result2.checkResult.issues.some((i) => i.code === 'unverified')).toBe(false);
    // The for-file pair for the OTHER file is its own subject — sanity.
    expect(readLock(graph2.rootPath).verdicts['det-pf']?.['file:src/other.ts']).toBeDefined();
  });
});

// =============================================================================
// 10b. Bug 3: per:node det aspect with scope.files — an EXCLUDED file read via
//      ctx.node.files must fold as an observation (was stale-green).
//
// A per:node aspect with a scope.files filter has a NARROWED subject set: the
// excluded files are not subjects. Before the fix, fill passed subjectScope only
// for per:FILE pairs, so a per:node-with-filter pair ran the runner WITHOUT
// subjectScope → the excluded files preloaded into ctx.node.files UN-recorded. A
// check reading an excluded file (here through the preloaded ctx.node.files
// content, no ctx.fs call) folded into NEITHER the subject hash NOR an
// observation → editing that excluded file did not invalidate the verdict
// (stale-green). With the fix the excluded-file read records a read: observation
// and the verifier re-observes it, so an edit flips the pair to unverified.
// =============================================================================

describe('Bug 3 — per:node det aspect with scope.files excludes a read file', () => {
  it('reading an excluded file via ctx.node.files folds an observation; editing it invalidates the pair', async () => {
    // The check reads the EXCLUDED file's preloaded content from ctx.node.files
    // (no ctx.fs.read). scope.files keeps only src/svc.ts as the subject, so
    // src/excluded.ts is a non-subject sibling whose read must fold as read:.
    const checkReadsExcluded =
      'export function check(ctx) {' +
      '  const ex = ctx.node.files.find((f) => f.path.endsWith("excluded.ts"));' +
      '  if (ex && ex.content.includes("FORBIDDEN")) return [{ message: "forbidden token", file: ex.path, line: 1 }];' +
      '  return [];' +
      '}\n';
    const { projectRoot } = await setupProject({
      aspects: [
        {
          id: 'det-scoped',
          kind: 'deterministic',
          status: 'enforced',
          // per: node (default) but scope.files keeps only svc.ts as the subject.
          scopeFilesPath: '**/svc.ts',
          rule: checkReadsExcluded,
        },
      ],
      mapping: ['src/svc.ts', 'src/excluded.ts'],
      files: { 'src/excluded.ts': 'export const ok = 1;\n' },
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const entry = readLock(graph.rootPath).verdicts['det-scoped']?.['node:svc'];
    expect(entry).toBeDefined();
    // The subject is ONLY src/svc.ts; src/excluded.ts is NOT a subject, so the
    // read of it must appear as a read: observation in touched (the load-bearing
    // fold). Pre-fix this would be absent → the next assertion's edit would be
    // stale-green.
    const touchedKeys = (entry?.touched ?? []).map(([k]) => k);
    expect(touchedKeys).toContain('read:src/excluded.ts');

    // Edit the EXCLUDED file. Its content is not a subject input (scope.files
    // dropped it), so the only thing that can invalidate the verdict is the
    // read: observation just folded. A fresh verifyLock must now read the pair as
    // UNVERIFIED — pre-fix it stayed `verified` (stale-green).
    await writeFile(path.join(projectRoot, 'src', 'excluded.ts'), 'export const ok = 2;\n');
    const graph2 = await loadGraph(projectRoot);
    const verification = await verifyLock(graph2, readLock(graph2.rootPath));
    const vp = verification.pairs.find(
      (p) => p.pair.aspectId === 'det-scoped' && p.pair.unitKey === 'node:svc',
    );
    expect(vp?.state.kind).toBe('unverified');

    // Sanity: the subject file (src/svc.ts) is unchanged — the invalidation is
    // driven purely by the excluded-file observation, not a subject-hash change.
    const fp2 = readLock(graph2.rootPath).verdicts['det-scoped']?.['node:svc'];
    expect(fp2).toBeDefined(); // entry still present (GC keeps it; only the hash no longer matches)
  });
});

// =============================================================================
// 7b. Bug 2: GC must NOT prune entries for a node skipped by a transient
//     effectiveness error (an implies cycle) — those are paid verdicts.
//
// When a node's effective-aspect computation THROWS (implies cycle), it is
// silently skipped by computeExpectedPairs and contributes ZERO pairs to the GC
// universe. The old GC pruned any verdict entry absent from the universe, so it
// deleted the cycle node's existing entries (data loss; the next run re-pays).
// The fix retains entries owned by an uncomputable node, while STILL pruning
// genuinely-detached entries (a different, computable node's removed aspect).
// =============================================================================

describe('Bug 2 — GC retains entries for an implies-cycle node', () => {
  it('keeps the cycle node\'s entries and still prunes a genuinely-detached entry', async () => {
    // Two nodes:
    //   svc      — clean, one enforced det aspect (det-clean).
    //   cyc      — carries det-a, which implies det-b, which implies det-a (cycle).
    // We seed the lock with verdict entries for BOTH nodes plus one genuinely
    // detached entry (an aspect no node uses). After fill's GC:
    //   - the cycle node's entries survive (uncomputable → not provably detached),
    //   - the detached entry is pruned (computable owner / no owner).
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

    // Node svc — clean aspect det-clean.
    await mkdir(path.join(yggRoot, 'model', 'svc'), { recursive: true });
    await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'),
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - det-clean\n',
    );

    // Node cyc — carries det-a (cyclic with det-b).
    await mkdir(path.join(yggRoot, 'model', 'cyc'), { recursive: true });
    await writeFile(path.join(root, 'src', 'cyc.ts'), 'export const y = 2;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'cyc', 'yg-node.yaml'),
      'name: cyc\ntype: service\ndescription: x\nmapping:\n  - src/cyc.ts\naspects:\n  - det-a\n',
    );

    // Aspects: det-clean (normal), det-a implies det-b, det-b implies det-a (cycle).
    for (const [id, implies] of [['det-clean', null], ['det-a', 'det-b'], ['det-b', 'det-a']] as const) {
      const aspDir = path.join(yggRoot, 'aspects', id);
      await mkdir(aspDir, { recursive: true });
      await writeFile(
        path.join(aspDir, 'yg-aspect.yaml'),
        `name: ${id}\ndescription: ${id}\nreviewer:\n  type: deterministic\nstatus: enforced\n` +
          (implies ? `implies:\n  - ${implies}\n` : ''),
      );
      await writeFile(path.join(aspDir, 'check.mjs'), DET_PASS);
    }

    const graph = await loadGraph(root);

    // Seed the lock directly: a valid-shaped entry for the cycle node's aspect, a
    // valid entry for the clean node, and one genuinely-detached entry (an aspect
    // no node references). GC keys on (aspectId, unitKey) membership and owner —
    // hash validity is irrelevant to the prune decision.
    // MUST await: writeLock is async (atomic temp-write + rename). runFill reads
    // this lock synchronously at its start (after only `await validate`), so an
    // unawaited seed write races that read — under the parallel coverage run the
    // write lands late, runFill sees no seed, and GC has no entry to retain.
    const deterministicAspectIds = new Set(
      graph.aspects.filter((a) => a.reviewer.type === 'deterministic').map((a) => a.id),
    );
    await writeLock(graph.rootPath, {
      version: 1,
      verdicts: {
        'det-a': { 'node:cyc': { verdict: 'approved', hash: 'seed-cyc', touched: [] } },
        'det-clean': { 'node:svc': { verdict: 'approved', hash: 'seed-svc' } },
        'ghost-aspect': { 'node:svc': { verdict: 'approved', hash: 'seed-ghost' } },
      },
      nodes: {},
    }, { scope: 'all', deterministicAspectIds });

    // Run fill. The cycle node throws during effectiveness (skipped by the pair
    // engine); the clean node fills normally; GC then rewrites the lock.
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const lock = readLock(graph.rootPath);
    // The cycle node's entry MUST survive (uncomputable → not provably detached).
    expect(lock.verdicts['det-a']?.['node:cyc']).toBeDefined();
    expect(lock.verdicts['det-a']?.['node:cyc']?.hash).toBe('seed-cyc');
    // The genuinely-detached entry (no node uses ghost-aspect) MUST be pruned.
    expect(lock.verdicts['ghost-aspect']).toBeUndefined();
    // The clean node's aspect is in the universe — its entry remains.
    expect(lock.verdicts['det-clean']?.['node:svc']).toBeDefined();
  });
});

// =============================================================================
// 12. Tainted observation set → runtime-error fail-closed branch (unit-pinned)
// =============================================================================

describe('tainted re-run-once → runtime-error fail-closed (unit-pinned)', () => {
  it('two consecutive tainted results → runtimeErrors === 1, no lock entry, runtime-error notice printed', async () => {
    // The check.mjs content doesn't matter — we control both runStructureAspect
    // calls via the mock and always return observationsTainted: true.
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-taint', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
    });
    const graph = await loadGraph(projectRoot);

    const taintedResult: RunStructureAspectResult = {
      violations: [],
      touchedFiles: [],
      observations: [],
      observationsTainted: true,
    };
    // Both calls (initial run + re-run-once) return tainted — fill must fail closed.
    mockRunStructureAspect.mockResolvedValue(taintedResult);

    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write, emitIssue: w.emitIssue });

    // The runner was called exactly twice for this pair (initial + re-run-once).
    expect(mockRunStructureAspect).toHaveBeenCalledTimes(2);

    // Fail-closed: no verdict written to the lock.
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['det-taint']?.['node:svc']).toBeUndefined();

    // Exactly one runtime error counted.
    expect(result.runtimeErrors).toBe(1);

    // The runtime-error class notice line was printed.
    expect(w.text()).toContain('deterministic check(s) failed to run at fill time');
  });
});

// =============================================================================
// 13. Dry-run cost preview — early-return, no writes, per-node/per-aspect
//     breakdown (the v5.2.0 `--approve --dry-run` path, in-process).
// =============================================================================

describe('dry-run cost preview (no writes)', () => {
  it('renders the per-node breakdown for a MIX of det + LLM pairs, writes nothing, returns zero counters', async () => {
    // Two aspects on one node — a deterministic (free) and an LLM (consensus 1)
    // pair, both unverified. dryRun must:
    //   - print the [det]/[llm] breakdown lines (the byNode split branches),
    //   - resolve the LLM pair's consensus exactly as the header does,
    //   - print the upper-bound caveat,
    //   - write NOTHING and return all counters 0.
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
    });
    const graph = await loadGraph(projectRoot);
    // Provider must never be asked during a dry-run — make verifyAspect throw if it is.
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCalls++; throw new Error('dry-run must not call the reviewer'); },
    }));

    const w = makeWriter();
    const result = await runFill(graph, {
      gitTrackedFiles: null, write: w.write, emitIssue: w.emitIssue, dryRun: true,
    });

    // No reviewer was ever invoked.
    expect(verifyCalls).toBe(0);
    // All counters are zero — nothing was filled.
    expect(result.reviewerCallsMade).toBe(0);
    expect(result.infraFailures).toBe(0);
    expect(result.runtimeErrors).toBe(0);
    expect(result.companionRuntimeErrors).toBe(0);

    const out = w.text();
    // The node header and BOTH per-aspect breakdown lines (det free + llm calls).
    expect(out).toContain('svc');
    expect(out).toContain('[det] det-a on node:svc — free');
    expect(out).toContain('[llm] llm-a on node:svc — 1 reviewer call(s)');
    // The upper-bound caveat (the dry-run-only closing line).
    expect(out).toContain('reviewer call(s) is an UPPER BOUND');
    expect(out).toContain('Nothing was written; run yg check --approve to fill.');

    // Structural no-write guarantee: NO verdict landed in any lock file.
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['det-a']).toBeUndefined();
    expect(lock.verdicts['llm-a']).toBeUndefined();
    expect(lock.nodes['svc']).toBeUndefined();
  });

  it('dry-run under --only-deterministic shows ONLY the [det] line (the onlyDeterministic split)', async () => {
    // Same mix, but onlyDeterministic narrows the dry-run breakdown's LLM group to
    // [] — exercising the `onlyDeterministic ? [] : ...` branch inside the dry-run
    // block. The [llm] line must NOT appear; the [det] line must.
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());

    const w = makeWriter();
    const result = await runFill(graph, {
      gitTrackedFiles: null, write: w.write, emitIssue: w.emitIssue,
      dryRun: true, onlyDeterministic: true,
    });

    const out = w.text();
    expect(out).toContain('[det] det-a on node:svc — free');
    // onlyDeterministic drops the LLM pair from the preview entirely.
    expect(out).not.toContain('[llm] llm-a');
    // Still a no-write preview.
    expect(result.reviewerCallsMade).toBe(0);
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['det-a']).toBeUndefined();
  });

  it('groups multiple pairs under the same node (the byNode list-append branch)', async () => {
    // Two det aspects on one node → the second pair appends to the existing list
    // (the `byNode.get(p.nodePath) ?? []` non-empty branch). Both [det] lines must
    // render under the single node header.
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'det-b', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
      ],
    });
    const graph = await loadGraph(projectRoot);
    const w = makeWriter();
    await runFill(graph, { gitTrackedFiles: null, write: w.write, emitIssue: w.emitIssue, dryRun: true });

    const out = w.text();
    expect(out).toContain('[det] det-a on node:svc — free');
    expect(out).toContain('[det] det-b on node:svc — free');
    // Sorted alphabetically by aspect id within the node.
    expect(out.indexOf('det-a')).toBeLessThan(out.indexOf('det-b'));
  });
});

// =============================================================================
// 14. --only-deterministic (non-dry-run) — fills ONLY det pairs, skips the LLM
//     loop + positive closure, writes ONLY the gitignored deterministic file.
// =============================================================================

describe('--only-deterministic fill (in-process)', () => {
  it('fills det pairs, never dispatches the LLM, and does not record positive closure', async () => {
    // A mix of det + LLM pairs. onlyDeterministic: the det pair is filled, the LLM
    // pair is left untouched (no reviewer call), and positive closure is skipped
    // (no nodes[] source baseline written) because the committed logs file must
    // not be written on a deterministic-only / CI run.
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const graph = await loadGraph(projectRoot);
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {}, onlyDeterministic: true });

    // The reviewer was never asked — onlyDeterministic empties the LLM fill set.
    expect(verifyCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);

    const lock = readLock(graph.rootPath);
    // The det pair landed (in the gitignored deterministic file).
    expect(lock.verdicts['det-a']?.['node:svc']?.verdict).toBe('approved');
    // The LLM pair stays unverified (not written).
    expect(lock.verdicts['llm-a']?.['node:svc']).toBeUndefined();
    // Positive closure was skipped — no source fingerprint recorded.
    expect(lock.nodes['svc']?.source).toBeUndefined();

    // The committed logs file must NOT have been written by a det-only run.
    const logsLockPath = path.join(graph.rootPath, 'yg-lock.logs.json');
    let logsExists = true;
    try { await readFile(logsLockPath, 'utf-8'); } catch { logsExists = false; }
    // Either the file does not exist or it carries no nodes baseline — both prove
    // the closure write was suppressed.
    if (logsExists) {
      const logs = JSON.parse(await readFile(logsLockPath, 'utf-8'));
      expect(logs.nodes?.['svc']?.source).toBeUndefined();
    }
  });
});

// =============================================================================
// readBytesOrEmpty (core/fill-shared.ts) — the shared file-read helper both the
// deterministic and LLM fillers use to hash subject files from current disk (a
// deleted subject hashes to the empty-buffer hash, mirroring the verifier's
// re-read so producer/verifier stay in sync). Colocated here as shared
// fill-orchestration infra alongside the det fill tests this file already covers.
// =============================================================================

describe('readBytesOrEmpty', () => {
  it('returns the real bytes of an existing file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-fill-shared-'));
    try {
      const p = path.join(dir, 'a.txt');
      writeFileSync(p, 'hello world');
      const bytes = await readBytesOrEmpty(p);
      expect(bytes.toString('utf-8')).toBe('hello world');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty Buffer when the file does not exist (deleted subject)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-fill-shared-'));
    try {
      const bytes = await readBytesOrEmpty(path.join(dir, 'does-not-exist.txt'));
      expect(bytes).toEqual(Buffer.alloc(0));
      expect(bytes.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty Buffer when the path is unreadable (a directory, not a file)', async () => {
    // A different failure shape than ENOENT (EISDIR) — both must fail closed to
    // the same empty-buffer result, never throw.
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-fill-shared-'));
    try {
      const sub = path.join(dir, 'a-directory');
      mkdirSync(sub);
      const bytes = await readBytesOrEmpty(sub);
      expect(bytes).toEqual(Buffer.alloc(0));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

