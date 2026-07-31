/**
 * Tests for core/pairs.ts — expected-pair computation and source fingerprints.
 *
 * All tests create real files in a tmpdir because computeExpectedPairs calls
 * expandMappingPaths (reads the filesystem) and computeSourceFingerprint calls
 * hashFile (reads raw bytes). The buildTestGraph helper is extended via the
 * TestNodeInput.mapping and TestAspectInput.scope additions below.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileUnit, nodeUnit } from '../../../src/model/lock.js';
import {
  computeExpectedPairs,
  computeSourceFingerprint,
  computeNodeMappedFiles,
  getChildMappingExclusions,
  FileUnreadableError,
} from '../../../src/core/pairs.js';
import type { Graph, GraphNode, AspectDef, ScopeDef } from '../../../src/model/graph.js';

/**
 * Whether this runtime actually enforces a chmod(0o000) restriction on a file
 * readable by its owner. A privileged process (root, or certain containers)
 * ignores file mode bits entirely, so a test relying on readFileSync genuinely
 * failing under 0o000 cannot execute there. Probed ONCE at module load — never
 * per-test, never inside an assertion — so a test depending on it is marked
 * SKIPPED for this environment via `it.skipIf`, an honest, explicit
 * non-execution rather than an early `return` that lets vitest report a test
 * that ran zero assertions as passed.
 */
function probeEnforcesFilePermissions(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-permcheck-'));
  const probe = path.join(dir, 'probe.txt');
  writeFileSync(probe, 'x');
  chmodSync(probe, 0o000);
  let enforced = false;
  try {
    readFileSync(probe, 'utf8');
  } catch {
    enforced = true;
  }
  chmodSync(probe, 0o644); // restore so rmSync can remove it
  rmSync(dir, { recursive: true, force: true });
  return enforced;
}
const ENFORCES_FILE_PERMISSIONS = probeEnforcesFilePermissions();

// ---------------------------------------------------------------------------
// Minimal inline graph builder (extends buildTestGraph with mapping + scope)
// ---------------------------------------------------------------------------

/**
 * Build a minimal Graph for pairs testing. Nodes are created with real on-disk
 * file paths so expandMappingPaths resolves actual files. The rootPath points
 * to <tmpDir>/.yggdrasil so that path.dirname(rootPath) = tmpDir = project root.
 */
interface PairsTestAspect {
  id: string;
  kind: 'llm' | 'deterministic' | 'aggregate';
  status?: 'draft' | 'advisory' | 'enforced';
  scope?: ScopeDef;
}

interface PairsTestNode {
  path: string;         // model-relative node path (e.g. "svc/handler")
  mapping?: string[];   // repo-relative paths (relative to tmpDir)
  aspects?: string[];   // aspect ids
  parent?: string;      // parent node path
}

