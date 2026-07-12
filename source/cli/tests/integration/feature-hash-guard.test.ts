/**
 * G3-class hash guard: the per-file feature vector must NEVER touch a verdict hash.
 *
 * The feature vector lives in the content-addressed AST fact cache (`.ast-cache`), a
 * gitignored speed cache. Verdict inputHashes are computed by `computeLlmInputHash` /
 * `computeDetInputHash`, which fold subject-file CONTENT, the aspect, its references, the
 * tier name, and (deterministic-only) the ctx read observations — and take NO feature vector.
 *
 * This test pins that through the REAL pipeline (not a hand-built hash input, which could
 * only re-prove `hashString` is deterministic): a deterministic aspect is filled by the
 * production fill stage — `computeDetInputHash` over the subject's actual bytes — and its
 * inputHash is persisted. We then force a feature change (mutate a warmed shard's `features`
 * on disk) and re-run the production RE-HASH path (`yg check` → verify-lock → the same
 * `computeDetInputHash`). If any feature ever leaked into a hash ingredient, the recomputed
 * hash would differ from the stored one and the pair would read `unverified`; it must stay
 * verified with a byte-identical inputHash. In the same run we prove (a) the mutated features
 * are actually READ by the pass (non-vacuity) and (b) the relation-conformance verdicts are
 * byte-identical — features never change what the gate decides.
 *
 * Because the recorded hash is produced BY the real fill pipeline and re-checked BY the real
 * verify pipeline, a future code path that ever fed `features` into either would trip this.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runFill } from '../../src/core/fill.js';
import { runCheck } from '../../src/core/check.js';
import { readLock } from '../../src/io/lock-store.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';
import { astCacheDir } from '../../src/relations/facts-cache.js';

// A deterministic aspect that reads its subject's AST and reports nothing. Its verdict
// inputHash therefore folds the subject file's content through the real fill pipeline.
const PROBE_CHECK = `export function check(ctx) {
  for (const f of ctx.files) { if (f.ast) void f.ast.rootNode.type; }
  return [];
}
`;

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function firstShard(base: string): string {
  let out = '';
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (out) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) out = p;
    }
  };
  walk(base);
  return out;
}

describe('feature vectors never enter a verdict inputHash (G3, via the real fill→check pipeline)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'feat-hashguard-'));
    // Architecture: a single mapping-capable `service` type; service→service `uses` allowed so
    // the declared a→b edge sanctions the live TS import.
    w(
      root,
      '.yggdrasil/yg-architecture.yaml',
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n    relations:\n      uses: [service]\n`,
    );
    // A reviewer section is mandatory (it gates --approve) even though the only aspect here is
    // deterministic, so it is never invoked — no key, no cost.
    w(
      root,
      '.yggdrasil/yg-config.yaml',
      `reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n`,
    );
    // Deterministic probe aspect (folds subject content into its verdict hash).
    w(
      root,
      '.yggdrasil/aspects/probe/yg-aspect.yaml',
      `name: probe\ndescription: deterministic subject-reading probe\nreviewer:\n  type: deterministic\nstatus: enforced\n`,
    );
    w(root, '.yggdrasil/aspects/probe/check.mjs', PROBE_CHECK);
    // Node a carries the probe aspect and declares a→b; node b is the import target.
    w(
      root,
      '.yggdrasil/model/a/yg-node.yaml',
      `name: A\ntype: service\naspects:\n  - probe\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/a\n`,
    );
    w(root, '.yggdrasil/model/b/yg-node.yaml', `name: B\ntype: service\nmapping:\n  - src/b\n`);
    w(root, 'src/a/foo.ts', `import { bar } from '../b/bar';\nexport const foo = bar;\n`);
    w(root, 'src/b/bar.ts', `export const bar = 2;\n`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a shard feature mutation changes NO deterministic verdict inputHash and NO relation verdict', async () => {
    const graph = await loadGraph(root);
    const cacheDir = astCacheDir(graph.rootPath);
    const passDeps = {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: cacheDir,
    };

    // 1. Real fill — warms the AST cache (features written) and persists the deterministic
    //    `probe` verdict, whose inputHash the production pipeline computed over the subject bytes.
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const probeBefore = Object.values(readLock(graph.rootPath).verdicts['probe'] ?? {})
      .map((e) => e.hash)
      .sort();
    expect(probeBefore.length).toBeGreaterThan(0);

    // Sanity: a plain check before any mutation re-hashes clean (pair verified).
    const sanity = await runCheck(await loadGraph(root), null);
    expect(sanity.issues.filter((i) => i.code === 'unverified')).toHaveLength(0);

    // Baseline relation verdicts + baseline feature totals (read from the warm cache).
    const cold = await runRelationPass(await loadGraph(root), root, passDeps);
    const coldNodes = [...cold.factsByPath.values()].reduce((s, f) => s + f.features.nodeCount, 0);

    // 2. Force a feature change on disk (a warmed shard's vector).
    const shard = firstShard(path.join(cacheDir, 'v2'));
    expect(shard).not.toBe('');
    const body = JSON.parse(readFileSync(shard, 'utf-8')) as {
      features: { nodeCount: number; categories: Record<string, number> };
    };
    body.features.nodeCount += 999;
    body.features.categories['call-like'] += 7;
    writeFileSync(shard, JSON.stringify(body), 'utf-8');

    // 3. Non-vacuity + relation invariance: the warm pass READS the mutated features (its
    //    nodeCount total moved by exactly +999), yet the relation-conformance verdicts are
    //    byte-identical — features never change what the gate decides.
    const warm = await runRelationPass(await loadGraph(root), root, passDeps);
    const warmNodes = [...warm.factsByPath.values()].reduce((s, f) => s + f.features.nodeCount, 0);
    expect(warmNodes).toBe(coldNodes + 999);
    expect([...warm.violationsByNode.entries()].map(([k, v]) => [k, v.verdict, v.reason])).toEqual(
      [...cold.violationsByNode.entries()].map(([k, v]) => [k, v.verdict, v.reason]),
    );

    // 4. THE GUARD — the real re-hash path (verify-lock → computeDetInputHash over the subject
    //    bytes) still matches every stored inputHash. A feature leak into ANY hash ingredient
    //    would surface the probe pair as `unverified`; it must stay verified, byte-identical.
    const check = await runCheck(await loadGraph(root), null);
    expect(check.issues.filter((i) => i.code === 'unverified')).toHaveLength(0);
    const probeAfter = Object.values(readLock(graph.rootPath).verdicts['probe'] ?? {})
      .map((e) => e.hash)
      .sort();
    expect(probeAfter).toEqual(probeBefore);
  });
});
