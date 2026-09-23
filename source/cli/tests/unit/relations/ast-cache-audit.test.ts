/**
 * Cache-audit test for the relation pass.
 *
 * Verifies that the content-addressed AST fact cache produces BYTE-FOR-BYTE identical
 * output to never caching, for a corpus that includes C# cross-file `global using`
 * directives and cross-file `global using` aliases — the cases where the file-pure
 * extraction assumption is weakest.
 *
 * ## Why this test exists
 *
 * A forgotten cache-key ingredient or a broken (de)serialization fails SILENTLY as a
 * false green: the gate stays green even though the cache is returning stale data. The
 * audit harness runs the pass three times (warm → A-cache-HIT → B-cache-DISABLED) and
 * asserts deep equality of (i) per-file `FileFacts` and (ii) `violationsByNode`. Any
 * mismatch is an incomplete key or a broken round-trip.
 *
 * ## C# corpus
 *
 * Two sub-projects exercise the cross-file seams:
 *
 * 1. **global-using-sibling**: a `global using N;` in one file makes namespace `N`
 *    available project-wide. The cached C# extract carries `scope.globalPrefixes` so
 *    the pre-pass can read them from cache; the assembly is live every run.
 *
 * 2. **global-using-alias**: a `global using Alias = FQN;` in one file is usable in
 *    every file. The cached extract carries `scope.globalAliases` as entry arrays
 *    (not bare `Map`s — the Map-as-`{}` trap). A broken round-trip that empties the
 *    alias map would silently drop the cross-node edge; the audit catches it.
 *
 * The reference snippets are taken READ-ONLY from the existing catalogue:
 *   reference/relations/csharp/csharp-global-using-sibling-file.md
 *   reference/relations/csharp/csharp-global-using-alias.md
 *
 * ## Gate wiring
 *
 * This test runs as part of `npm run test:coverage` (the full vitest suite invoked by
 * `scripts/repo-check.sh`). Because `repo-check.sh` runs the full vitest suite, this
 * test is already a standing gate — every commit on the dogfooded repo exercises the
 * audit without any extra invocation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { extractorForLanguage } from '../../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../../src/relations/resolve-path.js';
import { astCacheDir } from '../../../src/relations/facts-cache.js';
import type { Graph } from '../../../src/model/graph.js';
import { runRelationPass, type RelationPassDeps, type FileFacts, type NodeViolations } from '../../../src/relations/pass.js';

// ── The warm-then-A/B audit harness ───────────────────────────────────────
// Warm the cache, run a cache-HIT pass (A) and a cache-DISABLED pass (B), and
// deep-compare their per-file facts and per-node violations. This test is its
// only caller, so the harness lives here rather than in the shipped source.

interface AuditResult {
  /** Whether the audit passed (A facts == B facts AND A violations == B violations). */
  pass: boolean;
  /** Per-file diffs between the cache-HIT run (A) and the cache-DISABLED run (B). */
  factsDiffs: Array<{ path: string; a: FileFacts | null; b: FileFacts | null; reason: string }>;
  /** Per-node violation diffs between runs A and B. */
  violationDiffs: Array<{
    nodeId: string;
    a: NodeViolations | undefined;
    b: NodeViolations | undefined;
    reason: string;
  }>;
}

/**
 * Run the relation-pass cache audit over the given graph/project.
 *
 * Performs three passes (warm → A → B) and returns a structured diff. The caller
 * asserts `result.pass === true`; the `factsDiffs` / `violationDiffs` arrays carry
 * the specific mismatches on failure so the assertion message is actionable.
 *
 * @param graph       The in-memory graph describing nodes and their file mappings.
 * @param projectRoot Absolute path to the project root (files are read from here).
 * @param deps        Relay deps (extractorFor, resolvePathToFile). `symbolIndexDir`
 *                    MUST point to a fresh/empty directory so the warm pass writes
 *                    from scratch and the A pass exercises real cache hits.
 *                    `disableCache` from deps is IGNORED — the audit controls it.
 */
