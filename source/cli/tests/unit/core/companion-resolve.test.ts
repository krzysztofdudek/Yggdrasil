/**
 * Unit tests for resolveCompanionDescriptors (core/companion-resolve.ts).
 *
 * Three focused cases:
 *   1. Happy path — descriptors → companions with correct paths, labels, content
 *   2. Subject-dedupe — a path that matches a unit subject file is silently dropped
 *   3. Outside-allowed-reads — returns { kind: 'infra' } with the rich NEXT message
 *      (contains the relation source node path and, when mapped, the owner node path)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

import { resolveCompanionDescriptors, companionOutsideAllowedReads, resolveCompanionsForPair } from '../../../src/core/companion-resolve.js';
import type { Graph, AspectDef } from '../../../src/model/graph.js';
import type { ExpectedPair } from '../../../src/core/pairs.js';
import { NO_COVERAGE_EXCLUDED, type GraphExclusionSet } from '../../../src/io/repo-scanner.js';

/** No exclusion in effect — the shape every existing (pre-exclusion-aware) test in this
 *  file passes so `companionOutsideAllowedReads`'s original owner-lookup behavior is
 *  unaffected by the new exclusion check ahead of it. */
const NO_EXCLUSION: GraphExclusionSet = { nestedRoots: new Set(), coverage: NO_COVERAGE_EXCLUDED };

// ── Mock runCompanionHook — control the exact sequence of hook results across
// the A6 taint-guard's two possible calls (resolveCompanionsForPair only). ──
vi.mock('../../../src/structure/hook-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/structure/hook-loader.js')>();
  return {
    ...actual,
    runCompanionHook: vi.fn(),
  };
});
import { runCompanionHook } from '../../../src/structure/hook-loader.js';
const mockRunCompanionHook = vi.mocked(runCompanionHook);

// ── Mock readFileBytes so we don't hit real disk in the allowed-reads tests ───
vi.mock('../../../src/io/graph-fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/io/graph-fs.js')>();
  return {
    ...actual,
    readFileBytes: vi.fn(),
  };
});
import { readFileBytes } from '../../../src/io/graph-fs.js';
const mockReadFileBytes = vi.mocked(readFileBytes);

// ── Mock collectAllowedReadsForAspect — control what is allowed per test ─────
vi.mock('../../../src/structure/allowed-reads.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/structure/allowed-reads.js')>();
  return {
    ...actual,
    collectAllowedReadsForAspect: vi.fn(),
  };
});
import { collectAllowedReadsForAspect } from '../../../src/structure/allowed-reads.js';
const mockCollectAllowedReads = vi.mocked(collectAllowedReadsForAspect);

// ── Mock resolveAllowedReadPath — control guard pass/fail per test ────────────
vi.mock('../../../src/structure/ctx-fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/structure/ctx-fs.js')>();
  return {
    ...actual,
    resolveAllowedReadPath: vi.fn(),
  };
});
import { resolveAllowedReadPath } from '../../../src/structure/ctx-fs.js';
const mockResolveAllowedReadPath = vi.mocked(resolveAllowedReadPath);

// ── Minimal graph / aspect / pair factories ───────────────────────────────────

function makeGraph(extra?: Partial<Graph>): Graph {
  const nodes = new Map<string, import('../../../src/model/graph.js').GraphNode>();
  return {
    rootPath: '/project',
    nodes,
    aspects: [],
    flows: [],
    config: {} as Graph['config'],
    ...extra,
  } as unknown as Graph;
}

function makeAspect(id = 'my-aspect'): AspectDef {
  return {
    id,
    name: id,
    description: 'test aspect',
    reviewer: { type: 'llm' },
    hasCompanion: true,
  } as unknown as AspectDef;
}

function makePair(overrides?: Partial<Pick<ExpectedPair, 'nodePath' | 'subjectFiles' | 'unitKey'>>): Pick<ExpectedPair, 'nodePath' | 'subjectFiles' | 'unitKey'> {
  return {
    nodePath: 'svc',
    subjectFiles: ['src/svc.ts'],
    unitKey: 'node:svc',
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
  vi.resetAllMocks();
});

// =============================================================================
// 1. Happy path
// =============================================================================