function buildPairsGraph(
  tmpDir: string,
  nodes: PairsTestNode[],
  aspects: PairsTestAspect[],
): Graph {
  const rootPath = path.join(tmpDir, '.yggdrasil');
  mkdirSync(rootPath, { recursive: true });

  const aspectDefs: AspectDef[] = aspects.map((a) => ({
    id: a.id,
    name: a.id,
    reviewer: { type: a.kind },
    status: a.status ?? 'enforced',
    artifacts: a.kind === 'aggregate' ? [] : [{ filename: a.kind === 'llm' ? 'content.md' : 'check.mjs', content: 'rule' }],
    scope: a.scope,
  } as AspectDef));

  const nodeByPath = new Map<string, GraphNode>();
  for (const n of nodes) {
    nodeByPath.set(n.path, {
      path: n.path,
      meta: {
        name: n.path,
        type: 'service',
        aspects: n.aspects ?? [],
        mapping: n.mapping ?? [],
      },
      children: [],
      parent: null,
    } as GraphNode);
  }
  // Wire parent/child
  for (const n of nodes) {
    if (n.parent) {
      const child = nodeByPath.get(n.path)!;
      const parent = nodeByPath.get(n.parent)!;
      child.parent = parent;
      parent.children.push(child);
    }
  }

  return {
    config: {
      version: '5.0.0',
      reviewer: { tiers: { default: { provider: 'ollama', model: 'test', temperature: 0, consensus: 1 } }, default: 'default' },
    },
    architecture: {
      node_types: {
        service: { description: 'test' },
      },
    },
    nodes: nodeByPath,
    aspects: aspectDefs,
    flows: [],
    rootPath,
  } as unknown as Graph;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-pairs-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: write a file relative to tmpDir
// ---------------------------------------------------------------------------

function writeFile(relPath: string, content = 'content'): void {
  const abs = path.join(tmpDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// computeExpectedPairs tests
// ---------------------------------------------------------------------------

describe('computeExpectedPairs', () => {
  it('per-node LLM aspect on a node with 3 files → 1 pair with 3 subjects', async () => {
    writeFile('src/a.ts', 'code a');
    writeFile('src/b.ts', 'code b');
    writeFile('src/c.ts', 'code c');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts', 'src/b.ts', 'src/c.ts'], aspects: ['check-input'] }],
      [{ id: 'check-input', kind: 'llm' }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(1);
    const p = pairs[0];
    expect(p.aspectId).toBe('check-input');
    expect(p.kind).toBe('llm');
    expect(p.unitKey).toBe(nodeUnit('svc'));
    expect(p.nodePath).toBe('svc');
    expect(p.status).toBe('enforced');
    expect(p.subjectFiles).toHaveLength(3);
    expect(p.subjectFiles).toContain('src/a.ts');
    expect(p.subjectFiles).toContain('src/b.ts');
    expect(p.subjectFiles).toContain('src/c.ts');
  });

  it('per-file LLM aspect → one pair per subject file with fileUnit keys', async () => {
    writeFile('src/a.ts');
    writeFile('src/b.ts');
    writeFile('src/c.ts');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts', 'src/b.ts', 'src/c.ts'], aspects: ['lint'] }],
      [{ id: 'lint', kind: 'llm', scope: { per: 'file' } }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(3);
    for (const p of pairs) {
      expect(p.kind).toBe('llm');
      expect(p.subjectFiles).toHaveLength(1);
      expect(p.unitKey).toBe(fileUnit(p.subjectFiles[0]));
    }
    // Sorted by aspectId then unitKey
    const keys = pairs.map((p) => p.unitKey);
    expect(keys).toEqual([...keys].sort());
  });

  it('scope.files path filter narrows the subject set', async () => {
    writeFile('src/handler.ts');
    writeFile('src/utils.ts');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/handler.ts', 'src/utils.ts'], aspects: ['handler-only'] }],
      [{ id: 'handler-only', kind: 'llm', scope: { per: 'node', files: { path: '**/*handler*' } } }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].subjectFiles).toEqual(['src/handler.ts']);
  });

  it('scope.files content filter narrows the subject set', async () => {
    writeFile('src/alpha.ts', 'export function doThing() {}');
    writeFile('src/beta.ts', 'export const x = 1;');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/alpha.ts', 'src/beta.ts'], aspects: ['fn-check'] }],
      [{ id: 'fn-check', kind: 'llm', scope: { per: 'node', files: { content: 'export function' } } }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].subjectFiles).toEqual(['src/alpha.ts']);
  });

  it('binary files excluded for LLM aspects but kept for deterministic', async () => {
    writeFile('src/code.ts', 'const x = 1;');
    // Write a real binary-extension file (empty, but the extension triggers the filter)
    writeFile('src/image.png', 'PNG data');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/code.ts', 'src/image.png'], aspects: ['llm-check', 'det-check'] }],
      [
        { id: 'llm-check', kind: 'llm' },
        { id: 'det-check', kind: 'deterministic' },
      ],
    );

    const { pairs } = await computeExpectedPairs(graph);
    const llmPair = pairs.find((p) => p.aspectId === 'llm-check')!;
    const detPair = pairs.find((p) => p.aspectId === 'det-check')!;

    expect(llmPair.subjectFiles).toEqual(['src/code.ts']);
    expect(detPair.subjectFiles).toContain('src/image.png');
    expect(detPair.subjectFiles).toContain('src/code.ts');
  });

  it('empty subject set after filtering → no pair produced (vacuous pass)', async () => {
    writeFile('src/image.png', 'PNG data');

    const graph = buildPairsGraph(
      tmpDir,
      // Only a binary file in mapping → LLM excludes it → empty subject → no pair
      [{ path: 'svc', mapping: ['src/image.png'], aspects: ['llm-check'] }],
      [{ id: 'llm-check', kind: 'llm' }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(0);
  });

  it('draft aspect excluded by default, included with includeDraft: true', async () => {
    writeFile('src/a.ts');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts'], aspects: ['wip'] }],
      [{ id: 'wip', kind: 'llm', status: 'draft' }],
    );

    const { pairs: pairsDefault } = await computeExpectedPairs(graph);
    expect(pairsDefault).toHaveLength(0);

    const { pairs: pairsDraft } = await computeExpectedPairs(graph, { includeDraft: true });
    expect(pairsDraft).toHaveLength(1);
    expect(pairsDraft[0].aspectId).toBe('wip');
    expect(pairsDraft[0].status).toBe('draft');
  });

  it('aggregate aspect never produces a pair', async () => {
    writeFile('src/a.ts');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts'], aspects: ['bundle'] }],
      [{ id: 'bundle', kind: 'aggregate' }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(0);
  });

  it('node with empty mapping → no pairs', async () => {
    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: [], aspects: ['check-input'] }],
      [{ id: 'check-input', kind: 'llm' }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(0);
  });

  it('child carve-out: parent pair excludes file mapped by child', async () => {
    writeFile('src/parent.ts', 'parent code');
    writeFile('src/child/child.ts', 'child code');

    const graph = buildPairsGraph(
      tmpDir,
      [
        { path: 'svc', mapping: ['src/parent.ts', 'src/child/child.ts'], aspects: ['check'] },
        { path: 'svc/child', mapping: ['src/child/child.ts'], parent: 'svc' },
      ],
      [{ id: 'check', kind: 'llm' }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    const parentPair = pairs.find((p) => p.nodePath === 'svc')!;
    expect(parentPair).toBeDefined();
    expect(parentPair.subjectFiles).not.toContain('src/child/child.ts');
    expect(parentPair.subjectFiles).toContain('src/parent.ts');
  });

  it('output ordering is deterministic: sorted by aspectId then unitKey', async () => {
    writeFile('src/a.ts');
    writeFile('src/b.ts');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts', 'src/b.ts'], aspects: ['z-aspect', 'a-aspect'] }],
      [
        { id: 'z-aspect', kind: 'llm', scope: { per: 'file' } },
        { id: 'a-aspect', kind: 'llm', scope: { per: 'file' } },
      ],
    );

    const { pairs } = await computeExpectedPairs(graph);
    // 2 aspects × 2 files = 4 pairs; must be sorted by aspectId then unitKey
    expect(pairs).toHaveLength(4);
    const sortedExpected = [...pairs].sort((a, b) => {
      if (a.aspectId !== b.aspectId) return a.aspectId < b.aspectId ? -1 : 1;
      return a.unitKey < b.unitKey ? -1 : 1;
    });
    expect(pairs.map((p) => `${p.aspectId}|${p.unitKey}`)).toEqual(
      sortedExpected.map((p) => `${p.aspectId}|${p.unitKey}`),
    );
  });

  // ---------------------------------------------------------------------------
  // Regression: unreadable subject files must be surfaced, never silently dropped
  //
  // Technique: chmod 0o000 makes the file exist on disk (so expandMappingPaths
  // includes it) but unreadable by readFile (EACCES) → evaluateFileWhen reports
  // unreadable: true. Each test restores permissions in afterEach via rmSync
  // (which handles the restore implicitly via recursive:true + force:true).
  // We keep an explicit restore array so cleanup works before rmSync is called.
  // ---------------------------------------------------------------------------

  it.skipIf(!ENFORCES_FILE_PERMISSIONS)('content-filter aspect: unreadable file lands in unreadable[], readable sibling still produces a pair', async () => {
    // src/readable.ts is readable and matches the content filter.
    // src/locked.ts exists but chmod 0o000 → readFile EACCES → evaluateFileWhen
    // reports unreadable: true — it must land in unreadable[], not be silently dropped.
    writeFile('src/readable.ts', 'export function doThing() {}');
    writeFile('src/locked.ts', 'export function secret() {}');
    const lockedAbs = path.join(tmpDir, 'src/locked.ts');
    chmodSync(lockedAbs, 0o000);

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/readable.ts', 'src/locked.ts'], aspects: ['fn-check'] }],
      [{ id: 'fn-check', kind: 'llm', scope: { per: 'node', files: { content: 'export function' } } }],
    );

    let pairs: Awaited<ReturnType<typeof computeExpectedPairs>>['pairs'];
    let unreadable: Awaited<ReturnType<typeof computeExpectedPairs>>['unreadable'];
    try {
      ({ pairs, unreadable } = await computeExpectedPairs(graph));
    } finally {
      chmodSync(lockedAbs, 0o644); // restore so afterEach rmSync can remove the tree
    }

    // The readable, matching file still produces a pair.
    expect(pairs).toHaveLength(1);
    expect(pairs[0].subjectFiles).toEqual(['src/readable.ts']);

    // The unreadable file is recorded with correct metadata.
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].nodePath).toBe('svc');
    expect(unreadable[0].aspectId).toBe('fn-check');
    expect(unreadable[0].path).toBe('src/locked.ts');
    expect(unreadable[0].reason).toMatch(/EACCES/i);
  });

  it.skipIf(!ENFORCES_FILE_PERMISSIONS)('content-filter aspect: only matching file is unreadable → zero pairs AND non-empty unreadable (vacuous-green guard)', async () => {
    // src/locked.ts is the only mapped file. chmod 0o000 makes it unreadable.
    // Without the fix this produced zero pairs silently (vacuous green).
    // With the fix: zero pairs AND non-empty unreadable surfaces the problem.
    writeFile('src/locked.ts', 'export function secret() {}');
    const lockedAbs = path.join(tmpDir, 'src/locked.ts');
    chmodSync(lockedAbs, 0o000);

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/locked.ts'], aspects: ['fn-check'] }],
      [{ id: 'fn-check', kind: 'llm', scope: { per: 'node', files: { content: 'export function' } } }],
    );

    let pairs: Awaited<ReturnType<typeof computeExpectedPairs>>['pairs'];
    let unreadable: Awaited<ReturnType<typeof computeExpectedPairs>>['unreadable'];
    try {
      ({ pairs, unreadable } = await computeExpectedPairs(graph));
    } finally {
      chmodSync(lockedAbs, 0o644);
    }

    expect(pairs).toHaveLength(0);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].nodePath).toBe('svc');
    expect(unreadable[0].aspectId).toBe('fn-check');
    expect(unreadable[0].path).toBe('src/locked.ts');
  });

  // ---------------------------------------------------------------------------
  // Regression (twin of the unreadable-by-permission guard above): a content
  // filter cannot scan a file over the 5MB limit, so the filter is UNEVALUABLE.
  // It must NOT be silently excluded (that would turn an enforced rule into a
  // vacuous pass over source no reviewer saw) — it must surface in unreadable[].
  // No privileged-runtime guard is needed: this is file size, not permissions.
  // ---------------------------------------------------------------------------

  it('content-filter aspect: only mapped file is >5MB → zero pairs AND non-empty unreadable (too-large vacuous-green guard)', async () => {
    // src/big.ts is the only mapped file and exceeds the 5MB content-scan limit,
    // so the content filter cannot be applied. Without the fix this produced zero
    // pairs silently (vacuous green). With the fix: zero pairs AND a blocking
    // unreadable record naming the file and the aspect.
    writeFile('src/big.ts', 'a'.repeat(5 * 1024 * 1024 + 10));

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/big.ts'], aspects: ['fn-check'] }],
      [{ id: 'fn-check', kind: 'llm', scope: { per: 'node', files: { content: 'export function' } } }],
    );

    const { pairs, unreadable } = await computeExpectedPairs(graph);

    expect(pairs).toHaveLength(0);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].nodePath).toBe('svc');
    expect(unreadable[0].aspectId).toBe('fn-check');
    expect(unreadable[0].path).toBe('src/big.ts');
    expect(unreadable[0].reason).toMatch(/5MB/);
    // The diagnostic is phrased as a filter that could not be evaluated, NOT
    // "could not read" (a too-large file is readable, just not scannable).
    expect(unreadable[0].messageData.what).toMatch(/could not evaluate the content filter/);
  });

  it('content-filter aspect: a >5MB file blocks even when a readable sibling matches (never rescued into a pass)', async () => {
    // The readable, matching sibling still produces a pair, but the run is still
    // blocked on the too-large file — a sibling never rescues an unevaluable file
    // into a vacuous pass.
    writeFile('src/small.ts', 'export function doThing() {}');
    writeFile('src/big.ts', 'a'.repeat(5 * 1024 * 1024 + 10));

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/small.ts', 'src/big.ts'], aspects: ['fn-check'] }],
      [{ id: 'fn-check', kind: 'llm', scope: { per: 'node', files: { content: 'export function' } } }],
    );

    const { pairs, unreadable } = await computeExpectedPairs(graph);

    // The readable, matching file still produces a pair.
    expect(pairs).toHaveLength(1);
    expect(pairs[0].subjectFiles).toEqual(['src/small.ts']);

    // The too-large file is recorded with correct metadata.
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].nodePath).toBe('svc');
    expect(unreadable[0].aspectId).toBe('fn-check');
    expect(unreadable[0].path).toBe('src/big.ts');
    expect(unreadable[0].reason).toMatch(/5MB/);
  });

  it.skipIf(!ENFORCES_FILE_PERMISSIONS)('path-filter aspect: an unreadable subject file IS flagged unreadable and excluded (a mapped file must be readable)', async () => {
    // A path-only filter never reads content, but readability is now probed for
    // EVERY subject file: a file written into the mapping must be readable, or it
    // surfaces as a blocking unreadable record and is dropped from the subject
    // set — never silently kept (which would let a check pass over content it
    // could not read). The readable sibling still forms the pair.
    writeFile('src/handler.ts', 'code');
    writeFile('src/locked.ts', 'code');
    const lockedAbs = path.join(tmpDir, 'src/locked.ts');
    chmodSync(lockedAbs, 0o000);

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/handler.ts', 'src/locked.ts'], aspects: ['path-only'] }],
      [{ id: 'path-only', kind: 'llm', scope: { per: 'node', files: { path: '**/*.ts' } } }],
    );

    let pairs: Awaited<ReturnType<typeof computeExpectedPairs>>['pairs'];
    let unreadable: Awaited<ReturnType<typeof computeExpectedPairs>>['unreadable'];
    try {
      ({ pairs, unreadable } = await computeExpectedPairs(graph));
    } finally {
      chmodSync(lockedAbs, 0o644);
    }

    // The readable sibling forms the per:node pair; the unreadable file is
    // excluded and surfaced as a blocking unreadable record.
    expect(pairs).toHaveLength(1);
    expect(pairs[0].subjectFiles).toEqual(['src/handler.ts']);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].nodePath).toBe('svc');
    expect(unreadable[0].aspectId).toBe('path-only');
    expect(unreadable[0].path).toBe('src/locked.ts');
  });
});

