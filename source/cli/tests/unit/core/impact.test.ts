import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDescendants, handleTypeImpact } from '../../../src/cli/impact-handlers.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import {
  collectReverseDependents,
  buildTransitiveChains,
  collectIndirectDependents,
  nodesWithRefusedVerdict,
  classifyInvalidations,
  touchedReferencesFile,
} from '../../../src/core/graph/impact-graph.js';
import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';
import type { LockFile, VerdictEntry } from '../../../src/model/lock.js';

function makeNode(nodePath: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    path: nodePath,
    meta: { name: nodePath.split('/').pop()!, type: 'service' },
    children: [],
    parent: null,
    ...overrides,
  };
}

function makeGraph(nodes: GraphNode[]): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(nodes.map((n) => [n.path, n])),
    aspects: [],
    flows: [],
    rootPath: '/tmp',
  };
}

function emptyLock(): LockFile {
  return { version: 1, verdicts: {}, nodes: {} };
}

describe('collectReverseDependents', () => {
  it('returns empty when no nodes depend on target', () => {
    const target = makeNode('a');
    const graph = makeGraph([target]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual([]);
    expect(result.allDependents).toEqual([]);
  });

  it('finds direct dependents via structural relations', () => {
    const target = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const graph = makeGraph([target, b]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual(['b']);
    expect(result.allDependents).toEqual(['b']);
  });

  it('ignores event relations for structural reverse dependents', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'emits' }] },
    });
    const graph = makeGraph([a, b]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual([]);
  });

  it('traverses a transitive chain a<-b<-c<-d (BFS pushes unseen nodes; re-converging edge skipped)', () => {
    // a depends-on chain b->a, c->b, d->c, plus a SECOND edge d->b that re-converges
    // on an already-seen node so the `seen.has(next)` continue arm is exercised.
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const c = makeNode('c', {
      meta: { name: 'c', type: 'service', relations: [{ target: 'b', type: 'uses' }] },
    });
    const d = makeNode('d', {
      meta: {
        name: 'd',
        type: 'service',
        relations: [
          { target: 'c', type: 'uses' },
          { target: 'b', type: 'uses' }, // re-converges on b (already seen during BFS)
        ],
      },
    });
    const graph = makeGraph([a, b, c, d]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual(['b']);
    expect(result.allDependents).toEqual(['b', 'c', 'd']);
  });
});