describe('resolveCompanionDescriptors — happy path', () => {
  it('returns companions with correct paths, labels, and content', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-cr-'));
    dirs.push(root);

    // companion file at repo-relative 'lib/helper.ts'
    await mkdir(path.join(root, 'lib'), { recursive: true });
    await writeFile(path.join(root, 'lib', 'helper.ts'), 'export const x = 1;');

    const companionBytes = Buffer.from('export const x = 1;');

    // allowed-reads guard: pass through
    mockCollectAllowedReads.mockReturnValue(new Set(['lib/helper.ts']));
    mockResolveAllowedReadPath.mockReturnValue(path.join(root, 'lib', 'helper.ts'));
    mockReadFileBytes.mockResolvedValue(companionBytes);

    const descriptors = [{ path: 'lib/helper.ts', label: 'my-helper' }];
    const hookObs: Array<[string, string]> = [];

    const result = await resolveCompanionDescriptors(
      makeGraph(),
      root,
      makePair(),
      makeAspect(),
      descriptors,
      hookObs,
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.companions).toHaveLength(1);
    expect(result.companions[0].path).toBe('lib/helper.ts');
    expect(result.companions[0].label).toBe('my-helper');
    expect(result.companions[0].content).toBe('export const x = 1;');
    // observations should contain a read: entry for the companion
    expect(result.observations.some(([k]) => k.includes('lib/helper.ts'))).toBe(true);
  });

  it('sorts multiple companion paths and keeps the FIRST-seen label for a duplicate descriptor', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-cr-'));
    dirs.push(root);
    await mkdir(path.join(root, 'lib'), { recursive: true });
    await writeFile(path.join(root, 'lib', 'a.ts'), 'export const a = 1;');
    await writeFile(path.join(root, 'lib', 'm.ts'), 'export const m = 1;');
    await writeFile(path.join(root, 'lib', 'z.ts'), 'export const z = 1;');

    mockCollectAllowedReads.mockReturnValue(new Set(['lib/a.ts', 'lib/m.ts', 'lib/z.ts']));
    mockResolveAllowedReadPath.mockImplementation(() => 'ignored'); // return value unused; only "does it throw" matters
    mockReadFileBytes.mockImplementation(async (abs: string) => Buffer.from(`content:${path.basename(abs)}`));

    // Deliberately unsorted input (m, a, z) so the sort comparator is exercised in
    // BOTH directions (a before m, and z after m) rather than a single pre-sorted
    // pass. A duplicate descriptor for 'lib/a.ts' with a SECOND label must not
    // overwrite the first-seen label (label lookup is first-wins).
    const descriptors = [
      { path: 'lib/m.ts', label: 'em' },
      { path: 'lib/a.ts', label: 'first' },
      { path: 'lib/a.ts', label: 'second' },
      { path: 'lib/z.ts', label: 'zed' },
    ];

    const result = await resolveCompanionDescriptors(makeGraph(), root, makePair(), makeAspect(), descriptors, []);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.companions.map((c) => c.path)).toEqual(['lib/a.ts', 'lib/m.ts', 'lib/z.ts']); // sorted
    expect(result.companions[0].label).toBe('first'); // first-wins, not overwritten by the duplicate
    // Three distinct read: observations, sorted by key.
    const readKeys = result.observations.map(([k]) => k).filter((k) => k.startsWith('read:lib'));
    expect(readKeys).toEqual(['read:lib/a.ts', 'read:lib/m.ts', 'read:lib/z.ts']);
  });

  it('merges hook observations with per-companion read: observations', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-cr-'));
    dirs.push(root);

    const hookObs: Array<[string, string]> = [['read:other/file.ts', 'abc123']];
    mockCollectAllowedReads.mockReturnValue(new Set(['lib/helper.ts']));
    mockResolveAllowedReadPath.mockReturnValue(path.join(root, 'lib', 'helper.ts'));
    mockReadFileBytes.mockResolvedValue(Buffer.from('content'));

    const result = await resolveCompanionDescriptors(
      makeGraph(),
      root,
      makePair(),
      makeAspect(),
      [{ path: 'lib/helper.ts' }],
      hookObs,
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // hook observation is preserved
    expect(result.observations.some(([k]) => k === 'read:other/file.ts')).toBe(true);
    // companion read observation is added
    expect(result.observations.some(([k]) => k.includes('lib/helper.ts'))).toBe(true);
  });
});

// =============================================================================
// 2. Subject-dedupe
// =============================================================================