// ---------------------------------------------------------------------------
// computeSourceFingerprint tests
// ---------------------------------------------------------------------------

describe('computeSourceFingerprint', () => {
  it('returns a sha256 hex string for a mapped node', async () => {
    writeFile('src/a.ts', 'const a = 1;');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts'] }],
      [],
    );

    const fp = await computeSourceFingerprint(graph, 'svc');
    expect(fp).toBeDefined();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns undefined for a node with no mapping', async () => {
    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: [] }],
      [],
    );

    const fp = await computeSourceFingerprint(graph, 'svc');
    expect(fp).toBeUndefined();
  });

  it('returns undefined for an unknown node', async () => {
    const graph = buildPairsGraph(tmpDir, [], []);
    const fp = await computeSourceFingerprint(graph, 'nonexistent');
    expect(fp).toBeUndefined();
  });

  it('changes when a mapped file content changes', async () => {
    writeFile('src/a.ts', 'version 1');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts'] }],
      [],
    );

    const fp1 = await computeSourceFingerprint(graph, 'svc');

    writeFile('src/a.ts', 'version 2');
    const fp2 = await computeSourceFingerprint(graph, 'svc');

    expect(fp1).not.toBe(fp2);
  });

  it('is INSENSITIVE to scope filters — always hashes full mapping', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/image.png', 'PNG');

    const graph1 = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts', 'src/image.png'] }],
      [],
    );

    // Scope on the aspect does NOT affect the fingerprint
    const fp1 = await computeSourceFingerprint(graph1, 'svc');

    // Same graph — same fingerprint regardless of what aspects look like
    const fp2 = await computeSourceFingerprint(graph1, 'svc');
    expect(fp1).toBe(fp2);
  });

  it('includes binary files by raw bytes in the fingerprint', async () => {
    writeFile('src/image.png', 'PNG bytes v1');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/image.png'] }],
      [],
    );

    const fp1 = await computeSourceFingerprint(graph, 'svc');
    expect(fp1).toBeDefined();

    writeFile('src/image.png', 'PNG bytes v2');
    const fp2 = await computeSourceFingerprint(graph, 'svc');

    // Binary content change must change the fingerprint
    expect(fp1).not.toBe(fp2);
  });

  it('child carve-out respected: parent fingerprint excludes child-mapped file', async () => {
    writeFile('src/parent.ts', 'parent code');
    writeFile('src/child/child.ts', 'child code');

    const graph1 = buildPairsGraph(
      tmpDir,
      [
        { path: 'svc', mapping: ['src/parent.ts', 'src/child/child.ts'] },
        { path: 'svc/child', mapping: ['src/child/child.ts'], parent: 'svc' },
      ],
      [],
    );

    const parentFp = await computeSourceFingerprint(graph1, 'svc');

    // Build a graph without the child node (parent maps both files, no carve-out)
    const graph2 = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/parent.ts', 'src/child/child.ts'] }],
      [],
    );
    const noCarveOutFp = await computeSourceFingerprint(graph2, 'svc');

    // With carve-out, parent fingerprint covers only src/parent.ts → different
    expect(parentFp).not.toBe(noCarveOutFp);
  });

  it.skipIf(!ENFORCES_FILE_PERMISSIONS)('throws FileUnreadableError for an unreadable mapped file (no partial fold)', async () => {
    writeFile('src/a.ts', 'readable');
    writeFile('src/locked.ts', 'secret');
    const lockedAbs = path.join(tmpDir, 'src/locked.ts');
    chmodSync(lockedAbs, 0o000);

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts', 'src/locked.ts'] }],
      [],
    );

    try {
      await expect(computeSourceFingerprint(graph, 'svc')).rejects.toBeInstanceOf(FileUnreadableError);
    } finally {
      chmodSync(lockedAbs, 0o644);
    }
  });
});