async function runCacheAudit(
  graph: Graph,
  projectRoot: string,
  deps: Omit<RelationPassDeps, 'disableCache'>,
): Promise<AuditResult> {
  const baseDeps: RelationPassDeps = { ...deps };

  // Phase 1: Warm — first pass over a fresh cache dir. Every file misses → shards written.
  await runRelationPass(graph, projectRoot, { ...baseDeps, disableCache: false });

  // Phase 2: A — cache-HIT run. Every file hits its shard; facts come through
  // loadFacts + deserialize. This is the run that exercises the round-trip.
  const runA = await runRelationPass(graph, projectRoot, { ...baseDeps, disableCache: false });

  // Phase 3: B — cache-DISABLED run. Every file is parsed fresh; no shard I/O.
  const runB = await runRelationPass(graph, projectRoot, { ...baseDeps, disableCache: true });

  // Compare per-file facts (A vs B).
  const factsDiffs: AuditResult['factsDiffs'] = [];
  const allPaths = new Set([...runA.factsByPath.keys(), ...runB.factsByPath.keys()]);
  for (const p of allPaths) {
    const a = runA.factsByPath.get(p) ?? null;
    const b = runB.factsByPath.get(p) ?? null;
    if (!deepEqual(a, b)) factsDiffs.push({ path: p, a, b, reason: diffReason(a, b) });
  }

  // Compare per-node violations (A vs B).
  const violationDiffs: AuditResult['violationDiffs'] = [];
  const allNodes = new Set([...runA.violationsByNode.keys(), ...runB.violationsByNode.keys()]);
  for (const nodeId of allNodes) {
    const a = runA.violationsByNode.get(nodeId);
    const b = runB.violationsByNode.get(nodeId);
    if (!deepEqual(a, b)) violationDiffs.push({ nodeId, a, b, reason: diffReason(a, b) });
  }

  return {
    pass: factsDiffs.length === 0 && violationDiffs.length === 0,
    factsDiffs,
    violationDiffs,
  };
}

/**
 * Structural deep equality via JSON round-trip.
 *
 * This deliberately uses `JSON.stringify` for comparison — the SAME serialization
 * path that the on-disk shard uses. A `Map` that survives JSON as `{}` (the C# alias
 * trap) would produce an empty serialization in BOTH runs, hiding the mismatch. But
 * after `loadFacts` rebuilds the `Map`s from entry arrays, the in-memory `FileFacts`
 * in run A carries the LIVE reconstructed `Map`s — so `JSON.stringify` on the A-side
 * fact would also serialize them as `{}` if we didn't use `replacer`.
 *
 * We therefore normalize `Map`s → `[...m]` (entry arrays) via the replacer before
 * comparing — the same transformation `serializeCsharp` applies. This catches the
 * Map-as-object trap: if the B-side (fresh parse) returns a populated Map and the
 * A-side (cache reload) returns a correctly-rebuilt Map, they must be equal after
 * normalization; if the A-side silently returned an empty Map (broken deserialize),
 * normalization surfaces the empty vs populated diff.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a, mapReplacer) === JSON.stringify(b, mapReplacer);
}

function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return [...value];
  return value;
}
function diffReason(a: unknown, b: unknown): string {
  const aStr = JSON.stringify(a, mapReplacer);
  const bStr = JSON.stringify(b, mapReplacer);
  if (aStr === bStr) return '(identical after normalization — Map comparison issue)';
  // Truncate to keep assertion messages readable.
  const maxLen = 300;
  const aSnip = aStr.length > maxLen ? aStr.slice(0, maxLen) + '…' : aStr;
  const bSnip = bStr.length > maxLen ? bStr.slice(0, maxLen) + '…' : bStr;
  return `A: ${aSnip}\nB: ${bSnip}`;
}

// ---------------------------------------------------------------------------
// Helpers — build a minimal yg project from a set of (path, content) pairs
// ---------------------------------------------------------------------------

interface ProjectFile {
  /** Repo-relative POSIX path, e.g. "src/g/Globals.cs" */
  path: string;
  content: string;
}

/**
 * Write a minimal Yggdrasil project to `root`.
 *
 * A single node type `service` maps every file under `**`. Each first-level
 * directory under `src/` becomes its own node (e.g. `src/g/…` → node `g`).
 * No inter-node relations are declared — violations are the audit's output, not
 * its input.
 */
