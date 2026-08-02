import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { classifyFile } from '../../../src/core/type-classifier.js';
import { TypeClassCache, typeClassCacheDir } from '../../../src/io/type-class-cache.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';
import * as fileWhenEvaluator from '../../../src/core/file-when-evaluator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '../../fixtures/type-coverage-basic');

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function copyFixture(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'yg-type-class-cache-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

async function countEvalCalls(fn: () => Promise<unknown>): Promise<number> {
  let calls = 0;
  const real = fileWhenEvaluator.evaluateFileWhen;
  const spy = vi.spyOn(fileWhenEvaluator, 'evaluateFileWhen').mockImplementation(async (...args) => {
    calls++;
    return real(...args);
  });
  await fn();
  spy.mockRestore();
  return calls;
}

/** Recursively find every shard file written under a cache directory tree. */
function findShardFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = path.join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.json')) out.push(p);
    }
  };
  try {
    walk(root);
  } catch {
    // cache dir not created yet — no shards
  }
  return out;
}

describe('TypeClassCache — cache-hit contract (not "zero fs reads": bytes are still hashed to form the key, per the AST-cache precedent)', () => {
  it('a second classifyFile call on an UNCHANGED file calls evaluateFileWhen ZERO times', async () => {
    const d = copyFixture();
    const graph = await loadGraph(d);
    const classCache = new TypeClassCache(d, graph.architecture);
    const absPath = path.join(d, 'src/svc/handler.ts');

    const firstRunCalls = await countEvalCalls(() =>
      classifyFile(absPath, 'src/svc/handler.ts', graph, new FileContentCache(), classCache),
    );
    expect(firstRunCalls).toBeGreaterThan(0); // cold cache: every classifying type evaluated

    const secondRunCalls = await countEvalCalls(() =>
      classifyFile(absPath, 'src/svc/handler.ts', graph, new FileContentCache(), classCache),
    );
    expect(secondRunCalls).toBe(0); // same TypeClassCache instance, cache hit
  });

  it('a FRESH TypeClassCache instance (new process, same on-disk cache dir) still hits — the cache is PERSISTENT, not in-memory-only', async () => {
    const d = copyFixture();
    const graph = await loadGraph(d);
    const absPath = path.join(d, 'src/svc/handler.ts');
    await classifyFile(absPath, 'src/svc/handler.ts', graph, new FileContentCache(), new TypeClassCache(d, graph.architecture));

    const reloadedCalls = await countEvalCalls(() =>
      classifyFile(absPath, 'src/svc/handler.ts', graph, new FileContentCache(), new TypeClassCache(d, graph.architecture)),
    );
    expect(reloadedCalls).toBe(0);
  });

  it('editing the FILE\'s content invalidates its cache entry', async () => {
    const d = copyFixture();
    const graph = await loadGraph(d);
    const absPath = path.join(d, 'src/svc/handler.ts');
    await classifyFile(absPath, 'src/svc/handler.ts', graph, new FileContentCache(), new TypeClassCache(d, graph.architecture));

    writeFileSync(absPath, '// edited content\nexport const x = 2;\n');

    const calls = await countEvalCalls(() =>
      classifyFile(absPath, 'src/svc/handler.ts', graph, new FileContentCache(), new TypeClassCache(d, graph.architecture)),
    );
    expect(calls).toBeGreaterThan(0); // new content hash → cache miss
  });

  it('editing an ARCHITECTURE predicate (when:) invalidates EVERY file\'s cache entry, not just files matching the edited type', async () => {
    const d = copyFixture();
    const graphOn = await loadGraph(d);
    const handlerPath = path.join(d, 'src/svc/handler.ts');
    const specialPath = path.join(d, 'src/util/special.ts');
    const cacheV1 = new TypeClassCache(d, graphOn.architecture);
    await classifyFile(handlerPath, 'src/svc/handler.ts', graphOn, new FileContentCache(), cacheV1);
    await classifyFile(specialPath, 'src/util/special.ts', graphOn, new FileContentCache(), cacheV1);

    // Edit the 'big' type's when — unrelated to either file's own match —
    // in memory (a real edit would rewrite yg-architecture.yaml; the
    // in-memory graph value is the same seam type-coverage.test.ts's own
    // withTypeLevel() helper already exploits for flag-off twins).
    const editedArch = {
      ...graphOn.architecture,
      node_types: {
        ...graphOn.architecture.node_types,
        big: { ...graphOn.architecture.node_types.big, when: { content: 'DIFFERENT_MARKER' } },
      },
    };
    const cacheV2 = new TypeClassCache(d, editedArch);
    const graphV2 = { ...graphOn, architecture: editedArch };

    const handlerCalls = await countEvalCalls(() =>
      classifyFile(handlerPath, 'src/svc/handler.ts', graphV2, new FileContentCache(), cacheV2),
    );
    const specialCalls = await countEvalCalls(() =>
      classifyFile(specialPath, 'src/util/special.ts', graphV2, new FileContentCache(), cacheV2),
    );
    expect(handlerCalls).toBeGreaterThan(0);
    expect(specialCalls).toBeGreaterThan(0);
  });

  it('editing ONLY enforce: (strict flag), with an UNCHANGED when predicate, ALSO invalidates the cache — the result BUCKET changes even though the boolean match result does not', async () => {
    const d = copyFixture();
    const graphOn = await loadGraph(d);
    const utilPath = path.join(d, 'src/util/special.ts'); // matches BOTH util (non-strict) and special (strict) in the fixture
    const cacheV1 = new TypeClassCache(d, graphOn.architecture);
    await classifyFile(utilPath, 'src/util/special.ts', graphOn, new FileContentCache(), cacheV1);

    // Flip 'util' (currently non-strict) to enforce: strict — when: UNCHANGED.
    const editedArch = {
      ...graphOn.architecture,
      node_types: {
        ...graphOn.architecture.node_types,
        util: { ...graphOn.architecture.node_types.util, enforce: 'strict' as const },
      },
    };
    const cacheV2 = new TypeClassCache(d, editedArch);
    const graphV2 = { ...graphOn, architecture: editedArch };

    const calls = await countEvalCalls(() =>
      classifyFile(utilPath, 'src/util/special.ts', graphV2, new FileContentCache(), cacheV2),
    );
    // A cache keyed on `when` alone would wrongly HIT here (the predicate
    // text is byte-identical) — the architecturePredicateHash MUST fold
    // `enforce` too, or a strict/non-strict re-bucketing would silently
    // reuse a stale classification.
    expect(calls).toBeGreaterThan(0);
  });

  it('a cache entry whose v field is stale is treated as a miss, never trusted (fail-closed, mirroring facts-cache.ts loadFacts)', async () => {
    const d = copyFixture();
    const graph = await loadGraph(d);
    const absPath = path.join(d, 'src/svc/handler.ts');
    const classCache = new TypeClassCache(d, graph.architecture);
    await classifyFile(absPath, 'src/svc/handler.ts', graph, new FileContentCache(), classCache);

    // Corrupt the on-disk shard's version field directly (fail-closed
    // validation must reject on `v` BEFORE trusting anything else in the file).
    const shards = findShardFiles(typeClassCacheDir(d));
    expect(shards.length).toBe(1); // exactly one file classified so far
    const body = JSON.parse(readFileSync(shards[0], 'utf-8'));
    body.v = -1;
    writeFileSync(shards[0], JSON.stringify(body));

    const calls = await countEvalCalls(() =>
      classifyFile(absPath, 'src/svc/handler.ts', graph, new FileContentCache(), new TypeClassCache(d, graph.architecture)),
    );
    expect(calls).toBeGreaterThan(0);
  });
});