describe('resolveCompanionDescriptors — subject-dedupe', () => {
  it('silently drops a descriptor path that matches a subject file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-cr-'));
    dirs.push(root);

    mockCollectAllowedReads.mockReturnValue(new Set());
    // resolveAllowedReadPath should NOT be called for the deduped path
    mockResolveAllowedReadPath.mockReturnValue('/should-not-be-reached');

    // descriptor returns the exact subject file path
    const descriptors = [{ path: 'src/svc.ts' }];
    const pair = makePair({ subjectFiles: ['src/svc.ts'] });

    const result = await resolveCompanionDescriptors(
      makeGraph(),
      root,
      pair,
      makeAspect(),
      descriptors,
      [],
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // deduped — not returned as companion
    expect(result.companions).toHaveLength(0);
    // allowed-reads guard never called for a deduped path
    expect(mockResolveAllowedReadPath).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 3. Outside-allowed-reads → infra with rich NEXT
// =============================================================================

describe('resolveCompanionDescriptors — outside-allowed-reads', () => {
  it('returns infra with a rich NEXT including the node path when resolveAllowedReadPath throws', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-cr-'));
    dirs.push(root);

    mockCollectAllowedReads.mockReturnValue(new Set());
    // Guard throws → companion is outside allowed-reads
    mockResolveAllowedReadPath.mockImplementation(() => { throw new Error('outside'); });

    const pair = makePair({ nodePath: 'billing/handler' });
    const aspect = makeAspect('audit');

    const result = await resolveCompanionDescriptors(
      makeGraph(),
      root,
      pair,
      aspect,
      [{ path: 'other/secret.ts' }],
      [],
    );

    expect(result.kind).toBe('infra');
    if (result.kind !== 'infra') return;
    // should mention the aspect and the companion path
    expect(result.messageData.what).toContain('audit');
    expect(result.messageData.what).toContain('outside the node\'s allowed-reads');
    // NEXT should mention the node path (billing/handler) for a relation declaration
    expect(result.messageData.next).toContain('billing/handler');
  });
});

// =============================================================================
// 4. companionOutsideAllowedReads — rich NEXT with owner lookup
// =============================================================================

describe('companionOutsideAllowedReads', () => {
  it('includes owner node path in NEXT when the companion is mapped to a node', () => {
    // Set up a graph with a node that owns the companion file
    const nodes = new Map<string, import('../../../src/model/graph.js').GraphNode>();
    nodes.set('payments/service', {
      meta: { name: 'payments-service', type: 'service', description: 'x', mapping: ['src/payments/svc.ts'] },
      parent: undefined,
      children: [],
      aspects: [],
    } as unknown as import('../../../src/model/graph.js').GraphNode);

    const graph = makeGraph({ nodes });
    const pair = makePair({ nodePath: 'orders/handler', unitKey: 'node:orders/handler' });
    const aspect = makeAspect('correlation-tracking');

    const result = companionOutsideAllowedReads(graph, pair, aspect, 'src/payments/svc.ts', NO_EXCLUSION);

    // NEXT should tell the user to declare a relation FROM the pair node TO the owner
    expect(result.messageData.next).toContain('orders/handler');
    expect(result.messageData.next).toContain('payments/service');
    expect(result.messageData.next).toContain('yg-node.yaml');
  });

  it('says the path is unmapped when no node owns the companion', () => {
    const graph = makeGraph();
    const pair = makePair({ nodePath: 'orders/handler', unitKey: 'node:orders/handler' });
    const aspect = makeAspect('correlation-tracking');

    const result = companionOutsideAllowedReads(graph, pair, aspect, 'src/unknown/file.ts', NO_EXCLUSION);

    expect(result.messageData.next).toContain('unmapped');
    expect(result.messageData.next).toContain('orders/handler');
  });

  it('says the path is excluded from graph coverage, never naming a relation to declare, when the companion is under coverage.excluded — even though a node\'s mapping textually covers it', () => {
    // Node 'payments/service' maps a path that textually SWEEPS IN the excluded
    // file too (a directory mapping), so the pre-exclusion-check owner lookup
    // would find an owner and print "declare a relation" — advice that cannot
    // work, since the path is gone from graph coverage regardless of any
    // relation. The exclusion check must win before the owner lookup ever runs.
    const nodes = new Map<string, import('../../../src/model/graph.js').GraphNode>();
    nodes.set('payments/service', {
      meta: { name: 'payments-service', type: 'service', description: 'x', mapping: ['src/payments'] },
      parent: undefined,
      children: [],
      aspects: [],
    } as unknown as import('../../../src/model/graph.js').GraphNode);

    const graph = makeGraph({ nodes });
    const pair = makePair({ nodePath: 'orders/handler', unitKey: 'node:orders/handler' });
    const aspect = makeAspect('correlation-tracking');
    const exclusion: GraphExclusionSet = { nestedRoots: new Set(), coverage: { required: [], excluded: ['src/payments/vendored'], typeLevel: false } };

    const result = companionOutsideAllowedReads(graph, pair, aspect, 'src/payments/vendored/lib.ts', exclusion);

    expect(result.messageData.what).toContain('excluded from graph coverage by design');
    expect(result.messageData.next).not.toContain('declare a relation');
    expect(result.messageData.next).not.toContain('payments/service');
  });

  it('control: a path outside coverage.excluded on the SAME graph still gets the owner-lookup NEXT (the exclusion check does not silence generally)', () => {
    const nodes = new Map<string, import('../../../src/model/graph.js').GraphNode>();
    nodes.set('payments/service', {
      meta: { name: 'payments-service', type: 'service', description: 'x', mapping: ['src/payments'] },
      parent: undefined,
      children: [],
      aspects: [],
    } as unknown as import('../../../src/model/graph.js').GraphNode);

    const graph = makeGraph({ nodes });
    const pair = makePair({ nodePath: 'orders/handler', unitKey: 'node:orders/handler' });
    const aspect = makeAspect('correlation-tracking');
    const exclusion: GraphExclusionSet = { nestedRoots: new Set(), coverage: { required: [], excluded: ['src/payments/vendored'], typeLevel: false } };

    const result = companionOutsideAllowedReads(graph, pair, aspect, 'src/payments/svc.ts', exclusion);

    expect(result.messageData.what).not.toContain('excluded from graph coverage by design');
    expect(result.messageData.next).toContain('declare a relation from orders/handler to payments/service');
  });
});

// =============================================================================
// 5. resolveCompanionsForPair — A6 taint guard: tainted once, then a GENUINE
//    infra failure on the retry (distinct from "tainted twice").
// =============================================================================

describe('resolveCompanionsForPair — A6 taint guard', () => {
  /** A real on-disk root with a 'svc' node mapping ONE file (src/svc.ts) — the
   *  common case where subjectFiles === the full mapping (subjectScope undefined). */
  async function setupSingleFileNode(): Promise<{ root: string; graph: Graph; pair: ExpectedPair }> {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-cr-pair-'));
    dirs.push(root);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');

    const nodes = new Map<string, import('../../../src/model/graph.js').GraphNode>();
    nodes.set('svc', {
      meta: { name: 'svc', type: 'service', description: 'x', mapping: ['src/svc.ts'] },
      parent: undefined,
      children: [],
      aspects: [],
    } as unknown as import('../../../src/model/graph.js').GraphNode);
    const graph = makeGraph({ nodes, rootPath: path.join(root, '.yggdrasil') });

    const pair: ExpectedPair = {
      aspectId: 'my-aspect',
      kind: 'llm',
      unitKey: 'node:svc',
      nodePath: 'svc',
      status: 'enforced',
      subjectFiles: ['src/svc.ts'],
    };
    return { root, graph, pair };
  }

  it('tainted on the first run, then a real infra failure on the retry → infra with the retry\'s own message', async () => {
    const { root, graph, pair } = await setupSingleFileNode();

    // Run 1: ok, but tainted (a file changed mid-resolution) → the guard retries.
    mockRunCompanionHook.mockResolvedValueOnce({
      kind: 'ok',
      descriptors: [],
      touchedFiles: [],
      observations: [],
      observationsTainted: true,
    });
    // Run 2 (the retry): a GENUINE infra failure — distinct from "still tainted".
    mockRunCompanionHook.mockResolvedValueOnce({
      kind: 'infra',
      messageData: { what: 'boom on retry', why: 'y', next: 'n' },
    });

    const result = await resolveCompanionsForPair(graph, root, pair, makeAspect());
    expect(mockRunCompanionHook).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe('infra');
    if (result.kind !== 'infra') return;
    // The retry's OWN infra message surfaces — never the "inconsistent across two
    // runs" (still-tainted) message, which is a different failure mode.
    expect(result.why).toContain('boom on retry');
    expect(result.messageData.what).toBe('boom on retry');
  });

  it('returns infra immediately when the FIRST hook run fails outright (no retry)', async () => {
    const { root, graph, pair } = await setupSingleFileNode();
    mockRunCompanionHook.mockResolvedValueOnce({
      kind: 'infra',
      messageData: { what: 'boom on first run', why: 'y', next: 'n' },
    });

    const result = await resolveCompanionsForPair(graph, root, pair, makeAspect());
    expect(mockRunCompanionHook).toHaveBeenCalledTimes(1); // no retry on an outright infra
    expect(result.kind).toBe('infra');
    if (result.kind !== 'infra') return;
    expect(result.messageData.what).toBe('boom on first run');
  });

  it('succeeds after ONE retry when the first run was tainted but the retry settles', async () => {
    const { root, graph, pair } = await setupSingleFileNode();
    mockRunCompanionHook
      .mockResolvedValueOnce({ kind: 'ok', descriptors: [], touchedFiles: [], observations: [], observationsTainted: true })
      .mockResolvedValueOnce({ kind: 'ok', descriptors: [], touchedFiles: [], observations: [], observationsTainted: false });

    const result = await resolveCompanionsForPair(graph, root, pair, makeAspect());
    expect(mockRunCompanionHook).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe('ok');
  });

  it('returns infra when the observation set stays tainted across BOTH runs (a torn set, never cached)', async () => {
    const { root, graph, pair } = await setupSingleFileNode();
    mockRunCompanionHook.mockResolvedValue({
      kind: 'ok',
      descriptors: [],
      touchedFiles: [],
      observations: [],
      observationsTainted: true, // always tainted
    });

    const result = await resolveCompanionsForPair(graph, root, pair, makeAspect());
    expect(mockRunCompanionHook).toHaveBeenCalledTimes(2); // run once, retry once, stop
    expect(result.kind).toBe('infra');
    if (result.kind !== 'infra') return;
    expect(result.why).toContain('inconsistent across two runs');
  });

  it('narrows subjectScope to the subject files when they are FEWER than the node\'s full mapping', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-cr-pair-'));
    dirs.push(root);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
    await writeFile(path.join(root, 'src', 'other.ts'), 'export const y = 1;\n');

    const nodes = new Map<string, import('../../../src/model/graph.js').GraphNode>();
    nodes.set('svc', {
      meta: { name: 'svc', type: 'service', description: 'x', mapping: ['src/svc.ts', 'src/other.ts'] },
      parent: undefined,
      children: [],
      aspects: [],
    } as unknown as import('../../../src/model/graph.js').GraphNode);
    const graph = makeGraph({ nodes, rootPath: path.join(root, '.yggdrasil') });

    // subjectFiles is a STRICT SUBSET of the node's full mapping (per:file scope).
    const pair: ExpectedPair = {
      aspectId: 'my-aspect',
      kind: 'llm',
      unitKey: 'file:src/svc.ts',
      nodePath: 'svc',
      status: 'enforced',
      subjectFiles: ['src/svc.ts'],
    };

    mockRunCompanionHook.mockResolvedValueOnce({
      kind: 'ok',
      descriptors: [],
      touchedFiles: [],
      observations: [],
      observationsTainted: false,
    });

    const result = await resolveCompanionsForPair(graph, root, pair, makeAspect());
    expect(result.kind).toBe('ok');
    // The hook must have been called with the NARROWED subjectScope, not undefined.
    expect(mockRunCompanionHook).toHaveBeenCalledWith(expect.objectContaining({ subjectScope: ['src/svc.ts'] }));
  });

  it('resolves an unreadable-on-disk companion (path passes allowed-reads but the file cannot be read) to infra', async () => {
    const { root, graph, pair } = await setupSingleFileNode();
    mockCollectAllowedReads.mockReturnValue(new Set(['ghost.ts']));
    mockResolveAllowedReadPath.mockReturnValue(path.join(root, 'ghost.ts')); // passes the guard
    mockReadFileBytes.mockResolvedValue(null); // but the file is missing/unreadable at read time
    mockRunCompanionHook.mockResolvedValueOnce({
      kind: 'ok',
      descriptors: [{ path: 'ghost.ts' }],
      touchedFiles: [],
      observations: [],
      observationsTainted: false,
    });

    const result = await resolveCompanionsForPair(graph, root, pair, makeAspect());
    expect(result.kind).toBe('infra');
    if (result.kind !== 'infra') return;
    expect(result.why).toContain('could not be read');
  });
});
