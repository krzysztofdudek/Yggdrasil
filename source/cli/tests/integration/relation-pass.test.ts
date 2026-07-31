import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile, guardedResolve } from '../../src/relations/resolve-path.js';
import type {
  DependencyExtractor,
  DetectedDep,
  ParsedFile,
} from '../../src/relations/extractors/types.js';

import { computeTypeGateFindings } from '../../src/relations/type-gate.js';
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

// ---------------------------------------------------------------------------
// A directory mapping's file enumeration must stop at a nested project's own
// boundary, exactly like every other caller that decides what belongs to this
// graph (io/hash.ts's expandMappingPathsWithinOwnGraph). A vendored dependency,
// submodule, or linked worktree checked out inside a mapped directory is not
// this graph's source: an import inside it must never become an undeclared-
// dependency refusal attributed to the FIRST-PARTY node whose directory
// happens to contain it.
// ---------------------------------------------------------------------------
describe('runRelationPass stops file enumeration at a nested project boundary', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-pass-nested-'));
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
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a', 'own' + EXT), 'export const own = 1;\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'b', 'bar' + EXT), 'export const bar = 2;\n', 'utf-8');
    // A separate project, checked out inside node a's mapped directory, whose
    // own file imports node b's file with no declared relation. Its own
    // `.yggdrasil/` graph makes it a nested project — governed by itself, not
    // by node a.
    mkdirSync(path.join(root, 'src', 'a', 'vendorlib', '.yggdrasil'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'a', 'vendorlib', '.yggdrasil', 'yg-config.yaml'),
      'version: "5.2.0"\n',
    );
    writeFileSync(
      path.join(root, 'src', 'a', 'vendorlib', 'bad' + EXT),
      'export const bad = 1;\n',
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('never enumerates the nested project\'s file, so its undeclared import never refuses the first-party node', async () => {
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: (language) => (language === 'typescript' ? vendoredStub : undefined),
      resolvePathToFile: (specifier) =>
        specifier === '../../b/bar' ? 'src/b/bar' + EXT : undefined,
      symbolIndexDir: path.join(root, '.yg-cache-vendored'),
    });

    // The vendored file must never even be READ/hashed by this pass — it is a
    // separate project's own source, not node a's.
    expect(result.hashByPath.has('src/a/vendorlib/bad' + EXT)).toBe(false);

    const a = result.violationsByNode.get('a');
    expect(a === undefined || a.verdict === 'approved').toBe(true);
    expect(a?.violations ?? []).toHaveLength(0);
  });
});

