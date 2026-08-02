import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, cpSync, rmSync, symlinkSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// Every way two DIFFERENT files can look identical to the cache key, enumerated
// and driven individually. The fixture's `svc` type matches src/svc/**, `util`
// matches src/util/** (plus two unrelated extra paths — see the fixture's own
// yg-architecture.yaml), so a file's DIRECTORY alone decides which of the two
// it matches — the cheapest possible probe for "did this file get judged
// against the file at some OTHER path's rules".
// ---------------------------------------------------------------------------
describe('TypeClassCache — the look-identical-to-the-key class (a file must never be judged against a DIFFERENT file\'s cached classification)', () => {
  it('two files with byte-identical content at different paths, matching different types, classify independently — not a shared shard', async () => {
    const d = copyFixture();
    const graph = await loadGraph(d);
    const classCache = new TypeClassCache(d, graph.architecture);
    const body = 'export const shared = 1;\n';
    writeFileSync(path.join(d, 'src/svc/dup.ts'), body);
    writeFileSync(path.join(d, 'src/util/dup.ts'), body);

    const svc = await classifyFile(path.join(d, 'src/svc/dup.ts'), 'src/svc/dup.ts', graph, new FileContentCache(), classCache);
    const util = await classifyFile(path.join(d, 'src/util/dup.ts'), 'src/util/dup.ts', graph, new FileContentCache(), classCache);

    expect(svc.matches.map((m) => m.typeId)).toEqual(['svc']);
    expect(util.matches.map((m) => m.typeId)).toEqual(['util']);
    expect(findShardFiles(typeClassCacheDir(d)).length).toBe(2); // two distinct identities, two shards
  });

  it('two EMPTY files (the ordinary .gitkeep / empty-index.ts shape) at different paths classify independently', async () => {
    const d = copyFixture();
    const graph = await loadGraph(d);
    const classCache = new TypeClassCache(d, graph.architecture);
    writeFileSync(path.join(d, 'src/svc/empty.ts'), '');
    writeFileSync(path.join(d, 'src/util/empty.ts'), '');

    const svc = await classifyFile(path.join(d, 'src/svc/empty.ts'), 'src/svc/empty.ts', graph, new FileContentCache(), classCache);
    const util = await classifyFile(path.join(d, 'src/util/empty.ts'), 'src/util/empty.ts', graph, new FileContentCache(), classCache);

    expect(svc.matches.map((m) => m.typeId)).toEqual(['svc']);
    expect(util.matches.map((m) => m.typeId)).toEqual(['util']);
  });

  it('a file MOVED to a new path (content unchanged) is reclassified against the NEW path — it never inherits the old path\'s cached verdict', async () => {
    const d = copyFixture();
    const graph = await loadGraph(d);
    const classCache = new TypeClassCache(d, graph.architecture);
    const body = 'export const moved = 1;\n';
    const oldPath = path.join(d, 'src/svc/orig.ts');
    writeFileSync(oldPath, body);
    const before = await classifyFile(oldPath, 'src/svc/orig.ts', graph, new FileContentCache(), classCache);
    expect(before.matches.map((m) => m.typeId)).toEqual(['svc']);

    // Simulate a move: the old file is gone, the same bytes now live under util/.
    // Scoped rmSync of one file inside a fresh mktemp copy — never the shared fixture.
    rmSync(oldPath);
    const newPath = path.join(d, 'src/util/moved.ts');
    writeFileSync(newPath, body);
    const after = await classifyFile(newPath, 'src/util/moved.ts', graph, new FileContentCache(), classCache);

    expect(after.matches.map((m) => m.typeId)).toEqual(['util']); // NOT the stale 'svc' verdict
  });

  it('case-differing paths (this filesystem is case-sensitive) classify independently, including a genuinely different verdict', async () => {
    const d = copyFixture();
    const graph = await loadGraph(d);
    const classCache = new TypeClassCache(d, graph.architecture);
    const body = 'export const cased = 1;\n';
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(d, 'src/SVC'), { recursive: true }); // uppercase dir — matches no type's when
    writeFileSync(path.join(d, 'src/SVC/dup2.ts'), body);
    writeFileSync(path.join(d, 'src/svc/dup2.ts'), body);

    const upper = await classifyFile(path.join(d, 'src/SVC/dup2.ts'), 'src/SVC/dup2.ts', graph, new FileContentCache(), classCache);
    const lower = await classifyFile(path.join(d, 'src/svc/dup2.ts'), 'src/svc/dup2.ts', graph, new FileContentCache(), classCache);

    expect(upper.matches).toEqual([]); // src/SVC/** matches no type's `path: src/svc/**`
    expect(lower.matches.map((m) => m.typeId)).toEqual(['svc']);
  });

  it('Unicode-normalization-differing paths (NFC vs NFD, visually identical filenames) get separate shards', async () => {
    const d = copyFixture();
    const graph = await loadGraph(d);
    const classCache = new TypeClassCache(d, graph.architecture);
    const body = 'export const accented = 1;\n';
    // Precomposed U+00E9 vs decomposed U+0065 + combining-acute U+0301 — built via
    // explicit escapes and .normalize() (never by typing an accented letter twice in
    // source, which risks the editor silently making both literals byte-identical) so
    // the two paths are provably different JS strings, visually identical, both legal
    // on this (ext4) filesystem.
    const accentedNfc = '\u00e9'.normalize('NFC');
    const accentedNfd = '\u00e9'.normalize('NFD');
    expect(accentedNfc).not.toBe(accentedNfd); // sanity: genuinely different JS strings
    const nfc = `src/svc/cafe${accentedNfc}.ts`;
    const nfd = `src/svc/cafe${accentedNfd}.ts`;
    writeFileSync(path.join(d, nfc), body);
    writeFileSync(path.join(d, nfd), body);

    await classifyFile(path.join(d, nfc), nfc, graph, new FileContentCache(), classCache);
    await classifyFile(path.join(d, nfd), nfd, graph, new FileContentCache(), classCache);

    expect(findShardFiles(typeClassCacheDir(d)).length).toBe(2); // not collapsed into one shard
  });

  it('a symlink and its target — same bytes, different repo-relative identities — classify independently by their OWN path', async () => {
    const d = copyFixture();
    const graph = await loadGraph(d);
    const classCache = new TypeClassCache(d, graph.architecture);
    const targetPath = path.join(d, 'src/svc/target.ts');
    writeFileSync(targetPath, 'export const linked = 1;\n');
    const linkPath = path.join(d, 'src/util/link.ts');
    symlinkSync(targetPath, linkPath);

    // The symlink is read through (its BYTES equal the target's), but its own
    // repo-relative path sits under util/ — path predicates key off that path,
    // not off wherever the bytes physically live.
    const target = await classifyFile(targetPath, 'src/svc/target.ts', graph, new FileContentCache(), classCache);
    const link = await classifyFile(linkPath, 'src/util/link.ts', graph, new FileContentCache(), classCache);

    expect(target.matches.map((m) => m.typeId)).toEqual(['svc']);
    expect(link.matches.map((m) => m.typeId)).toEqual(['util']); // not target's 'svc' verdict
  });

  it('re-saving a file with a DIFFERENT LINE-ENDING style at the SAME path is treated as a content edit, never served the pre-edit cached verdict', async () => {
    const d = copyFixture();
    const graph = await loadGraph(d);
    // A synthetic type whose `when` can only match CRLF-carrying content — the
    // predicate evaluator (io/file-content-cache.ts) reads raw, un-normalized
    // bytes, so this is only satisfiable while the literal `\r` survives.
    const editedArch = {
      ...graph.architecture,
      node_types: {
        ...graph.architecture.node_types,
        dosScript: { description: 'CRLF-only marker type', when: { content: 'echo hi\\r' } },
      },
    };
    const graphV = { ...graph, architecture: editedArch };
    const classCache = new TypeClassCache(d, editedArch);
    const scriptPath = path.join(d, 'src/svc/script.ts');

    writeFileSync(scriptPath, '#!/bin/sh\r\necho hi\r\n');
    const cold = await classifyFile(scriptPath, 'src/svc/script.ts', graphV, new FileContentCache(), classCache);
    expect(cold.matches.map((m) => m.typeId)).toContain('dosScript');

    // Same path, re-saved LF-only: the literal \r is gone, so the SAME
    // predicate must now report NO match. A key built from line-ending-
    // normalized bytes (mirroring io/hash.ts's hashFile, which collapses
    // CRLF -> LF) would see an UNCHANGED content hash here and wrongly keep
    // serving the CRLF-era cached verdict — exactly the bug this pins.
    writeFileSync(scriptPath, '#!/bin/sh\necho hi\n');
    let warm: Awaited<ReturnType<typeof classifyFile>> | undefined;
    const calls = await countEvalCalls(async () => {
      warm = await classifyFile(scriptPath, 'src/svc/script.ts', graphV, new FileContentCache(), classCache);
    });
    expect(calls).toBeGreaterThan(0); // cache MISS — raw bytes changed even though the normalized hash would not have
    expect(warm!.matches.map((m) => m.typeId)).not.toContain('dosScript');
  });
});