function buildProject(root: string, files: ProjectFile[]): void {
  // .yggdrasil scaffolding
  mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
  writeFileSync(
    path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
    `node_types:\n  service:\n    description: unit\n    log_required: false\n    when:\n      path: "**"\n`,
    'utf-8',
  );
  writeFileSync(
    path.join(root, '.yggdrasil', 'yg-config.yaml'),
    `version: "6.0.0"\nquality:\n  max_direct_relations: 50\n`,
    'utf-8',
  );

  // Derive one node per first-level src/ directory.
  const nodeIds = new Set<string>();
  for (const f of files) {
    const segs = f.path.split('/');
    // e.g. "src/g/Globals.cs" → nodeId "g"
    if (segs.length >= 2 && segs[0] === 'src') nodeIds.add(segs[1]);
  }
  for (const nodeId of nodeIds) {
    const nodeDir = path.join(root, '.yggdrasil', 'model', nodeId);
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(
      path.join(nodeDir, 'yg-node.yaml'),
      `name: ${nodeId}\ntype: service\nmapping:\n  - "src/${nodeId}/**"\n`,
      'utf-8',
    );
  }

  // Write source files.
  for (const f of files) {
    const abs = path.join(root, f.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// Corpus — C# files covering the two cross-file global-using seams
// Taken READ-ONLY from:
//   reference/relations/csharp/csharp-global-using-sibling-file.md
//   reference/relations/csharp/csharp-global-using-alias.md
// ---------------------------------------------------------------------------

/**
 * Sub-project 1: cross-file `global using N;`
 *
 * A bare `global using N;` in one C# file makes namespace N available project-wide.
 * The audit proves that the cached C# extract correctly carries `scope.globalPrefixes`
 * so the pre-pass rebuilds the same aggregate from cache as from a fresh parse.
 */
const SIBLING_FILES: ProjectFile[] = [
  // Declares global using N; (goes into node g)
  { path: 'src/g/Globals.cs', content: 'global using N;\n' },
  // Uses bare `Type` — only resolves because of the sibling global using (node c)
  { path: 'src/c/Use.cs', content: 'class C : Type { }\n' },
  // Declares namespace N { class Type } (node n)
  { path: 'src/n/Type.cs', content: 'namespace N;\npublic class Type {}\n' },
];

/**
 * Sub-project 2: cross-file `global using Alias = FQN;`
 *
 * A global using alias declared in one file is usable in every file. The cached
 * C# extract carries `scope.globalAliases` as entry arrays (not bare Maps). A
 * broken round-trip that empties the alias map would silently drop the cross-node
 * edge; the audit catches it because the disabled-cache run (fresh parse) still
 * finds the edge while the cache-hit run would not.
 */
const ALIAS_FILES: ProjectFile[] = [
  // Declares global using alias (goes into node g)
  { path: 'src/g/Globals.cs', content: 'global using Cust = MyApp.Models.Customer;\n' },
  // Uses bare `Cust` — only resolves via the project-wide alias (node c)
  { path: 'src/c/Use.cs', content: 'class C { Cust c; }\n' },
  // Declares namespace MyApp.Models { class Customer } (node m)
  { path: 'src/m/Customer.cs', content: 'namespace MyApp.Models;\npublic class Customer { }\n' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AST cache audit — cache-HIT run deep-equals cache-DISABLED run', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'yg-cache-audit-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Runs the full warm → A (cache-HIT) → B (cache-DISABLED) audit on a project
   * built from `files`, asserting that `factsByPath` and `violationsByNode` are
   * identical between runs A and B.
   */
  async function auditProject(files: ProjectFile[], label: string): Promise<void> {
    buildProject(root, files);
    const graph = await loadGraph(root);
    const cacheDir = astCacheDir(path.join(root, '.yggdrasil'));

    const result = await runCacheAudit(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: cacheDir,
    });

    // Surface actionable diffs on failure.
    if (!result.pass) {
      const factLines = result.factsDiffs
        .map((d) => `  [${d.path}]\n    ${d.reason.replace(/\n/g, '\n    ')}`)
        .join('\n');
      const violLines = result.violationDiffs
        .map((d) => `  [${d.nodeId}]\n    ${d.reason.replace(/\n/g, '\n    ')}`)
        .join('\n');
      const msg =
        `${label}: cache-HIT run ≠ cache-DISABLED run\n` +
        (factLines ? `Facts diffs:\n${factLines}\n` : '') +
        (violLines ? `Violation diffs:\n${violLines}\n` : '');
      expect(result.pass, msg).toBe(true);
    } else {
      expect(result.pass).toBe(true);
    }
  }

  it('global-using-sibling: cached globalPrefixes round-trip equals fresh parse', async () => {
    // This case exercises scope.globalPrefixes serialization.
    // A broken round-trip would empty globalPrefixes, making the pre-pass miss the
    // project-wide namespace — the cache-HIT run would then fail to find the c→n edge
    // while the cache-DISABLED run would still find it (from a fresh parse), causing a
    // violationsByNode diff and failing the audit.
    await auditProject(SIBLING_FILES, 'global-using-sibling');
  });

  it('global-using-alias: cached globalAliases Map round-trip equals fresh parse', async () => {
    // This case exercises scope.globalAliases Map serialization (the Map-as-{} trap).
    // A broken round-trip (naive JSON.stringify of a Map → "{}") would empty
    // globalAliases, making the alias resolution in assembleCsharpCandidates miss the
    // Cust → MyApp.Models.Customer mapping — the cache-HIT run would then fail to find
    // the c→m edge while the cache-DISABLED run would still find it, causing a
    // violationsByNode diff and failing the audit.
    await auditProject(ALIAS_FILES, 'global-using-alias');
  });

  it('a stale/corrupt features write is CAUGHT: the audit reports it as a factsDiffs entry', async () => {
    // The audit deep-equals the WHOLE FileFacts (JSON.stringify with a Map replacer), and
    // `features` now rides inside FileFacts — so a features round-trip bug is caught for free.
    // We prove the guard bites: warm a shard, then corrupt ONLY its `features` on disk (leaving
    // declarations/uses correct), so the cache-HIT run (A, reads the corrupt features) and the
    // cache-DISABLED run (B, fresh-parses the correct features) differ solely in `features`.
    const files: ProjectFile[] = [{ path: 'src/a/foo.ts', content: 'export const x = 1;\n' }];
    buildProject(root, files);
    const cacheDir = astCacheDir(path.join(root, '.yggdrasil'));
    const deps = {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: cacheDir,
    };

    // Cold pass writes the correct shard (correct declarations/uses/features).
    await runRelationPass(await loadGraph(root), root, deps);
    const shard = findFirstShard(path.join(cacheDir, 'v2'));
    expect(shard).not.toBe('');
    const body = JSON.parse(readFileSync(shard, 'utf-8')) as {
      features: { nodeCount: number };
    };
    // Corrupt ONLY features (bump nodeCount) — declarations/uses stay exactly correct, so the
    // A/B diff is attributable purely to features.
    body.features.nodeCount += 1000;
    writeFileSync(shard, JSON.stringify(body), 'utf-8');

    // runCacheAudit's warm pass is create-only → it will NOT overwrite the corrupted shard.
    // A (cache-HIT) reads corrupt features; B (cache-DISABLED) parses correct features.
    const result = await runCacheAudit(await loadGraph(root), root, deps);
    expect(result.pass).toBe(false);
    const diff = result.factsDiffs.find((d) => d.path === 'src/a/foo.ts');
    expect(diff, 'expected a factsDiffs entry for the corrupt-features file').toBeDefined();
    // The reported diff carries the mutated nodeCount → the round-trip guard covers features.
    expect(diff!.reason).toContain(String(body.features.nodeCount));
  });
});

/** Return the first `.json` shard path under `base` (recursive), or '' if none. */
function findFirstShard(base: string): string {
  let out = '';
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (out) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) out = p;
    }
  };
  try {
    walk(base);
  } catch {
    /* no cache dir → '' */
  }
  return out;
}
