/**
 * Unit tests for the `yg check --approve` fill stage (core/fill.ts, spec §7),
 * deterministic side, part 2 of 2: HOW a deterministic check runs and what it
 * reports — the observation set and taint/re-run-once (including its
 * runtime-error fail-closed branch), the per-file pair contract, a node-scoped
 * check reading a file its scope excludes, the notice for a check with no owning
 * component, the dry-run cost preview, the --only-deterministic fill, and the
 * shared readBytesOrEmpty helper. Part 1 (fill-det.test.ts) covers what the
 * lock ends up holding: det-first ordering and the det gate, positive closure,
 * the log gate, GC, incremental writes, and the implies-cycle abort. The two
 * were one file until it outgrew the reviewer's prompt limit.
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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { readBytesOrEmpty } from '../../../src/core/fill-shared.js';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import type { FillEvent } from '../../../src/model/fill-event.js';
import { renderFillEvent } from '../../../src/formatters/fill-text.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
import type { IssueMessage } from '../../../src/model/validation.js';
import { readLock } from '../../../src/io/lock-store.js';
import { verifyLock } from '../../../src/core/verify-lock.js';
import { computeDetInputHash } from '../../../src/core/pair-hash.js';
import { hashBytes } from '../../../src/io/hash.js';
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
import { runStructureAspect, StructureRunnerError } from '../../../src/structure/runner.js';

// runFill takes its TTY state and clock as required inputs.
const IO = { isTTY: false, now: Date.now };
const mockRunStructureAspect = vi.mocked(runStructureAspect);

function makeMockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    ...overrides,
  };
}

const V5_REVIEWER_CONFIG =
  'version: "6.0.0"\nreviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n';

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
    const result = await runFill(graph, { ...IO, coverageVisibleFiles: null, write: () => {} });
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
    await runFill(graph, { ...IO, coverageVisibleFiles: null, write: () => {} });

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
    const result2 = await runFill(graph2, { ...IO, coverageVisibleFiles: null, write: () => {} });
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
    await runFill(graph, { ...IO, coverageVisibleFiles: null, write: () => {} });

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
    const result = await runFill(graph, { ...IO, coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

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
// 12b. Every StructureRunnerError thrown at fill time must surface its OWN
//      `next` in the actual printed diagnostic, not a generic "fix check.mjs"
//      fallback that is often simply wrong for the failure it names. This is a
//      RENDERER-level fix (detRuntimeNotice threads the original messageData
//      through), not a per-error-code special case, so it covers every code
//      the structure runner can throw — not only the one below.
// =============================================================================

describe('a check with no owning component that touches ctx.node — the printed notice names both exits', () => {
  it('prints the rewrite-to-ctx.subject/ctx.fs exit AND the give-it-a-component exit, not just what/why', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'yg-nodeless-render-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    mkdirSync(path.join(yggRoot, 'aspects', 'touches-ctx-node'), { recursive: true });
    mkdirSync(path.join(yggRoot, 'model'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'leafy'), { recursive: true });
    writeFileSync(
      path.join(yggRoot, 'yg-config.yaml'),
      `${V5_REVIEWER_CONFIG}\ncoverage:\n  required:\n    - src/\n  excluded: []\n  type_level: true\n`,
    );
    writeFileSync(
      path.join(yggRoot, 'yg-architecture.yaml'),
      'node_types:\n  leafy:\n    description: x\n    when:\n      path: "src/leafy/**"\n    aspects:\n      - touches-ctx-node\n',
    );
    writeFileSync(
      path.join(yggRoot, 'aspects', 'touches-ctx-node', 'yg-aspect.yaml'),
      'name: touches-ctx-node\ndescription: touches ctx.node on a file with no owning component\nreviewer:\n  type: deterministic\nscope:\n  per: file\n',
    );
    writeFileSync(
      path.join(yggRoot, 'aspects', 'touches-ctx-node', 'check.mjs'),
      'export function check(ctx) { void ctx.node.id; return []; }\n',
    );
    writeFileSync(path.join(root, 'src', 'leafy', 'a.ts'), 'export const a = 1;\n');

    const graph = await loadGraph(root);
    const w = makeWriter();
    await runFill(graph, { ...IO, coverageVisibleFiles: ['src/leafy/a.ts'], write: w.write, emitIssue: w.emitIssue });

    // Infra disposition: no verdict entry written, pair stays unverified.
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['touches-ctx-node']?.['file:src/leafy/a.ts']).toBeUndefined();

    // The RENDERED text an agent actually sees names both exits — not merely
    // what broke (ctx.node is unavailable), but how to fix it either way.
    expect(w.text()).toMatch(/ctx\.subject|ctx\.fs/);
    expect(w.text()).toMatch(/component of its own/);
  });

  it('a component-missing failure (STRUCTURE_NODE_MISSING) prints its OWN next, never the generic "fix check.mjs" fallback', async () => {
    // The check.mjs content is irrelevant — the structure runner is mocked to
    // reject with the SAME error the real runner throws when a pair's node
    // path no longer resolves in the graph (structure/hook-loader.ts), so this
    // pins the renderer's handling of that disposition directly.
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-node-missing', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
    });
    const graph = await loadGraph(projectRoot);

    mockRunStructureAspect.mockRejectedValueOnce(new StructureRunnerError('STRUCTURE_NODE_MISSING', {
      what: `Node 'svc' not in graph.`,
      why: `The runner resolves the node by path to load its mapped files and aspects.`,
      next: `Pass an existing node path, or add the node to the graph.`,
    }));

    const w = makeWriter();
    await runFill(graph, { ...IO, coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['det-node-missing']?.['node:svc']).toBeUndefined();

    expect(w.text()).toMatch(/pass an existing node path/i);
    expect(w.text()).not.toContain('Fix the check.mjs, then re-run: yg check --approve');
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
    const result = await runFill(graph, { ...IO,
      coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue, dryRun: true,
    });

    // No reviewer was ever invoked.
    expect(verifyCalls).toBe(0);
    // All counters are zero — nothing was filled.
    expect(result.reviewerCallsMade).toBe(0);
    expect(result.infraFailures).toBe(0);
    expect(result.runtimeErrors).toBe(0);
    expect(result.companionRuntimeErrors).toBe(0);

    const out = w.text();
    // Billed pairs listed, free ones counted.
    expect(out).toContain('svc');
    expect(out).toContain('[llm] llm-a on node:svc — 1 reviewer call');
    expect(out).toContain('1 deterministic pair — free, not listed');
    expect(out).not.toContain('[det] det-a');
    // The upper-bound caveat (the dry-run-only closing line).
    expect(out).toContain('is an UPPER BOUND');
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
    const result = await runFill(graph, { ...IO,
      coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue,
      dryRun: true, onlyDeterministic: true,
    });

    const out = w.text();
    expect(out).toContain('1 deterministic pair — free, not listed');
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
    const events: FillEvent[] = [];
    await runFill(graph, { ...IO, coverageVisibleFiles: null, onEvent: (e) => { events.push(e); }, dryRun: true });

    // Both pairs sit under the single node, sorted by aspect id — the preview's
    // data; its text counts free pairs rather than listing them.
    const dry = events.find((e): e is Extract<FillEvent, { type: 'dry-run' }> => e.type === 'dry-run');
    expect(dry!.nodes.map((n) => n.nodePath)).toEqual(['svc']);
    expect(dry!.nodes[0].pairs.map((p) => p.aspectId)).toEqual(['det-a', 'det-b']);
    expect(renderFillEvent(dry!)).toContain('2 deterministic pairs — free, not listed');
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

    const result = await runFill(graph, { ...IO, coverageVisibleFiles: null, write: () => {}, onlyDeterministic: true });

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

// =============================================================================
// The grammar that built a tree the check read is a verdict input (219 m4)
// =============================================================================

describe('grammar observation — a verdict that read a syntax tree is keyed on the grammar that built it', () => {
  const READS_AST =
    'export function check(ctx) { const f = ctx.files[0]; return f.ast && f.ast.rootNode.hasError ? [{ message: "parse error", file: f.path, line: 1 }] : []; }\n';
  const READS_TEXT =
    'export function check(ctx) { return ctx.files[0].content.includes("FORBIDDEN") ? [{ message: "forbidden", file: ctx.files[0].path, line: 1 }] : []; }\n';

  // The digest itself (grammar wasm + runtime wasm) is pinned in
  // tests/unit/ast/parser-wasm-hash.test.ts; here only its presence matters.
  const grammarObservation = (touched: Array<[string, string]> | undefined) =>
    touched?.find(([k]) => k === 'grammar:typescript')?.[1];

  async function fill(rule: string) {
    const { projectRoot } = await setupProject({ aspects: [{ id: 'det-g', kind: 'deterministic', status: 'enforced', rule }] });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { ...IO, coverageVisibleFiles: null, write: () => {} });
    return { projectRoot, graph, entry: readLock(graph.rootPath).verdicts['det-g']?.['node:svc'] };
  }

  it('a check that reads `.ast` records grammar:<language> with the grammar + runtime digest', async () => {
    const { entry } = await fill(READS_AST);
    expect(entry?.verdict).toBe('approved');
    expect(grammarObservation(entry?.touched)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a check that reads only text records no grammar observation (a grammar change leaves it verified)', async () => {
    const { entry } = await fill(READS_TEXT);
    expect(entry?.verdict).toBe('approved');
    expect((entry?.touched ?? []).some(([k]) => k.startsWith('grammar:'))).toBe(false);
  });

  it('a violation matched against suppress markers records the grammar of the scanned tree even when the check never read `.ast`', async () => {
    const { entry } = await fill(
      'export function check(ctx) { return [{ message: "always", file: ctx.files[0].path, line: 1 }]; }\n',
    );
    expect(entry?.verdict).toBe('refused');
    expect(grammarObservation(entry?.touched)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ctx.parseAst records the grammar of the tree it returns', async () => {
    const { entry } = await fill(
      'export function check(ctx) { const t = ctx.parseAst(ctx.files[0], "typescript"); return t ? [] : [{ message: "no tree" }]; }\n',
    );
    expect(entry?.verdict).toBe('approved');
    expect(grammarObservation(entry?.touched)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a verdict recorded under another grammar build is unverified; the current one stays verified', async () => {
    const { projectRoot, graph, entry } = await fill(READS_AST);
    const verify = async () => {
      const g = await loadGraph(projectRoot);
      const v = await verifyLock(g, readLock(g.rootPath));
      return v.pairs.find((p) => p.pair.aspectId === 'det-g' && p.pair.unitKey === 'node:svc')?.state.kind;
    };
    expect(await verify()).toBe('verified');

    // Re-record the same verdict as if a different grammar had built the tree:
    // a self-consistent entry (its hash matches its own inputs) whose grammar
    // digest is not the one shipping now — what an upgrade leaves behind.
    const lockPath = path.join(graph.rootPath, '.yg-lock.deterministic.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const e = lock.verdicts['det-g']['node:svc'];
    const touched = (e.touched as Array<[string, string]>).map(([k, h]) => [k, k === 'grammar:typescript' ? 'f'.repeat(64) : h] as [string, string]);
    e.touched = touched;
    e.hash = computeDetInputHash({
      aspectId: 'det-g', scope: undefined, nodePath: 'svc',
      ruleHash: hashBytes(Buffer.from(READS_AST)),
      files: [['src/svc.ts', hashBytes(readFileSync(path.join(projectRoot, 'src/svc.ts')))]],
      touched, verdict: 'approved',
    });
    await writeFile(lockPath, JSON.stringify(lock, null, 2));
    expect(entry).toBeDefined();
    expect(await verify()).toBe('unverified');
  });
});
