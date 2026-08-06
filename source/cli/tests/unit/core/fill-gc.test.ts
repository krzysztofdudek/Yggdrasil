/**
 * Unit tests for core/fill-gc.ts — the fill stage's garbage collection and
 * canonical lock rewrite (spec §3.2).
 *
 * These exercise the exported functions directly against in-memory graphs
 * built with real on-disk files (so computeExpectedPairs / computeSourceFingerprint
 * resolve actual mappings):
 *
 *   buildOwnerIndex().ownerOf — the shared hierarchy-first (child-wins)
 *                             attribution over overlapping parent/child mappings;
 *                             undefined for an unmapped file. (fill-gc's own
 *                             owner resolution now delegates here.)
 *   owningNodeForUnitKey    — node:<path> pass-through; file:<path> via the
 *                             shared resolver; null for a file mapped to no node.
 *   garbageCollectAndRewrite — prunes verdicts whose pair left the expected
 *                             universe and nodes[] entries for vanished node
 *                             paths, retains entries owned by an uncomputable
 *                             (implies-cycle) node, sets lock.version, and
 *                             persists exactly once.
 *
 * The graph builder mirrors buildPairsGraph in pairs.test.ts (same Graph shape),
 * extended with an `implies` field so an implies-cycle node can be constructed
 * to drive computeUncomputableNodes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  owningNodeForUnitKey,
  garbageCollectAndRewrite,
} from '../../../src/core/fill-gc.js';
import { buildOwnerIndex } from '../../../src/relations/owner-index.js';

/**
 * Whether this runtime actually enforces a chmod(0o000) restriction on a file
 * readable by its owner. A privileged process (root, or certain containers)
 * ignores file mode bits entirely, so a test relying on the file genuinely
 * being unreadable under 0o000 cannot execute there — it would exercise the
 * ordinary "still valid, still mapped" retention path instead of the
 * unreadable-subject retention path it claims to pin, passing for the wrong
 * reason. Probed ONCE at module load so the affected tests can be marked
 * SKIPPED for this environment via `it.skipIf`.
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
import { LOCK_FORMAT_VERSION } from '../../../src/model/lock.js';
import type { LockFile } from '../../../src/model/lock.js';
import { fileUnit, nodeUnit } from '../../../src/model/lock.js';
import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';

// ---------------------------------------------------------------------------
// In-memory graph builder (mirrors buildPairsGraph; adds `implies`)
// ---------------------------------------------------------------------------

interface GcTestAspect {
  id: string;
  kind?: 'llm' | 'deterministic' | 'aggregate';
  status?: 'draft' | 'advisory' | 'enforced';
  implies?: string[];
  scope?: { per: 'node' | 'file' };
}

interface GcTestNode {
  path: string;       // model-relative node path
  mapping?: string[]; // repo-relative paths (relative to tmpDir)
  aspects?: string[];
  parent?: string;
}

function buildGraph(
  tmpDir: string,
  nodes: GcTestNode[],
  aspects: GcTestAspect[],
): Graph {
  const rootPath = path.join(tmpDir, '.yggdrasil');
  mkdirSync(rootPath, { recursive: true });

  const aspectDefs: AspectDef[] = aspects.map((a) => {
    const kind = a.kind ?? 'deterministic';
    return {
      id: a.id,
      name: a.id,
      reviewer: { type: kind },
      status: a.status ?? 'enforced',
      implies: a.implies,
      scope: a.scope,
      artifacts:
        kind === 'aggregate'
          ? []
          : [{ filename: kind === 'llm' ? 'content.md' : 'check.mjs', content: 'rule' }],
    } as AspectDef;
  });

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
    architecture: { node_types: { service: { description: 'test' } } },
    nodes: nodeByPath,
    aspects: aspectDefs,
    flows: [],
    rootPath,
  } as unknown as Graph;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-fill-gc-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content = 'content'): void {
  const abs = path.join(tmpDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

// ===========================================================================
// buildOwnerIndex().ownerOf — the shared attribution fill-gc now delegates to
// ===========================================================================

describe('fill-gc file attribution (shared owner index)', () => {
  it('a file under the deeper of two overlapping mappings attributes to the deeper node (child wins)', () => {
    // Node A maps `src` (whole dir); node B maps `src/sub` (deeper). A file under
    // src/sub is covered by BOTH mappings; hierarchy-first (child-wins) picks B.
    const graph = buildGraph(
      tmpDir,
      [
        { path: 'a', mapping: ['src'] },
        { path: 'b', mapping: ['src/sub'] },
      ],
      [],
    );
    expect(buildOwnerIndex(graph.nodes).ownerOf('src/sub/leaf.ts')).toBe('b');
  });

  it('a file under only the broad mapping attributes to that node (not the deeper one)', () => {
    const graph = buildGraph(
      tmpDir,
      [
        { path: 'a', mapping: ['src'] },
        { path: 'b', mapping: ['src/sub'] },
      ],
      [],
    );
    // src/top.ts is under `src` but NOT under `src/sub` → owned by A only.
    expect(buildOwnerIndex(graph.nodes).ownerOf('src/top.ts')).toBe('a');
  });

  it('an unmapped file attributes to no node (undefined)', () => {
    const graph = buildGraph(
      tmpDir,
      [{ path: 'a', mapping: ['src'] }],
      [],
    );
    expect(buildOwnerIndex(graph.nodes).ownerOf('docs/readme.md')).toBeUndefined();
  });
});

// ===========================================================================
// owningNodeForUnitKey — node:/file: routing
// ===========================================================================

describe('owningNodeForUnitKey', () => {
  it('a node:<path> key passes the node path straight through (no mapping lookup)', () => {
    // The node path in the key need not even exist in the graph — node: keys are
    // returned verbatim by construction.
    const graph = buildGraph(tmpDir, [{ path: 'a', mapping: ['src'] }], []);
    const ownerOf = buildOwnerIndex(graph.nodes).ownerOf;
    expect(owningNodeForUnitKey(ownerOf, nodeUnit('some/deep/node'))).toBe('some/deep/node');
  });

  it('a file:<mapped> key resolves through the shared owner index to the owning node', () => {
    const graph = buildGraph(
      tmpDir,
      [
        { path: 'a', mapping: ['src'] },
        { path: 'b', mapping: ['src/sub'] },
      ],
      [],
    );
    // file: routes through the shared resolver → deeper node (b) wins.
    const ownerOf = buildOwnerIndex(graph.nodes).ownerOf;
    expect(owningNodeForUnitKey(ownerOf, fileUnit('src/sub/leaf.ts'))).toBe('b');
  });

  it('a file:<unmapped> key resolves to null (genuinely detached)', () => {
    const graph = buildGraph(tmpDir, [{ path: 'a', mapping: ['src'] }], []);
    const ownerOf = buildOwnerIndex(graph.nodes).ownerOf;
    expect(owningNodeForUnitKey(ownerOf, fileUnit('elsewhere/x.ts'))).toBeNull();
  });
});

// ===========================================================================
// garbageCollectAndRewrite — prune / retain / version / persist
// ===========================================================================

describe('garbageCollectAndRewrite', () => {
  it('prunes a verdict whose pair left the expected universe (detached aspect, vanished node, unmapped file) and persists once, stamping the lock version', async () => {
    // The graph has exactly ONE expected pair: aspect `live` on node:svc.
    // The seeded lock contains that valid entry PLUS three entries that are no
    // longer in the universe:
    //   - ghost-aspect on node:svc      → aspect not attached to svc (detached)
    //   - live           on node:ghost  → node 'ghost' is not in the graph
    //   - live           on file:gone.ts→ file maps to no node (unmapped)
    // GC must keep the live entry and prune all three detached entries.
    writeFile('src/svc.ts', 'export const x = 1;');
    const graph = buildGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/svc.ts'], aspects: ['live'] }],
      [{ id: 'live', kind: 'deterministic' }],
    );

    const lock: LockFile = {
      version: 0, // deliberately stale → GC must stamp it to LOCK_FORMAT_VERSION
      verdicts: {
        live: {
          [nodeUnit('svc')]: { verdict: 'approved', hash: 'h-live' },
          [nodeUnit('ghost')]: { verdict: 'approved', hash: 'h-ghost-node' },
          [fileUnit('gone.ts')]: { verdict: 'approved', hash: 'h-gone-file' },
        },
        'ghost-aspect': {
          [nodeUnit('svc')]: { verdict: 'approved', hash: 'h-ghost-aspect' },
        },
      },
      nodes: {},
    };

    let persistCalls = 0;
    await garbageCollectAndRewrite(graph, lock, async () => { persistCalls += 1; });

    // The one valid entry survives untouched.
    expect(lock.verdicts['live']?.[nodeUnit('svc')]?.hash).toBe('h-live');
    // The detached-node and unmapped-file entries under `live` are pruned.
    expect(lock.verdicts['live']?.[nodeUnit('ghost')]).toBeUndefined();
    expect(lock.verdicts['live']?.[fileUnit('gone.ts')]).toBeUndefined();
    // The fully-detached aspect's unit map is emptied → the aspect key is dropped.
    expect(lock.verdicts['ghost-aspect']).toBeUndefined();
    // The lock version was stamped, and persist ran exactly once.
    expect(lock.version).toBe(LOCK_FORMAT_VERSION);
    expect(persistCalls).toBe(1);
  });

  it('prunes nodes[] entries for node paths absent from the graph, keeping present ones', async () => {
    writeFile('src/svc.ts', 'export const x = 1;');
    const graph = buildGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/svc.ts'], aspects: ['live'] }],
      [{ id: 'live', kind: 'deterministic' }],
    );

    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {},
      nodes: {
        svc: { source: 'fp-svc' },        // present in graph → kept
        'ghost/node': { source: 'fp-x' }, // absent from graph → pruned
      },
    };

    await garbageCollectAndRewrite(graph, lock, async () => {});

    expect(lock.nodes['svc']).toBeDefined();
    expect(lock.nodes['svc']?.source).toBe('fp-svc');
    expect(lock.nodes['ghost/node']).toBeUndefined();
  });

  it('retains a verdict owned by an uncomputable (implies-cycle) node while still pruning a genuinely-detached entry', async () => {
    // Node `cyc` carries det-a, which implies det-b, which implies det-a — a
    // cycle. computeEffectiveAspects throws for cyc, so it contributes ZERO pairs
    // to the universe; computeUncomputableNodes flags it, and GC must RETAIN its
    // entry (a paid verdict, not provably detached). The clean node `svc` (aspect
    // `live`) contributes its pair normally. A `ghost-aspect` entry on node:svc
    // is genuinely detached and must be pruned even though its owning node IS
    // computable — proving the retain rule keys on uncomputability, not merely on
    // owner-resolves-to-a-node.
    writeFile('src/svc.ts', 'export const x = 1;');
    writeFile('src/cyc.ts', 'export const y = 2;');
    const graph = buildGraph(
      tmpDir,
      [
        { path: 'svc', mapping: ['src/svc.ts'], aspects: ['live'] },
        { path: 'cyc', mapping: ['src/cyc.ts'], aspects: ['det-a'] },
      ],
      [
        { id: 'live', kind: 'deterministic' },
        { id: 'det-a', kind: 'deterministic', implies: ['det-b'] },
        { id: 'det-b', kind: 'deterministic', implies: ['det-a'] }, // cycle
      ],
    );

    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        'det-a': { [nodeUnit('cyc')]: { verdict: 'approved', hash: 'h-cyc' } },
        live: { [nodeUnit('svc')]: { verdict: 'approved', hash: 'h-live' } },
        'ghost-aspect': { [nodeUnit('svc')]: { verdict: 'approved', hash: 'h-ghost' } },
      },
      nodes: {},
    };

    await garbageCollectAndRewrite(graph, lock, async () => {});

    // The cycle node's entry survives (uncomputable → not provably detached).
    expect(lock.verdicts['det-a']?.[nodeUnit('cyc')]?.hash).toBe('h-cyc');
    // The clean node's expected pair survives.
    expect(lock.verdicts['live']?.[nodeUnit('svc')]?.hash).toBe('h-live');
    // The genuinely-detached entry on a COMPUTABLE node is still pruned.
    expect(lock.verdicts['ghost-aspect']).toBeUndefined();
  });

  it('keeps a draft aspect pair entry (GC universe includes draft pairs)', async () => {
    // The GC universe is computed with includeDraft: true, so a draft aspect's
    // pair stays in the universe and its entry is retained even though plain check
    // would not expect it.
    writeFile('src/svc.ts', 'export const x = 1;');
    const graph = buildGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/svc.ts'], aspects: ['wip'] }],
      [{ id: 'wip', kind: 'deterministic', status: 'draft' }],
    );

    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        wip: { [nodeUnit('svc')]: { verdict: 'approved', hash: 'h-wip' } },
      },
      nodes: {},
    };

    await garbageCollectAndRewrite(graph, lock, async () => {});

    expect(lock.verdicts['wip']?.[nodeUnit('svc')]?.hash).toBe('h-wip');
  });

  it('skips pruning AND the rewrite entirely when the graph carries a node parse error (a hidden node/subtree must not make its verdicts look detached)', async () => {
    // A yg-node.yaml parse failure removes the node (and its subtree) from the
    // graph, so its pairs never reach the universe. GC must NOT prune the seeded
    // entries and must NOT rewrite/stamp the committed lock this run.
    writeFile('src/svc.ts', 'export const x = 1;');
    const graph = buildGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/svc.ts'], aspects: ['live'] }],
      [{ id: 'live', kind: 'deterministic' }],
    );
    (graph as unknown as { nodeParseErrors: unknown[] }).nodeParseErrors = [
      { nodePath: 'broken', messageData: { what: 'x', why: 'y', next: 'z' } },
    ];

    const lock: LockFile = {
      version: 0, // must stay 0 — the guard returns before stamping
      verdicts: {
        // `broken` is hidden by the parse error; without the guard its entry would
        // be pruned as detached. It must survive untouched.
        live: {
          [nodeUnit('svc')]: { verdict: 'approved', hash: 'h-live' },
          [nodeUnit('broken')]: { verdict: 'approved', hash: 'h-broken' },
        },
      },
      nodes: {},
    };

    let persistCalls = 0;
    await garbageCollectAndRewrite(graph, lock, async () => { persistCalls += 1; });

    expect(lock.verdicts['live']?.[nodeUnit('svc')]?.hash).toBe('h-live');
    expect(lock.verdicts['live']?.[nodeUnit('broken')]?.hash).toBe('h-broken');
    expect(lock.version).toBe(0);
    expect(persistCalls).toBe(0);
  });

  it('skips pruning entirely when the graph carries an aspect parse error', async () => {
    writeFile('src/svc.ts', 'export const x = 1;');
    const graph = buildGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/svc.ts'], aspects: ['live'] }],
      [{ id: 'live', kind: 'deterministic' }],
    );
    (graph as unknown as { aspectParseErrors: unknown[] }).aspectParseErrors = [
      { aspectId: 'broken-aspect', code: 'yaml-invalid', messageData: { what: 'x', why: 'y', next: 'z' } },
    ];

    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        // Aspect absent from graph.aspects → normally pruned repo-wide. Retained.
        'broken-aspect': { [nodeUnit('svc')]: { verdict: 'approved', hash: 'h-x' } },
      },
      nodes: {},
    };

    let persistCalls = 0;
    await garbageCollectAndRewrite(graph, lock, async () => { persistCalls += 1; });

    expect(lock.verdicts['broken-aspect']?.[nodeUnit('svc')]?.hash).toBe('h-x');
    expect(persistCalls).toBe(0);
  });

  it.skipIf(!ENFORCES_FILE_PERMISSIONS)('retains a per:node verdict whose only subject file is unreadable this run (not positively detached)', async () => {
    // The mapped subject is chmod 000 → probeUnreadable flags it, the subject set
    // empties, and no pair is emitted for aspect `live` on node:svc. Without the
    // guard GC would prune the (still-valid, still-mapped) verdict.
    writeFile('src/svc.ts', 'export const x = 1;');
    const graph = buildGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/svc.ts'], aspects: ['live'] }],
      [{ id: 'live', kind: 'deterministic' }],
    );

    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        live: { [nodeUnit('svc')]: { verdict: 'approved', hash: 'h-live' } },
        // A genuinely-detached aspect on the SAME node must still prune — the
        // unreadable retention is keyed exactly per (aspect, unit).
        'ghost-aspect': { [nodeUnit('svc')]: { verdict: 'approved', hash: 'h-ghost' } },
      },
      nodes: {},
    };

    chmodSync(path.join(tmpDir, 'src/svc.ts'), 0o000);
    try {
      await garbageCollectAndRewrite(graph, lock, async () => {});
    } finally {
      chmodSync(path.join(tmpDir, 'src/svc.ts'), 0o644);
    }

    expect(lock.verdicts['live']?.[nodeUnit('svc')]?.hash).toBe('h-live');
    expect(lock.verdicts['ghost-aspect']).toBeUndefined();
  });

  it.skipIf(!ENFORCES_FILE_PERMISSIONS)('retains a per:file verdict whose subject file is unreadable this run', async () => {
    writeFile('src/svc.ts', 'export const x = 1;');
    const graph = buildGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/svc.ts'], aspects: ['live'] }],
      [{ id: 'live', kind: 'deterministic', scope: { per: 'file' } }],
    );

    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        live: { [fileUnit('src/svc.ts')]: { verdict: 'approved', hash: 'h-file' } },
      },
      nodes: {},
    };

    chmodSync(path.join(tmpDir, 'src/svc.ts'), 0o000);
    try {
      await garbageCollectAndRewrite(graph, lock, async () => {});
    } finally {
      chmodSync(path.join(tmpDir, 'src/svc.ts'), 0o644);
    }

    expect(lock.verdicts['live']?.[fileUnit('src/svc.ts')]?.hash).toBe('h-file');
  });
});