// Stub emitting one import from vendorlib/bad.ts → ../../b/bar (crosses into node b,
// with no declared relation) — used only by the nested-project-boundary test above.
const vendoredStub: DependencyExtractor = {
  languages: new Set(['typescript']),
  rev: 1,
  declarations() {
    return [];
  },
  uses(file: ParsedFile): DetectedDep[] {
    if (file.path.endsWith('src/a/vendorlib/bad' + EXT)) {
      return [{ candidates: [{ kind: 'path', specifier: '../../b/bar' }], kind: 'import', line: 1 }];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------
// A directory mapping's file enumeration must stop at a coverage.excluded
// root too, exactly like the nested-project boundary above — the two are the
// same one supreme exclusion filter, from its other source of membership (the
// adopter's own config rather than the filesystem). An import inside an
// excluded subdirectory must never become an undeclared-dependency refusal
// attributed to the first-party node whose directory happens to contain it.
// ---------------------------------------------------------------------------
describe('runRelationPass stops file enumeration at a coverage.excluded root', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-pass-excluded-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\ncoverage:\n  excluded:\n    - src/a/vendor/\n`,
      'utf-8',
    );
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a', 'own' + EXT), 'export const own = 1;\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'b', 'bar' + EXT), 'export const bar = 2;\n', 'utf-8');
    // A vendored file under an EXCLUDED (not nested-project) directory inside
    // node a's mapping, whose own file imports node b's file with no declared
    // relation.
    mkdirSync(path.join(root, 'src', 'a', 'vendor'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'a', 'vendor', 'bad' + EXT),
      'export const bad = 1;\n',
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('never enumerates the excluded file, so its undeclared import never refuses the first-party node', async () => {
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: (language) => (language === 'typescript' ? excludedStub : undefined),
      resolvePathToFile: (specifier) =>
        specifier === '../../b/bar' ? 'src/b/bar' + EXT : undefined,
      symbolIndexDir: path.join(root, '.yg-cache-excluded'),
    });

    // The excluded file must never even be READ/hashed by this pass.
    expect(result.hashByPath.has('src/a/vendor/bad' + EXT)).toBe(false);

    const a = result.violationsByNode.get('a');
    expect(a === undefined || a.verdict === 'approved').toBe(true);
    expect(a?.violations ?? []).toHaveLength(0);
  });

  it('the mirror case: node a\'s OWN (non-excluded) file with a real undeclared import is still refused', async () => {
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: (language) => (language === 'typescript' ? excludedMirrorStub : undefined),
      resolvePathToFile: (specifier) =>
        specifier === '../b/bar' ? 'src/b/bar' + EXT : undefined,
      symbolIndexDir: path.join(root, '.yg-cache-excluded-mirror'),
    });

    // src/a/foo.ts is not under the excluded root — a real undeclared import
    // from it must still be caught. Over-correction that silently drops a
    // real violation would be the mirror-image failure to the leak this
    // guard exists to close.
    expect(result.hashByPath.has('src/a/own' + EXT)).toBe(true);
    const a = result.violationsByNode.get('a');
    expect(a).toBeDefined();
    expect(a!.verdict).toBe('refused');
  });
});

// Stub emitting one import from vendor/bad.ts → ../../b/bar (crosses into node b,
// with no declared relation) — used only by the coverage.excluded-boundary test above.
const excludedStub: DependencyExtractor = {
  languages: new Set(['typescript']),
  rev: 1,
  declarations() {
    return [];
  },
  uses(file: ParsedFile): DetectedDep[] {
    if (file.path.endsWith('src/a/vendor/bad' + EXT)) {
      return [{ candidates: [{ kind: 'path', specifier: '../../b/bar' }], kind: 'import', line: 1 }];
    }
    return [];
  },
};

// Stub emitting one import from a/own.ts → ../b/bar — used only by the
// coverage.excluded-boundary mirror test above (own.ts is NOT under the
// excluded root, so this import must still be caught as undeclared).
const excludedMirrorStub: DependencyExtractor = {
  languages: new Set(['typescript']),
  rev: 1,
  declarations() {
    return [];
  },
  uses(file: ParsedFile): DetectedDep[] {
    if (file.path.endsWith('src/a/own' + EXT)) {
      return [{ candidates: [{ kind: 'path', specifier: '../b/bar' }], kind: 'import', line: 1 }];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------
// The file-enumeration guard above (`expandMappingPathsWithinOwnGraph`) only
// decides which files EACH NODE reads to analyze its OWN outgoing imports.
// Resolving an import SPECIFIER to a file and asking who owns that file is a
// separate mechanism (relations/resolver.ts, fed by the owner index built in
// runRelationPass) — an import reaching INTO an excluded subtree from a
// NON-excluded file must be silent too, exactly like an import reaching any
// other unmapped target already is (D7): the target file is never enforced,
// so naming its textual owner and refusing the importing node would demand a
// declared relation to a component that does not enforce the file at all.
// ---------------------------------------------------------------------------
describe('runRelationPass silences an import whose TARGET resolves inside a coverage.excluded root', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-pass-target-excluded-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\ncoverage:\n  excluded:\n    - src/a/vendor/\n`,
      'utf-8',
    );
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');
    mkdirSync(path.join(root, 'src', 'a', 'vendor'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a', 'own' + EXT), 'export const own = 1;\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'a', 'vendor', 'lib' + EXT), 'export const lib = 1;\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'b', 'bar' + EXT), 'export const bar = 2;\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("an import from node b INTO node a's excluded subtree is never flagged as an undeclared dependency on a", async () => {
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: (language) => (language === 'typescript' ? targetExcludedStub : undefined),
      resolvePathToFile: (specifier) =>
        specifier === '../a/vendor/lib' ? 'src/a/vendor/lib' + EXT : undefined,
      symbolIndexDir: path.join(root, '.yg-cache-target-excluded'),
    });

    const b = result.violationsByNode.get('b');
    expect(b === undefined || b.verdict === 'approved').toBe(true);
    expect(b?.violations ?? []).toHaveLength(0);
  });

  it("control: the identical import aimed at a's NON-excluded file is still refused — the guard did not silence real cross-node imports generally", async () => {
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: (language) => (language === 'typescript' ? targetMirrorStub : undefined),
      resolvePathToFile: (specifier) =>
        specifier === '../a/own' ? 'src/a/own' + EXT : undefined,
      symbolIndexDir: path.join(root, '.yg-cache-target-excluded-mirror'),
    });

    const b = result.violationsByNode.get('b');
    expect(b).toBeDefined();
    expect(b!.verdict).toBe('refused');
    expect(b!.violations).toHaveLength(1);
    expect(b!.violations[0].ownerNode).toBe('a');
  });
});

