import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';
import type {
  DependencyExtractor,
  DetectedDep,
  ParsedFile,
} from '../../src/relations/extractors/types.js';

import { CACHE_SCHEMA_VERSION, factsKey, writeFacts } from '../../src/relations/facts-cache.js';
import { hashString } from '../../src/io/hash.js';
import { grammarWasmHash } from '../../src/ast/parser.js';
import { csharpExtractor } from '../../src/relations/extractors/csharp.js';
import { ensureLoaderRegistered } from '../../src/ast/loader-hook.js';
import { isValidFeatureVector, type FeatureVector } from '../../src/relations/feature-vector.js';

/** A structurally-valid feature vector for pre-seeding a shard (its value is irrelevant to
 *  the relation verdict — features are speed-only and outside every hash). */
const FV: FeatureVector = {
  nodeCount: 1,
  depthQuartiles: [0, 0, 0],
  categories: {
    'function-like': 0,
    'class-like': 0,
    'import-like': 0,
    'branch-like': 0,
    'call-like': 0,
    'literal-like': 0,
  },
};

/** List every content-addressed AST shard under `<astCacheDir>/v<N>/` (empty if absent). The
 *  versioned subdir scopes the count to the NEW fact cache only — never the old symbol-index
 *  `symbols-<lang>.json` files that may share the same root dir. */
function listShards(astCacheDir: string): string[] {
  const versioned = path.join(astCacheDir, `v${CACHE_SCHEMA_VERSION}`);
  if (!existsSync(versioned)) return [];
  const out: string[] = [];
  const walkDir = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walkDir(p);
      else if (e.name.endsWith('.json')) out.push(p);
    }
  };
  walkDir(versioned);
  return out.sort();
}

// Extension that getLanguageForExtension maps to a real language so language
// detection is non-null and an extractor key ('typescript') exists.
const EXT = '.ts';

// Stub extractor: emits exactly one cross-node import use from a/foo.ts → ../b/bar,
// nothing for any other file, and no declarations anywhere.
const stubExtractor: DependencyExtractor = {
  languages: new Set(['typescript']),
  rev: 1,
  declarations() {
    return [];
  },
  uses(file: ParsedFile): DetectedDep[] {
    if (file.path.endsWith('src/a/foo.ts')) {
      return [{ candidates: [{ kind: 'path', specifier: '../b/bar' }], kind: 'import', line: 1 }];
    }
    return [];
  },
};

function writeNode(root: string, nodeRel: string, name: string, mapping: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'yg-node.yaml'),
    `name: ${name}\ntype: service\nmapping:\n  - ${mapping}\n`,
    'utf-8',
  );
}

