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

import { resolveCompanionDescriptors, companionOutsideAllowedReads } from '../../../src/core/companion-resolve.js';
import type { Graph, AspectDef } from '../../../src/model/graph.js';
import type { ExpectedPair } from '../../../src/core/pairs.js';

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

    const result = companionOutsideAllowedReads(graph, pair, aspect, 'src/payments/svc.ts');

    // NEXT should tell the user to declare a relation FROM the pair node TO the owner
    expect(result.messageData.next).toContain('orders/handler');
    expect(result.messageData.next).toContain('payments/service');
    expect(result.messageData.next).toContain('yg-node.yaml');
  });

  it('says the path is unmapped when no node owns the companion', () => {
    const graph = makeGraph();
    const pair = makePair({ nodePath: 'orders/handler', unitKey: 'node:orders/handler' });
    const aspect = makeAspect('correlation-tracking');

    const result = companionOutsideAllowedReads(graph, pair, aspect, 'src/unknown/file.ts');

    expect(result.messageData.next).toContain('unmapped');
    expect(result.messageData.next).toContain('orders/handler');
  });
});