// Stub emitting one import from b/bar.ts → ../a/vendor/lib (the excluded
// target) — used only by the target-excluded test above.
const targetExcludedStub: DependencyExtractor = {
  languages: new Set(['typescript']),
  rev: 1,
  declarations() {
    return [];
  },
  uses(file: ParsedFile): DetectedDep[] {
    if (file.path.endsWith('src/b/bar' + EXT)) {
      return [{ candidates: [{ kind: 'path', specifier: '../a/vendor/lib' }], kind: 'import', line: 1 }];
    }
    return [];
  },
};

// Stub emitting one import from b/bar.ts → ../a/own (a's NON-excluded file) —
// used only by the target-excluded mirror test above.
const targetMirrorStub: DependencyExtractor = {
  languages: new Set(['typescript']),
  rev: 1,
  declarations() {
    return [];
  },
  uses(file: ParsedFile): DetectedDep[] {
    if (file.path.endsWith('src/b/bar' + EXT)) {
      return [{ candidates: [{ kind: 'path', specifier: '../a/own' }], kind: 'import', line: 1 }];
    }
    return [];
  },
};

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
// Live type-relation gate — the TypedEdgeIndex must NEVER carry a node-owned ->
// node-owned edge (same node OR cross-node): that shape is relation-conformance's
// exclusive territory (violationsByNode/verifyNodeDeps already exempts a same-node
// self-edge outright and reports a genuinely undeclared cross-node one as
// relation-undeclared-dependency). Both nodes below share a type with a
// DENY-DEFAULT relations table, so a self-edge or an undeclared cross-node edge
// would be a live false positive (or a double-report) if TypedEdgeIndex ever
// included it — this is not a vacuous-allow setup that would hide the bug.
// ---------------------------------------------------------------------------
describe('runRelationPass — TypedEdgeIndex excludes node-owned <-> node-owned edges', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-pass-typededges-'));

    // 'service' carries a DENY-DEFAULT relations table with an empty explicit
    // list — every relation type is denied unless the target is named, which
    // NEITHER a same-node sibling NOR the undeclared cross-node target is. If
    // TypedEdgeIndex ever included either edge, computeTypeGateFindings would
    // report it as forbidden — the exact false positive this test rules out.
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n    relations:\n      calls: []\n      default: deny\n`,
      'utf-8',
    );
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\n`,
      'utf-8',
    );

    // Node 'a' owns TWO files (foo.ts, sibling.ts — the same-node pair) plus a
    // third (foo2.ts) that imports into node 'b', undeclared. No relation from
    // a to b is declared anywhere.
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a', 'foo' + EXT), 'export const foo = 1;\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'a', 'sibling' + EXT), 'export const sibling = 1;\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'a', 'foo2' + EXT), 'export const foo2 = 1;\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'b', 'bar2' + EXT), 'export const bar2 = 1;\n', 'utf-8');
    // An unmapped file, present so `typeCoveredFiles` below is genuinely non-empty
    // (matching a real coverage.type_level: true run) — its own edges are not
    // this test's concern; it exists only so the pass's node-owned-file
    // TypedEdgeIndex construction (skipped entirely when there are zero
    // type-covered files) actually runs, which is what lets this test exercise
    // the SAME code path a live run with the flag on would.
    mkdirSync(path.join(root, 'src', 'other'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'other', 'leaf' + EXT), 'export const leaf = 1;\n', 'utf-8');
  });

  /** Non-empty on purpose — see the `src/other/leaf.ts` comment above. */
  const typeCoveredFiles = new Map([['src/other/leaf' + EXT, 'service']]);

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const selfAndCrossStub: DependencyExtractor = {
    languages: new Set(['typescript']),
    rev: 1,
    declarations() {
      return [];
    },
    uses(file: ParsedFile): DetectedDep[] {
      if (file.path.endsWith('src/a/foo.ts')) {
        // Same-node self-edge: a -> a (via a sibling file in the SAME node).
        return [{ candidates: [{ kind: 'path', specifier: '../a/sibling' }], kind: 'import', line: 1 }];
      }
      if (file.path.endsWith('src/a/foo2.ts')) {
        // Cross-node, undeclared edge: a -> b.
        return [{ candidates: [{ kind: 'path', specifier: '../b/bar2' }], kind: 'import', line: 1 }];
      }
      return [];
    },
  };

  it('(a) a same-node sibling import produces ZERO TypedEdgeIndex entries and ZERO gate findings', async () => {
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: (language) => (language === 'typescript' ? selfAndCrossStub : undefined),
      resolvePathToFile: (specifier) => {
        if (specifier === '../a/sibling') return 'src/a/sibling' + EXT;
        if (specifier === '../b/bar2') return 'src/b/bar2' + EXT;
        return undefined;
      },
      symbolIndexDir: path.join(root, '.yg-cache-typededges'),
      typeCoveredFiles,
    });

    expect(result.typedEdges.edgesFrom('src/a/foo' + EXT)).toEqual([]);
    const findings = computeTypeGateFindings(graph.architecture, result.typedEdges, result.fileOwnerType);
    expect(findings).toEqual([]);
  });

  it('(b) a cross-node explicit edge is reported ONLY by relation-undeclared-dependency, never by the gate (no double-report)', async () => {
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: (language) => (language === 'typescript' ? selfAndCrossStub : undefined),
      resolvePathToFile: (specifier) => {
        if (specifier === '../a/sibling') return 'src/a/sibling' + EXT;
        if (specifier === '../b/bar2') return 'src/b/bar2' + EXT;
        return undefined;
      },
      symbolIndexDir: path.join(root, '.yg-cache-typededges'),
      typeCoveredFiles,
    });

    // relation-undeclared-dependency's own channel still catches it — untouched
    // by the type-relation gate.
    const a = result.violationsByNode.get('a');
    expect(a).toBeDefined();
    expect(a!.verdict).toBe('refused');
    expect(a!.violations.some((v) => v.ownerNode === 'b')).toBe(true);

    // The gate's own channel must NOT also carry this edge — no TypedEdgeIndex
    // entry, hence no finding, for the source file that made the cross-node
    // import.
    expect(result.typedEdges.edgesFrom('src/a/foo2' + EXT)).toEqual([]);
    const findings = computeTypeGateFindings(graph.architecture, result.typedEdges, result.fileOwnerType);
    expect(findings).toEqual([]);
  });
});

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