describe('buildTransitiveChains', () => {
  it('chains do NOT include the target node', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const c = makeNode('c', {
      meta: { name: 'c', type: 'service', relations: [{ target: 'b', type: 'uses' }] },
    });
    const graph = makeGraph([a, b, c]);
    const { direct, allDependents, reverse } = collectReverseDependents(graph, 'a');
    const chains = buildTransitiveChains('a', direct, allDependents, reverse);
    expect(chains.length).toBe(1);
    expect(chains[0]).not.toContain('<- a');
    expect(chains[0]).toBe('<- b <- c');
  });

  it('returns empty when no transitive-only deps', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const graph = makeGraph([a, b]);
    const { direct, allDependents, reverse } = collectReverseDependents(graph, 'a');
    const chains = buildTransitiveChains('a', direct, allDependents, reverse);
    expect(chains).toEqual([]);
  });

  it('skips an already-visited node in the parent BFS (re-converging edge d->b)', () => {
    // a<-b<-c<-d with an extra edge d->b. The parent BFS reaches b first via c, then
    // the d->b edge revisits b (already visited) → the visited.has(next) continue arm.
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const c = makeNode('c', {
      meta: { name: 'c', type: 'service', relations: [{ target: 'b', type: 'uses' }] },
    });
    const d = makeNode('d', {
      meta: {
        name: 'd',
        type: 'service',
        relations: [
          { target: 'c', type: 'uses' },
          { target: 'b', type: 'uses' }, // re-converges on b
        ],
      },
    });
    const graph = makeGraph([a, b, c, d]);
    const { direct, allDependents, reverse } = collectReverseDependents(graph, 'a');
    const chains = buildTransitiveChains('a', direct, allDependents, reverse);
    // c and d are transitive-only; chains start after the target node.
    expect(chains).toContain('<- b <- c');
    expect(chains.some((c2) => c2.includes('<- d'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// handleTypeImpact — inherited Object.prototype keys are NOT valid types
// A raw bracket lookup on the plain node_types object would resolve inherited
// members (constructor, toString, valueOf, hasOwnProperty) as truthy and print
// a fabricated zero-impact report at exit 0 for a type that does not exist.
// ────────────────────────────────────────────────────────────────────────────

describe('handleTypeImpact — Object.prototype key guard', () => {
  const fixtureRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../fixtures/sample-project',
  );

  async function runType(
    typeId: string,
  ): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
    const graph = await loadGraph(fixtureRoot);
    let exitCode: number | undefined;
    let stdout = '';
    let stderr = '';
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((s: string) => { stdout += String(s); return true; }) as never);
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((s: string) => { stderr += String(s); return true; }) as never);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`__exit__${exitCode}`);
    }) as never);
    try {
      await handleTypeImpact(graph, typeId, emptyLock());
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith('__exit__')) throw e;
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
    return { exitCode, stdout, stderr };
  }

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'rejects inherited prototype key %s as an unknown type (exit 1, no fabricated report)',
    async (typeId) => {
      const { exitCode, stdout, stderr } = await runType(typeId);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`Type '${typeId}' not found in architecture.`);
      expect(stdout).not.toContain(`Type: ${typeId}`);
    },
  );

  it('still accepts a real architecture type', async () => {
    const { exitCode, stdout } = await runType('module');
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('Type: module');
  });

  it('still rejects an ordinary unknown type id', async () => {
    const { exitCode, stderr } = await runType('does-not-exist');
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Type 'does-not-exist' not found in architecture.");
  });
});

describe('collectDescendants', () => {
  it('returns all descendants of a parent node', () => {
    const parent = makeNode('mod');
    const child1 = makeNode('mod/a', { parent });
    const child2 = makeNode('mod/b', { parent });
    const grandchild = makeNode('mod/a/x', { parent: child1 });
    parent.children = [child1, child2];
    child1.children = [grandchild];
    const graph = makeGraph([parent, child1, child2, grandchild]);
    const result = collectDescendants(graph, 'mod');
    expect(result.sort()).toEqual(['mod/a', 'mod/a/x', 'mod/b']);
  });

  it('returns empty for leaf node', () => {
    const leaf = makeNode('leaf');
    const graph = makeGraph([leaf]);
    expect(collectDescendants(graph, 'leaf')).toEqual([]);
  });
});