// ---------------------------------------------------------------------------
// A directory mapping stops at a nested project's own .yggdrasil boundary.
//
// A vendored dependency, git worktree, or submodule that itself carries a
// `.yggdrasil/` is a separate graph, governed by its own rules — its files
// must never become this graph's enforcement pairs, must never enter a
// node's source fingerprint, and must never appear in its mapped-files set.
// An ORDINARY subdirectory (no nested `.yggdrasil/`) must still be absorbed
// by the recursive directory mapping — the guard must stop exactly at a
// nested graph's boundary, not at every subdirectory.
// ---------------------------------------------------------------------------

describe('directory mapping vs. a nested project boundary', () => {
  it('computeExpectedPairs excludes a nested project\'s files from the pair universe', async () => {
    writeFile('services/alpha.py', 'def alpha(): return 1');
    writeFile('services/beta.py', 'def beta(): return 2');
    // A vendored sub-project with its own graph, nested inside the mapped directory.
    writeFile('services/vendored-sub/.yggdrasil/yg-config.yaml', 'version: "5.2.0"\n');
    writeFile('services/vendored-sub/foreign.py', 'def foreign(): return 1');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['services'], aspects: ['check-input'] }],
      [{ id: 'check-input', kind: 'deterministic', scope: { per: 'file' } }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    const subjects = pairs.map((p) => p.subjectFiles[0]);
    expect(subjects.sort()).toEqual(['services/alpha.py', 'services/beta.py']);
    expect(subjects).not.toContain('services/vendored-sub/foreign.py');
    expect(subjects).not.toContain('services/vendored-sub/.yggdrasil/yg-config.yaml');
  });

  it('computeExpectedPairs still absorbs an ordinary nested subdirectory (no own graph)', async () => {
    writeFile('services/alpha.py', 'def alpha(): return 1');
    writeFile('services/beta.py', 'def beta(): return 2');
    // Plain subdirectory — NOT its own project, must recurse in as usual.
    writeFile('services/control-sub/control.py', 'def control(): return 1');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['services'], aspects: ['check-input'] }],
      [{ id: 'check-input', kind: 'deterministic', scope: { per: 'file' } }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    const subjects = pairs.map((p) => p.subjectFiles[0]);
    expect(subjects.sort()).toEqual([
      'services/alpha.py',
      'services/beta.py',
      'services/control-sub/control.py',
    ]);
  });

  it('computeSourceFingerprint is unchanged by a nested project appearing under the mapping', async () => {
    writeFile('services/alpha.py', 'def alpha(): return 1');

    const graphBefore = buildPairsGraph(tmpDir, [{ path: 'svc', mapping: ['services'] }], []);
    const fpBefore = await computeSourceFingerprint(graphBefore, 'svc');

    writeFile('services/vendored-sub/.yggdrasil/yg-config.yaml', 'version: "5.2.0"\n');
    writeFile('services/vendored-sub/foreign.py', 'def foreign(): return 1');
    const graphAfter = buildPairsGraph(tmpDir, [{ path: 'svc', mapping: ['services'] }], []);
    const fpAfter = await computeSourceFingerprint(graphAfter, 'svc');

    // The nested project's files never entered the fingerprint, so appearing
    // (or later disappearing) changes nothing about it.
    expect(fpAfter).toBe(fpBefore);
  });

  it('computeSourceFingerprint DOES change for an ordinary new sibling file (control)', async () => {
    writeFile('services/alpha.py', 'def alpha(): return 1');

    const graphBefore = buildPairsGraph(tmpDir, [{ path: 'svc', mapping: ['services'] }], []);
    const fpBefore = await computeSourceFingerprint(graphBefore, 'svc');

    writeFile('services/control-sub/control.py', 'def control(): return 1');
    const graphAfter = buildPairsGraph(tmpDir, [{ path: 'svc', mapping: ['services'] }], []);
    const fpAfter = await computeSourceFingerprint(graphAfter, 'svc');

    expect(fpAfter).not.toBe(fpBefore);
  });

  it('computeNodeMappedFiles never lists a file under a nested project\'s own boundary', async () => {
    writeFile('services/alpha.py', 'def alpha(): return 1');
    writeFile('services/vendored-sub/.yggdrasil/yg-config.yaml', 'version: "5.2.0"\n');
    writeFile('services/vendored-sub/foreign.py', 'def foreign(): return 1');

    const graph = buildPairsGraph(tmpDir, [{ path: 'svc', mapping: ['services'] }], []);
    const files = await computeNodeMappedFiles(graph, 'svc');

    expect(files.sort()).toEqual(['services/alpha.py']);
  });
});

// ---------------------------------------------------------------------------
// getChildMappingExclusions tests (sanity — verified behavior)
// ---------------------------------------------------------------------------

describe('getChildMappingExclusions', () => {
  it('returns empty for a node with no children', () => {
    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts'] }],
      [],
    );
    expect(getChildMappingExclusions(graph, 'svc')).toEqual([]);
  });

  it('returns empty for an unknown node', () => {
    const graph = buildPairsGraph(tmpDir, [], []);
    expect(getChildMappingExclusions(graph, 'unknown')).toEqual([]);
  });

  it('returns child mapping entries that overlap with parent mapping', () => {
    const graph = buildPairsGraph(
      tmpDir,
      [
        { path: 'svc', mapping: ['src'] },
        { path: 'svc/child', mapping: ['src/child'], parent: 'svc' },
      ],
      [],
    );
    const exclusions = getChildMappingExclusions(graph, 'svc');
    expect(exclusions).toContain('src/child');
  });
});