// ---------------------------------------------------------------------------
// A Go import to a package DIRECTORY resolves through a representative file the
// resolver picks from the directory's owner set (relations/extractors/go-resolve.ts).
// That representative pick must ignore an excluded file exactly like every other
// ownership question this graph answers — an unguarded pick can land on the
// excluded file, and the resolver's own (guarded) ownership lookup on THAT file
// then reports "no owner", silencing the whole edge even though the package's
// OTHER, non-excluded file is fully enforced. The candidate list the resolver
// walks is lexicographically sorted, so whether the excluded member sorts first
// or last changes which file the (buggy, unguarded) pick lands on — only a
// first-sorting exclusion can hide the violation; a last-sorting one never could,
// which is why both orderings are pinned here.
// ---------------------------------------------------------------------------
describe("runRelationPass — an excluded file must never become a Go package's owner representative", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-pass-pkg-rep-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    writeNode(root, 'a', 'A', 'pkg/a');
    writeNode(root, 'b', 'B', 'pkg/b');

    writeFileSync(path.join(root, 'go.mod'), 'module example.com/m\n\ngo 1.22\n', 'utf-8');

    mkdirSync(path.join(root, 'pkg', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'pkg', 'b'), { recursive: true });
    // Two files in package a, one sorting FIRST and one sorting LAST — the
    // package's owner-set walk visits them in that lexical order.
    writeFileSync(path.join(root, 'pkg', 'a', 'aaa_gen.go'), 'package a\n\nfunc Gen() int { return 0 }\n', 'utf-8');
    writeFileSync(path.join(root, 'pkg', 'a', 'zzz_kept.go'), 'package a\n\nfunc Kept() int { return 1 }\n', 'utf-8');
    // node b has NO declared relation to node a — this import is genuinely undeclared.
    writeFileSync(
      path.join(root, 'pkg', 'b', 'b.go'),
      'package b\n\nimport "example.com/m/pkg/a"\n\nfunc Use() int { return a.Kept() }\n',
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('excluding the package member that sorts FIRST does not silence a real undeclared dependency reached through the package\'s other, non-excluded file', async () => {
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\ncoverage:\n  excluded:\n    - pkg/a/aaa_gen.go\n`,
      'utf-8',
    );
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-pkg-rep-first'),
    });

    const b = result.violationsByNode.get('b');
    expect(b).toBeDefined();
    expect(b!.verdict).toBe('refused');
    expect(b!.violations.some((v) => v.ownerNode === 'a')).toBe(true);
  });

  it('control: excluding the package member that sorts LAST still reports the same violation', async () => {
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\ncoverage:\n  excluded:\n    - pkg/a/zzz_kept.go\n`,
      'utf-8',
    );
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-pkg-rep-last'),
    });

    const b = result.violationsByNode.get('b');
    expect(b).toBeDefined();
    expect(b!.verdict).toBe('refused');
    expect(b!.violations.some((v) => v.ownerNode === 'a')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A Go package split across TWO nodes (each mapping one exact file) silences
// an import into it when nothing is excluded — no single owner can stand for
// both without fabricating or hiding a cross-node edge
// (relations/extractors/go-resolve.ts). Excluding ONE of the split package's
// two files removes that file from consideration and nothing else: the owner
// decision is then made over what remains, which is a single file with a
// single owner, so the import attributes to that owner. This is the same
// drop-then-decide rule the "owner representative" block above pins for a
// single-owner package, applied to a package that starts out genuinely split.
// ---------------------------------------------------------------------------
describe('runRelationPass — excluding one file of a split Go package attributes the import to whichever owner is left', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-pass-pkg-split-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    // Two nodes, each mapping EXACTLY one file of the same Go package directory —
    // a genuine split, unlike the single-node "owner representative" fixture above.
    writeNode(root, 'a1', 'A1', 'pkg/a/aaa_gen.go');
    writeNode(root, 'a2', 'A2', 'pkg/a/zzz_kept.go');
    writeNode(root, 'b', 'B', 'pkg/b');

    writeFileSync(path.join(root, 'go.mod'), 'module example.com/m\n\ngo 1.22\n', 'utf-8');

    mkdirSync(path.join(root, 'pkg', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'pkg', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'pkg', 'a', 'aaa_gen.go'), 'package a\n\nfunc Gen() int { return 0 }\n', 'utf-8');
    writeFileSync(path.join(root, 'pkg', 'a', 'zzz_kept.go'), 'package a\n\nfunc Kept() int { return 1 }\n', 'utf-8');
    // b imports the package and calls Kept() — defined in zzz_kept.go, owned by a2 —
    // but the resolver attributes at PACKAGE granularity, so which file defines
    // Kept() is irrelevant to which node(s) the import could ever legally reach.
    writeFileSync(
      path.join(root, 'pkg', 'b', 'b.go'),
      'package b\n\nimport "example.com/m/pkg/a"\n\nfunc Use() int { return a.Kept() }\n',
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('control: with no exclusion, the split package silences the import for BOTH candidate owners', async () => {
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\n`,
      'utf-8',
    );
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-pkg-split-none'),
    });

    const b = result.violationsByNode.get('b');
    const flagged = b?.violations.some((v) => v.ownerNode === 'a1' || v.ownerNode === 'a2') ?? false;
    expect(flagged).toBe(false);
  });

  it('excluding the FIRST-sorting member (a1\'s file) attributes the import to a2, the owner that remains', async () => {
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\ncoverage:\n  excluded:\n    - pkg/a/aaa_gen.go\n`,
      'utf-8',
    );
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-pkg-split-first'),
    });

    const b = result.violationsByNode.get('b');
    expect(b).toBeDefined();
    expect(b!.verdict).toBe('refused');
    expect(b!.violations.some((v) => v.ownerNode === 'a2')).toBe(true);
    expect(b!.violations.some((v) => v.ownerNode === 'a1')).toBe(false);
  });

  it('excluding the LAST-sorting member (a2\'s file, the one that actually defines Kept()) attributes the import to a1, the owner that remains', async () => {
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\ncoverage:\n  excluded:\n    - pkg/a/zzz_kept.go\n`,
      'utf-8',
    );
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-pkg-split-last'),
    });

    const b = result.violationsByNode.get('b');
    expect(b).toBeDefined();
    expect(b!.verdict).toBe('refused');
    expect(b!.violations.some((v) => v.ownerNode === 'a1')).toBe(true);
    expect(b!.violations.some((v) => v.ownerNode === 'a2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A package split across THREE nodes stays split — and silent — even after
// one member is excluded: two distinct owners are still left among the
// non-excluded files, so there is still no single owner to attribute the
// import to.
// ---------------------------------------------------------------------------
describe('runRelationPass — a three-way split Go package stays silent after excluding one member', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-pass-pkg-split3-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    writeNode(root, 'a1', 'A1', 'pkg/a/aaa.go');
    writeNode(root, 'a2', 'A2', 'pkg/a/mmm.go');
    writeNode(root, 'a3', 'A3', 'pkg/a/zzz.go');
    writeNode(root, 'b', 'B', 'pkg/b');

    writeFileSync(path.join(root, 'go.mod'), 'module example.com/m\n\ngo 1.22\n', 'utf-8');
    mkdirSync(path.join(root, 'pkg', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'pkg', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'pkg', 'a', 'aaa.go'), 'package a\n\nfunc Aaa() int { return 0 }\n', 'utf-8');
    writeFileSync(path.join(root, 'pkg', 'a', 'mmm.go'), 'package a\n\nfunc Mmm() int { return 1 }\n', 'utf-8');
    writeFileSync(path.join(root, 'pkg', 'a', 'zzz.go'), 'package a\n\nfunc Zzz() int { return 2 }\n', 'utf-8');
    writeFileSync(
      path.join(root, 'pkg', 'b', 'b.go'),
      'package b\n\nimport "example.com/m/pkg/a"\n\nfunc Use() int { return a.Mmm() }\n',
      'utf-8',
    );
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\ncoverage:\n  excluded:\n    - pkg/a/aaa.go\n`,
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('excluding a1\'s file leaves a2 and a3 as two distinct owners — still split, still silent', async () => {
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-pkg-split3'),
    });

    const b = result.violationsByNode.get('b');
    const flagged = b?.violations.some((v) => v.ownerNode === 'a1' || v.ownerNode === 'a2' || v.ownerNode === 'a3') ?? false;
    expect(flagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A single-file Go package: the ordinary case (reported), that one file
// excluded (silent — the whole target is gone), and an UNRELATED file
// excluded elsewhere in the repo (still reported — exclusion does not
// silence generally).
// ---------------------------------------------------------------------------
describe('runRelationPass — a single-file Go package', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-pass-pkg-single-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    writeNode(root, 'a', 'A', 'pkg/a');
    writeNode(root, 'b', 'B', 'pkg/b');
    writeFileSync(path.join(root, 'go.mod'), 'module example.com/m\n\ngo 1.22\n', 'utf-8');
    mkdirSync(path.join(root, 'pkg', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'pkg', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'pkg', 'a', 'only.go'), 'package a\n\nfunc Only() int { return 0 }\n', 'utf-8');
    writeFileSync(
      path.join(root, 'pkg', 'b', 'b.go'),
      'package b\n\nimport "example.com/m/pkg/a"\n\nfunc Use() int { return a.Only() }\n',
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('control: reported when nothing is excluded', async () => {
    writeFileSync(path.join(root, '.yggdrasil', 'yg-config.yaml'), `quality:\n  max_direct_relations: 10\n`, 'utf-8');
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-pkg-single-none'),
    });
    const b = result.violationsByNode.get('b');
    expect(b?.verdict).toBe('refused');
    expect(b!.violations.some((v) => v.ownerNode === 'a')).toBe(true);
  });

  it('the package\'s only file excluded: silent — the whole target is gone', async () => {
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\ncoverage:\n  excluded:\n    - pkg/a/only.go\n`,
      'utf-8',
    );
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-pkg-single-excl'),
    });
    const b = result.violationsByNode.get('b');
    expect(b?.violations.some((v) => v.ownerNode === 'a') ?? false).toBe(false);
  });

  it('an UNRELATED file excluded elsewhere: still reported — exclusion does not silence generally', async () => {
    writeFileSync(path.join(root, 'pkg', 'b', 'unrelated.go'), 'package b\n\nfunc Unrelated() int { return 0 }\n', 'utf-8');
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\ncoverage:\n  excluded:\n    - pkg/b/unrelated.go\n`,
      'utf-8',
    );
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-pkg-single-unrelated'),
    });
    const b = result.violationsByNode.get('b');
    expect(b?.verdict).toBe('refused');
    expect(b!.violations.some((v) => v.ownerNode === 'a')).toBe(true);
  });
});