describe('collectIndirectDependents', () => {
  it('returns empty when no reverse dependents exist', () => {
    const a = makeNode('a');
    const b = makeNode('b');
    const graph = makeGraph([a, b]);
    const result = collectIndirectDependents(graph, ['a', 'b']);
    expect(result.indirectPaths).toEqual([]);
    expect(result.chains).toEqual([]);
  });

  it('finds reverse dependents of affected nodes', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const graph = makeGraph([a, b]);
    const result = collectIndirectDependents(graph, ['a']);
    expect(result.indirectPaths).toEqual(['b']);
  });

  it('event relations (emits/listens) ARE traversed; a non-structural non-event relation is skipped', () => {
    // collectIndirectDependents keeps structural AND event relations. Feed:
    //  - b -emits-> a   (event: traversed)
    //  - c -listens-> a (event: traversed)
    //  - x -bogus-> a   (neither structural nor emits/listens: the continue arm)
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'emits' }] },
    });
    const c = makeNode('c', {
      meta: { name: 'c', type: 'service', relations: [{ target: 'a', type: 'listens' }] },
    });
    const x = makeNode('x', {
      meta: {
        name: 'x',
        type: 'service',
        // intentionally invalid relation type to drive the skip arm (graph data could
        // be hand-edited; the algorithm must defensively ignore unknown relation types).
        relations: [{ target: 'a', type: 'bogus' as unknown as 'uses' }],
      },
    });
    const graph = makeGraph([a, b, c, x]);
    const result = collectIndirectDependents(graph, ['a']);
    // b and c reach a via event relations → indirect; x's bogus relation is ignored.
    expect(result.indirectPaths).toEqual(expect.arrayContaining(['b', 'c']));
    expect(result.indirectPaths).toHaveLength(2);
    expect(result.indirectPaths).not.toContain('x');
  });

  it('keeps the SHORTEST chain when a node is reachable via two affected nodes (diamond)', () => {
    // d depends on both b and c; b and c both depend on a. Mark BOTH a and b as
    // affected. From a, the chain to d is a<-b<-d (depth 3). From b, the chain to d
    // is b<-d (depth 2). The shorter (b<-d) must win — exercising the
    // `depth < existing.depth` replacement arm. The longer candidate hitting an
    // existing-shorter entry exercises its else.
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const c = makeNode('c', {
      meta: { name: 'c', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const d = makeNode('d', {
      meta: {
        name: 'd',
        type: 'service',
        relations: [
          { target: 'b', type: 'uses' },
          { target: 'c', type: 'uses' },
        ],
      },
    });
    const graph = makeGraph([a, b, c, d]);
    // a and b are both directly affected; c and d are indirect.
    const result = collectIndirectDependents(graph, ['a', 'b']);
    // d is indirect; its kept chain must be the shorter "b<-d" form (depth 2),
    // not the longer "a<-b<-d" (depth 3).
    expect(result.indirectPaths).toContain('d');
    const dChain = result.chains[result.indirectPaths.indexOf('d')];
    expect(dChain).toBe('<- d <- b');
    // c is reached only from a (one hop).
    expect(result.indirectPaths).toContain('c');
  });

  it('does NOT replace an existing shorter chain when a longer one is found later', () => {
    // Same diamond, but affected order ['b','a'] makes the SHORT chain (from b) be
    // recorded FIRST; processing a afterwards finds a LONGER chain to d, and
    // `depth < existing.depth` is FALSE → the existing shorter chain is kept (else arm).
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const c = makeNode('c', {
      meta: { name: 'c', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const d = makeNode('d', {
      meta: {
        name: 'd',
        type: 'service',
        relations: [
          { target: 'b', type: 'uses' },
          { target: 'c', type: 'uses' },
        ],
      },
    });
    const graph = makeGraph([a, b, c, d]);
    const result = collectIndirectDependents(graph, ['b', 'a']); // b first → short chain recorded first
    expect(result.indirectPaths).toContain('d');
    // The shorter chain (from b: depth 2) must be retained.
    const dChain = result.chains[result.indirectPaths.indexOf('d')];
    expect(dChain).toBe('<- d <- b');
  });

  it('skips a directly-affected node when it is reachable from another affected node', () => {
    // b is directly affected AND reachable from affected a. The BFS from a reaches b,
    // but since b is in directSet it must be skipped as an INDIRECT result.
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const graph = makeGraph([a, b]);
    const result = collectIndirectDependents(graph, ['a', 'b']);
    // b is directly affected → never reported as indirect.
    expect(result.indirectPaths).not.toContain('b');
    expect(result.indirectPaths).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Lock-seeded: refused-verdict annotation (spec §8)
// ────────────────────────────────────────────────────────────────────────────

describe('nodesWithRefusedVerdict (lock-seeded)', () => {
  function entry(verdict: 'approved' | 'refused', touched?: VerdictEntry['touched']): VerdictEntry {
    return { verdict, hash: 'h', ...(touched ? { touched } : {}) };
  }

  it('returns empty when the aspect has no verdicts in the lock', () => {
    const graph = makeGraph([makeNode('a')]);
    expect(nodesWithRefusedVerdict(graph, emptyLock(), 'missing-aspect').size).toBe(0);
  });

  it('maps a node:<path> refused entry directly to that node', () => {
    const graph = makeGraph([makeNode('billing/cancel')]);
    const lock: LockFile = {
      version: 1,
      verdicts: {
        shape: {
          'node:billing/cancel': entry('refused'),
          'node:billing/other': entry('approved'),
        },
      },
      nodes: {},
    };
    const result = nodesWithRefusedVerdict(graph, lock, 'shape');
    expect([...result]).toEqual(['billing/cancel']);
  });

  it('resolves a file:<path> refused entry to its owning node through the mapping', () => {
    const owner = makeNode('billing', {
      meta: { name: 'billing', type: 'service', mapping: ['src/billing/x.ts'] },
    });
    // A second node with NO mapping is present — the owner resolver must tolerate it
    // (mapping defaults to []) and still resolve through the mapped node.
    const mappingless = makeNode('organizational', {
      meta: { name: 'organizational', type: 'service' },
    });
    const graph = makeGraph([mappingless, owner]);
    const lock: LockFile = {
      version: 1,
      verdicts: { shape: { 'file:src/billing/x.ts': entry('refused') } },
      nodes: {},
    };
    const result = nodesWithRefusedVerdict(graph, lock, 'shape');
    expect([...result]).toEqual(['billing']);
  });

  it('skips a file:<path> entry that maps to no node (stale lock line)', () => {
    const graph = makeGraph([makeNode('a', { meta: { name: 'a', type: 'service', mapping: ['src/a.ts'] } })]);
    const lock: LockFile = {
      version: 1,
      verdicts: { shape: { 'file:src/gone.ts': entry('refused') } },
      nodes: {},
    };
    expect(nodesWithRefusedVerdict(graph, lock, 'shape').size).toBe(0);
  });

  it('ignores approved entries — only refused verdicts annotate', () => {
    const graph = makeGraph([makeNode('a')]);
    const lock: LockFile = {
      version: 1,
      verdicts: { shape: { 'node:a': entry('approved') } },
      nodes: {},
    };
    expect(nodesWithRefusedVerdict(graph, lock, 'shape').size).toBe(0);
  });

  it('ignores a refused unit key with an unrecognized prefix (neither node: nor file:)', () => {
    // A unit key that is neither node:<path> nor file:<path> falls through both
    // branches and is skipped (the else arm of the file: check).
    const graph = makeGraph([makeNode('a')]);
    const lock: LockFile = {
      version: 1,
      verdicts: { shape: { 'weird:something': entry('refused') } },
      nodes: {},
    };
    expect(nodesWithRefusedVerdict(graph, lock, 'shape').size).toBe(0);
  });
});


describe('nodesWithRefusedVerdict — longest-mapping owner resolution', () => {
  it('resolves a file to the node with the LONGEST matching mapping (child wins)', () => {
    const parent = makeNode('p', { meta: { name: 'p', type: 'service', mapping: ['src'] } });
    const child = makeNode('p/c', { meta: { name: 'c', type: 'service', mapping: ['src/c'] } });
    const graph = makeGraph([parent, child]);
    const lock: LockFile = {
      version: 1,
      // The file src/c/x.ts is in BOTH mappings (src and src/c); the longer wins.
      verdicts: { shape: { 'file:src/c/x.ts': { verdict: 'refused', hash: 'h' } } },
      nodes: {},
    };
    expect([...nodesWithRefusedVerdict(graph, lock, 'shape')]).toEqual(['p/c']);
  });

  it('keeps the longest match even when the longer mapping is encountered FIRST (shorter loses)', () => {
    // Insertion order puts the LONGER mapping (src/c/**) first, then the SHORTER
    // (src/**). BOTH globs match src/c/x.ts. When the second (shorter) mapping is
    // checked, best already holds the longer one and `m.length > best.len` is FALSE —
    // the shorter must NOT replace it.
    const child = makeNode('p/c', { meta: { name: 'c', type: 'service', mapping: ['src/c/**'] } });
    const parent = makeNode('p', { meta: { name: 'p', type: 'service', mapping: ['src/**'] } });
    const graph = makeGraph([child, parent]); // child (longer mapping) inserted first
    const lock: LockFile = {
      version: 1,
      verdicts: { shape: { 'file:src/c/x.ts': { verdict: 'refused', hash: 'h' } } },
      nodes: {},
    };
    expect([...nodesWithRefusedVerdict(graph, lock, 'shape')]).toEqual(['p/c']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Task 1 — synchronous invalidation buckets (classifyInvalidations)
// ────────────────────────────────────────────────────────────────────────────

describe('classifyInvalidations (sync buckets)', () => {
  /**
   * Returns a graph with node 'n' (mapping src/n/**) carrying three aspects:
   *   - 'd' : deterministic
   *   - 'c' : companion-LLM (hasCompanion: true)
   *   - 'p' : plain-LLM with references: [{path: 'src/n/a.ts'}]
   *
   * 'src/n/a.ts' is within node 'n' allowed-reads (it matches the mapping).
   */
  function makeGraphWithAspects(): Graph {
    const nodeN = makeNode('n', {
      meta: {
        name: 'n',
        type: 'service',
        aspects: ['d', 'c', 'p'],
        mapping: ['src/n'],
      },
    });
    const detAspect: AspectDef = {
      id: 'd',
      name: 'd',
      reviewer: { type: 'deterministic' },
      artifacts: [],
    };
    const companionAspect: AspectDef = {
      id: 'c',
      name: 'c',
      reviewer: { type: 'llm' },
      artifacts: [],
      hasCompanion: true,
    };
    const plainLlmAspect: AspectDef = {
      id: 'p',
      name: 'p',
      reviewer: { type: 'llm' },
      artifacts: [],
      references: [{ path: 'src/n/a.ts' }],
    };
    return {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['n', nodeN]]),
      aspects: [detAspect, companionAspect, plainLlmAspect],
      flows: [],
      rootPath: '/tmp',
    };
  }

  it('admits via subject, reference, warm-observation; defers cold companion-LLM', () => {
    const graph = makeGraphWithAspects(); // det aspect 'd' on node 'n', companion-LLM 'c' on 'n', plain-LLM 'p' on 'n'
    const F = 'src/n/a.ts';
    const pairs = [
      { aspectId: 'd', kind: 'deterministic', unitKey: 'file:src/n/a.ts', nodePath: 'n', subjectFiles: ['src/n/a.ts'] },
      { aspectId: 'p', kind: 'llm', unitKey: 'node:n', nodePath: 'n', subjectFiles: ['src/n/b.ts'] }, // references F
      { aspectId: 'c', kind: 'llm', unitKey: 'file:src/n/x.md', nodePath: 'n', subjectFiles: ['src/n/x.md'] }, // cold companion, F in allowed-reads
    ] as any;
    // ensure: aspect 'p' declares references:[{path:'src/n/a.ts'}]; lock empty (all cold); F in node 'n' allowed-reads.
    const lock = { version: 1, verdicts: {}, nodes: {} } as any;
    const { pairs: admitted, coldCompanionCandidates } = classifyInvalidations(pairs, graph, F, lock);
    expect(admitted.find(x => x.aspectId === 'd')?.reasons).toEqual(['own']);
    expect(admitted.find(x => x.aspectId === 'p')?.reasons).toContain('reference');
    expect(coldCompanionCandidates.map(x => x.aspectId)).toEqual(['c']);
    expect(admitted.find(x => x.aspectId === 'c')).toBeUndefined();
  });

  it('warm deterministic observation referencing F => observe-deterministic, precise', () => {
    const graph = makeGraphWithAspects();
    const F = 'src/other/probe.ts';
    const pairs = [{ aspectId: 'd', kind: 'deterministic', unitKey: 'node:n', nodePath: 'n', subjectFiles: ['src/n/a.ts'] }] as any;
    const lock = { version: 1, verdicts: { d: { 'node:n': { verdict: 'approved', touched: [['read:src/other/probe.ts', 'h']] } } }, nodes: {} } as any;
    const { pairs: admitted } = classifyInvalidations(pairs, graph, F, lock);
    expect(admitted[0].reasons).toEqual(['observe-deterministic']);
    expect(admitted[0].mode).toBe('precise');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// touchedReferencesFile — every switch branch
// ────────────────────────────────────────────────────────────────────────────

describe('touchedReferencesFile', () => {
  it('returns false when touched is undefined', () => {
    expect(touchedReferencesFile(undefined, 'src/a/b.ts')).toBe(false);
  });

  it('returns false when touched is an empty array', () => {
    expect(touchedReferencesFile([], 'src/a/b.ts')).toBe(false);
  });

  it('skips a key with no colon (no-colon continue arm) and returns false', () => {
    // A key with no ':' hits the `sep < 0` continue and is silently ignored.
    expect(touchedReferencesFile([['weird', 'h']], 'src/a/b.ts')).toBe(false);
  });

  it('read:<F> matching repoRelative returns true', () => {
    expect(touchedReferencesFile([['read:src/a/b.ts', 'h']], 'src/a/b.ts')).toBe(true);
  });

  it('read:<other> (non-matching file) returns false', () => {
    expect(touchedReferencesFile([['read:src/other/c.ts', 'h']], 'src/a/b.ts')).toBe(false);
  });

  it('exists:<F> matching repoRelative returns true', () => {
    expect(touchedReferencesFile([['exists:src/a/b.ts', 'h']], 'src/a/b.ts')).toBe(true);
  });

  it('exists:<other> (non-matching file) returns false', () => {
    expect(touchedReferencesFile([['exists:src/a/c.ts', 'h']], 'src/a/b.ts')).toBe(false);
  });

  it('list:<dir> matching dirname of repoRelative returns true', () => {
    // repoRelative='src/a/b.ts' → dirname='src/a'; key list:src/a matches
    expect(touchedReferencesFile([['list:src/a', 'h']], 'src/a/b.ts')).toBe(true);
  });

  it('list:<other-dir> not matching dirname returns false', () => {
    expect(touchedReferencesFile([['list:src/other', 'h']], 'src/a/b.ts')).toBe(false);
  });

  it('graph:<nodePath> whose yg-node.yaml matches repoRelative returns true', () => {
    // target='cli/x' → .yggdrasil/model/cli/x/yg-node.yaml
    const repoRel = '.yggdrasil/model/cli/x/yg-node.yaml';
    expect(touchedReferencesFile([['graph:cli/x', 'h']], repoRel)).toBe(true);
  });

  it('graph:<nodePath> whose yg-node.yaml does NOT match repoRelative returns false', () => {
    expect(touchedReferencesFile([['graph:cli/x', 'h']], '.yggdrasil/model/cli/y/yg-node.yaml')).toBe(false);
  });

  it('graph-children:<parentNodePath> whose yg-node.yaml matches repoRelative returns true', () => {
    // graph-children maps to the parent node's yg-node.yaml, same as graph:<parent>
    const repoRel = '.yggdrasil/model/cli/x/yg-node.yaml';
    expect(touchedReferencesFile([['graph-children:cli/x', 'h']], repoRel)).toBe(true);
  });

  it('graph-children:<parentNodePath> not matching repoRelative returns false', () => {
    expect(touchedReferencesFile([['graph-children:cli/x', 'h']], '.yggdrasil/model/cli/y/yg-node.yaml')).toBe(false);
  });

  it('graph-flow:<flowName> whose yg-flow.yaml matches repoRelative returns true', () => {
    // target='checkout' → .yggdrasil/flows/checkout/yg-flow.yaml
    const repoRel = '.yggdrasil/flows/checkout/yg-flow.yaml';
    expect(touchedReferencesFile([['graph-flow:checkout', 'h']], repoRel)).toBe(true);
  });

  it('graph-flow:<flowName> not matching repoRelative returns false', () => {
    expect(touchedReferencesFile([['graph-flow:checkout', 'h']], '.yggdrasil/flows/other/yg-flow.yaml')).toBe(false);
  });

  it('graph-bytype:<type> (default branch) never matches — returns false', () => {
    // graph-bytype is intentionally not file-matchable; hits the default break.
    expect(touchedReferencesFile([['graph-bytype:service', 'h']], 'anything.ts')).toBe(false);
  });

  it('returns true on first match when multiple keys are present', () => {
    // first key misses, second key hits read:
    expect(touchedReferencesFile([
      ['read:src/a/other.ts', 'h'],
      ['read:src/a/b.ts', 'h'],
    ], 'src/a/b.ts')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// classifyInvalidations — cold-deterministic-potential branch (lines 340-342)
// ────────────────────────────────────────────────────────────────────────────

describe('classifyInvalidations — cold-deterministic-potential branch', () => {
  /**
   * Build a graph where node 'det-node' has:
   *   - mapping: ['src/det'] (so 'src/det/file.ts' is in allowed-reads)
   *   - one deterministic aspect 'det-aspect'
   * No lock entry for the pair → cold path.
   */
  function makeDetGraph(): Graph {
    const nodeN = makeNode('det-node', {
      meta: {
        name: 'det-node',
        type: 'service',
        aspects: ['det-aspect'],
        mapping: ['src/det'],
      },
    });
    const detAspect: AspectDef = {
      id: 'det-aspect',
      name: 'det-aspect',
      reviewer: { type: 'deterministic' },
      artifacts: [],
    };
    return {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['det-node', nodeN]]),
      aspects: [detAspect],
      flows: [],
      rootPath: '/tmp',
    };
  }

  it('cold deterministic pair whose allowed-reads INCLUDES F => admitted with cold-potential-deterministic + potential', () => {
    const graph = makeDetGraph();
    // 'src/det/file.ts' is under 'src/det' mapping → in allowed-reads
    const F = 'src/det/file.ts';
    const pairs = [
      {
        aspectId: 'det-aspect',
        kind: 'deterministic',
        unitKey: 'node:det-node',
        nodePath: 'det-node',
        subjectFiles: ['src/det/other.ts'], // F is NOT the subject file
      },
    ] as any;
    const lock: LockFile = { version: 1, verdicts: {}, nodes: {} }; // no entry → cold
    const { pairs: admitted, coldCompanionCandidates } = classifyInvalidations(pairs, graph, F, lock);
    expect(coldCompanionCandidates).toHaveLength(0);
    const hit = admitted.find((p) => p.aspectId === 'det-aspect');
    expect(hit).toBeDefined();
    expect(hit!.reasons).toEqual(['cold-potential-deterministic']);
    expect(hit!.mode).toBe('potential');
  });

  it('cold deterministic pair whose allowed-reads does NOT include F => NOT admitted', () => {
    const graph = makeDetGraph();
    // 'src/other/file.ts' is NOT under 'src/det' → not in allowed-reads
    const F = 'src/other/file.ts';
    const pairs = [
      {
        aspectId: 'det-aspect',
        kind: 'deterministic',
        unitKey: 'node:det-node',
        nodePath: 'det-node',
        subjectFiles: ['src/det/a.ts'],
      },
    ] as any;
    const lock: LockFile = { version: 1, verdicts: {}, nodes: {} };
    const { pairs: admitted, coldCompanionCandidates } = classifyInvalidations(pairs, graph, F, lock);
    expect(coldCompanionCandidates).toHaveLength(0);
    expect(admitted.find((p) => p.aspectId === 'det-aspect')).toBeUndefined();
  });
});