describe('runRelationPass (integration)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-pass-'));

    // Architecture: a single mapping-capable type 'service'.
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\n`,
      'utf-8',
    );

    // Two nodes, NO relation a → b.
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');

    // Real source files.
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a', 'foo' + EXT), 'export const foo = 1;\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'b', 'bar' + EXT), 'export const bar = 2;\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses node a for an undeclared dependency on b; approves b', async () => {
    const graph = await loadGraph(root);

    const result = await runRelationPass(graph, root, {
      extractorFor: (language) => (language === 'typescript' ? stubExtractor : undefined),
      resolvePathToFile: (specifier) =>
        specifier === '../b/bar' ? 'src/b/bar' + EXT : undefined,
      symbolIndexDir: path.join(root, '.yg-cache'),
    });

    const a = result.violationsByNode.get('a');
    const b = result.violationsByNode.get('b');

    expect(a).toBeDefined();
    expect(a!.verdict).toBe('refused');
    expect(a!.violations).toHaveLength(1);
    expect(a!.violations[0].ownerNode).toBe('b');
    expect(a!.violations[0].fromFile).toBe('src/a/foo' + EXT);
    expect(a!.reason).toContain('undeclared dependency on b');

    expect(b).toBeDefined();
    expect(b!.verdict).toBe('approved');
    expect(b!.violations).toHaveLength(0);
  });

  it('sanctions a dependency on a NESTED node when a relation to its ancestor is declared', async () => {
    // Add a nested child node b/sub mapping src/b/sub, and point a's import at a
    // file owned by b/sub. Declaring a --uses--> b (the ANCESTOR of b/sub) must
    // sanction the edge: the verifier walks parentChain(b/sub) = [b] and finds b
    // among a's declared targets → no violation. This exercises the parentChain
    // ancestor-sanction branch.
    mkdirSync(path.join(root, '.yggdrasil', 'model', 'b', 'sub'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'model', 'b', 'sub', 'yg-node.yaml'),
      `name: BSub\ntype: service\nmapping:\n  - src/b/sub\n`,
      'utf-8',
    );
    // a declares a relation to the ancestor b.
    writeFileSync(
      path.join(root, '.yggdrasil', 'model', 'a', 'yg-node.yaml'),
      `name: A\ntype: service\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/a\n`,
      'utf-8',
    );
    mkdirSync(path.join(root, 'src', 'b', 'sub'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'b', 'sub', 'deep' + EXT), 'export const deep = 3;\n', 'utf-8');

    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: (language) => (language === 'typescript' ? nestedStub : undefined),
      resolvePathToFile: (specifier) =>
        specifier === '../b/sub/deep' ? 'src/b/sub/deep' + EXT : undefined,
      symbolIndexDir: path.join(root, '.yg-cache-nested'),
    });

    // a depends on b/sub but declares a relation to the ancestor b → sanctioned.
    expect(result.violationsByNode.get('a')!.verdict).toBe('approved');
    expect(result.violationsByNode.get('a')!.violations).toHaveLength(0);
  });
});

// Stub emitting one import from a/foo.ts → ../b/sub/deep (a nested node's file).
const nestedStub: DependencyExtractor = {
  languages: new Set(['typescript']),
  rev: 1,
  declarations() {
    return [];
  },
  uses(file: ParsedFile): DetectedDep[] {
    if (file.path.endsWith('src/a/foo.ts')) {
      return [{ candidates: [{ kind: 'path', specifier: '../b/sub/deep' }], kind: 'import', line: 1 }];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------
// AST fact-cache wiring (Task 6): the second run over an UNCHANGED project must
// (1) produce byte-identical verdicts and (2) write NO new shard (every file is
// a cache hit, so the tree-sitter parse is skipped). The C# case additionally
// proves the alias `Map` survives the JSON cache round-trip — a cross-file
// `global using` alias must still resolve on a cached run.
// ---------------------------------------------------------------------------
describe('runRelationPass — AST fact cache', () => {
  let root: string;

  function arch(root: string): void {
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\n`,
      'utf-8',
    );
  }

  function w(root: string, rel: string, content: string): void {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-astcache-'));
    arch(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a second run over an unchanged project writes NO new shard and yields identical verdicts (real TS extractor)', async () => {
    // Two nodes, a real cross-node TS import a → b, NO relation declared → a is refused.
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');
    w(root, 'src/a/foo.ts', `import { bar } from '../b/bar.js';\nexport const foo = bar;\n`);
    w(root, 'src/b/bar.ts', `export const bar = 2;\n`);

    const astCacheDir = path.join(root, '.yggdrasil', '.ast-cache');
    const deps = {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: astCacheDir,
    };

    const graph1 = await loadGraph(root);
    const first = await runRelationPass(graph1, root, deps);
    const shardsAfterFirst = listShards(astCacheDir);
    // A cold run parsed both files and wrote a shard per (TS) file.
    expect(shardsAfterFirst.length).toBeGreaterThan(0);

    const graph2 = await loadGraph(root);
    const second = await runRelationPass(graph2, root, deps);
    const shardsAfterSecond = listShards(astCacheDir);

    // (1) Identical verdicts both runs.
    expect([...second.violationsByNode.entries()].map(([k, v]) => [k, v.verdict, v.reason])).toEqual(
      [...first.violationsByNode.entries()].map(([k, v]) => [k, v.verdict, v.reason]),
    );
    // (2) The second run wrote NO new shard — every parse was a cache hit.
    expect(shardsAfterSecond).toEqual(shardsAfterFirst);
  });

  it('WARM-CACHE REGRESSION (v2 + features): a second plain pass parses NOTHING new — every shard byte- and mtime-identical, and features ride through the HIT', async () => {
    // The feature vector rides in the v2 shard. This is the "free CI gate must not slow down"
    // guarantee: writing features on the cold pass must not cause any re-parse or re-write on a
    // warm pass. We assert the STRONGEST form — after one warming pass, a second pass leaves
    // every shard's mtime AND bytes untouched (zero re-parse, zero re-write), and the facts the
    // warm run serves carry a valid features vector recovered from the shard (not recomputed).
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');
    w(root, 'src/a/foo.ts', `import { bar } from '../b/bar.js';\nexport const foo = bar;\n`);
    w(root, 'src/b/bar.ts', `export const bar = 2;\n`);

    const astCacheDir = path.join(root, '.yggdrasil', '.ast-cache');
    const deps = {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: astCacheDir,
    };

    // Warm pass — cold cache → every TS file parsed and a v2 shard written per file.
    await runRelationPass(await loadGraph(root), root, deps);
    const shards = listShards(astCacheDir);
    expect(shards.length).toBeGreaterThan(0);
    const before = shards.map((p) => ({ p, mtime: statSync(p).mtimeMs, bytes: statSync(p).size }));

    // Second plain pass over the unchanged project — must parse NOTHING new.
    const warm = await runRelationPass(await loadGraph(root), root, deps);
    const after = listShards(astCacheDir).map((p) => ({ p, mtime: statSync(p).mtimeMs, bytes: statSync(p).size }));

    // No new/removed shards; every shard's mtime and byte-size are unchanged → zero re-write.
    expect(after).toEqual(before);

    // The warm run's served facts carry a well-formed features vector recovered from the shard
    // (the HIT copy-through), proving features survive the JSON round-trip and ride factsByPath.
    const foo = warm.factsByPath.get('src/a/foo.ts');
    expect(foo).toBeDefined();
    expect(isValidFeatureVector(foo!.features)).toBe(true);
    // foo.ts has one `import` statement (the `export const` is outbound linkage, not an
    // import, so import-like counts only the import) → import-like === 1 (structural,
    // recovered from cache, not recomputed).
    expect(foo!.features.categories['import-like']).toBe(1);
  });

  it('resolves a cross-file C# global-using ALIAS edge on a CACHED run (Map round-trip)', async () => {
    // Mirrors reference/relations/csharp/csharp-global-using-alias.md, READ-ONLY oracle:
    //   global using Cust = MyApp.Models.Customer;  (node g)
    //   class C { Cust c; }                          (node c → must resolve to node m)
    //   namespace MyApp.Models; class Customer { }   (node m)
    // c declares NO relation to m → c must be refused on BOTH runs. The alias map lives in
    // the cached C# extract's `scope.aliases`/`globalAliases` (JS Maps); if the cache round-trip
    // dropped them, the second (cached) run would silence the edge and approve c → false green.
    writeNode(root, 'g', 'G', 'src/g');
    writeNode(root, 'c', 'C', 'src/c');
    writeNode(root, 'm', 'M', 'src/m');
    w(root, 'src/g/Globals.cs', `global using Cust = MyApp.Models.Customer;\n`);
    w(root, 'src/c/Use.cs', `class C { Cust c; }\n`);
    w(root, 'src/m/Customer.cs', `namespace MyApp.Models;\npublic class Customer { }\n`);

    const astCacheDir = path.join(root, '.yggdrasil', '.ast-cache');
    const deps = {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: astCacheDir,
    };

    const graph1 = await loadGraph(root);
    const first = await runRelationPass(graph1, root, deps);
    expect(first.violationsByNode.get('c')!.verdict).toBe('refused');
    expect(first.violationsByNode.get('c')!.violations.some((v) => v.ownerNode === 'm')).toBe(true);
    const shardsAfterFirst = listShards(astCacheDir);

    // Second run sources the C# extract from the cache (no re-parse). The alias map must
    // survive the JSON round-trip → c still resolves to m → still refused.
    const graph2 = await loadGraph(root);
    const second = await runRelationPass(graph2, root, deps);
    const shardsAfterSecond = listShards(astCacheDir);

    expect(second.violationsByNode.get('c')!.verdict).toBe('refused');
    expect(second.violationsByNode.get('c')!.violations.some((v) => v.ownerNode === 'm')).toBe(true);
    // No new shard on the cached run.
    expect(shardsAfterSecond).toEqual(shardsAfterFirst);
  });

  it('re-parses a C# file whose on-disk shard matches the key but LACKS `csharp` (fail-closed-to-PARSE, not to empty)', async () => {
    // FALSE-GREEN GUARD. A C# shard that matches the content-key but is MISSING its `csharp`
    // field (e.g. a malformed/partially-written shard, or one written by an older code path)
    // must NOT be treated as a null-csharp HIT — that would silently SKIP the file downstream
    // (`facts.csharp === null` → continue) and erase a real cross-node C# dependency → the
    // relation gate goes falsely GREEN over an undeclared edge. The cache HIT for a C# file is
    // only valid when `csharp` is present; otherwise the file MUST fall through to a live parse.
    //
    // Setup mirrors the alias-edge oracle: `Cust c;` in node c must resolve to `Customer` in
    // node m; c declares NO relation to m, so c MUST be refused. We pre-write a csharp-LESS
    // shard for c's file at its exact content-key BEFORE the pass runs (writeFacts is
    // create-only, so this primes the shard the pass will read). With the bug the pass reads
    // this shard as a null-csharp hit and skips c's file → c is approved (false green). With
    // the fix the absent-`csharp` hit is a MISS → live re-parse → c is still refused.
    ensureLoaderRegistered();
    writeNode(root, 'g', 'G', 'src/g');
    writeNode(root, 'c', 'C', 'src/c');
    writeNode(root, 'm', 'M', 'src/m');
    const useSrc = `global using Cust = MyApp.Models.Customer;\nclass C { Cust c; }\n`;
    // Keep the alias + use in a single file owned by node c so resolution does not depend on a
    // second cached shard; node m supplies the target type.
    w(root, 'src/c/Use.cs', useSrc);
    w(root, 'src/m/Customer.cs', `namespace MyApp.Models;\npublic class Customer { }\n`);

    const astCacheDir = path.join(root, '.yggdrasil', '.ast-cache');

    // Pre-write a MALFORMED (csharp-less) shard for c's file at its exact content-key. A
    // FileFacts with `csharp` undefined makes writeFacts emit a shard with NO `csharp` field —
    // structurally valid (passes loadFacts) but missing the C# extract.
    const cKey = factsKey({
      contentHash: hashString(useSrc),
      language: 'csharp',
      grammarHash: grammarWasmHash('.cs'),
      rev: csharpExtractor.rev,
    });
    await writeFacts(astCacheDir, 'csharp', cKey, { declarations: [], uses: [], features: FV });

    const deps = {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: astCacheDir,
    };

    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, deps);

    // The csharp-less shard must NOT have silenced the edge: c re-parsed → still refused on m.
    expect(result.violationsByNode.get('c')!.verdict).toBe('refused');
    expect(result.violationsByNode.get('c')!.violations.some((v) => v.ownerNode === 'm')).toBe(true);
  });
});
