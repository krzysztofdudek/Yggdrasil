import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { guardedResolve } from '../../src/relations/resolve-path.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Committed, permanent fixtures (never a scratch copy) — the ancestor-root/same-root
// shadow shapes below need real on-disk source trees, and the ONLY thing that varies
// between a test's "control" and "excluded" runs is coverage.excluded, which is set
// in memory on the loaded graph before resolving, rather than by writing a second
// on-disk config. Each fixture's own AST-fact cache directory
// (.yggdrasil/.ast-cache/, gitignored the same way a real project's is) is reused
// freely across every test below — the cache is content-addressed, so re-running
// with a different coverage.excluded value never stales it.
const JAVA_SHADOW_FIXTURE = path.resolve(__dirname, '../fixtures/java-ancestor-root-shadow');
const PYTHON_SHADOW_FIXTURE = path.resolve(__dirname, '../fixtures/python-modpkg-shadow');

function writeNode(root: string, nodeRel: string, name: string, mapping: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'yg-node.yaml'),
    `name: ${name}\ntype: service\nmapping:\n  - ${mapping}\n`,
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// Python's absolute-import resolver probes every ancestor source root of the
// importing file, so a dotted module can genuinely resolve to 2+ distinct files
// (one root shadowing another) — an ambiguity it correctly stays silent over.
// Excluding ONE of the two candidates removes that candidate's own contribution
// to the ambiguity count and nothing else: the resolver decides from what
// remains, which is a single live candidate, so the import now attributes to
// that survivor's owner — the same drop-then-decide rule pinned for Go's
// split-package resolver, applied to Python's multi-root candidate set instead
// of a package's file list.
// ---------------------------------------------------------------------------
describe('runRelationPass — excluding one of two shadowing Python module candidates attributes the import to whichever survives', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-pass-py-shadow-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    // svc/app/main.py imports the dotted module `lib.mod`. TWO ancestor roots of
    // main.py's own directory (svc/app/ and svc/) each hold a file matching that
    // module — a genuine, unresolved shadow, not an artifact of the fixture.
    writeNode(root, 'app', 'App', 'svc/app/main.py');
    writeNode(root, 'shadow', 'Shadow', 'svc/app/lib/mod.py');
    writeNode(root, 'real', 'Real', 'svc/lib/mod.py');

    mkdirSync(path.join(root, 'svc', 'app', 'lib'), { recursive: true });
    mkdirSync(path.join(root, 'svc', 'lib'), { recursive: true });
    writeFileSync(path.join(root, 'svc', 'app', 'main.py'), 'import lib.mod\n', 'utf-8');
    writeFileSync(path.join(root, 'svc', 'app', 'lib', 'mod.py'), 'class Decoy:\n    pass\n', 'utf-8');
    writeFileSync(path.join(root, 'svc', 'lib', 'mod.py'), 'class Real:\n    pass\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('control: with no exclusion, the two shadowing candidates silence the import for BOTH', async () => {
    writeFileSync(path.join(root, '.yggdrasil', 'yg-config.yaml'), `quality:\n  max_direct_relations: 10\n`, 'utf-8');
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-py-shadow-none'),
    });
    const app = result.violationsByNode.get('app');
    const flagged = app?.violations.some((v) => v.ownerNode === 'shadow' || v.ownerNode === 'real') ?? false;
    expect(flagged).toBe(false);
  });

  it("excluding the candidate that sorts FIRST ('svc/app/lib/mod.py') attributes the import to 'real', the survivor", async () => {
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\ncoverage:\n  excluded:\n    - svc/app/lib/mod.py\n`,
      'utf-8',
    );
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-py-shadow-first'),
    });
    const app = result.violationsByNode.get('app');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 'real')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 'shadow')).toBe(false);
  });

  it("excluding the candidate that sorts LAST ('svc/lib/mod.py') attributes the import to 'shadow', the survivor", async () => {
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\ncoverage:\n  excluded:\n    - svc/lib/mod.py\n`,
      'utf-8',
    );
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-py-shadow-last'),
    });
    const app = result.violationsByNode.get('app');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 'shadow')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 'real')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PHP's PSR-4 resolver tries every base directory of the matched prefix, so a
// class FQN can genuinely resolve to 2+ distinct files when a prefix maps to
// two roots and both hold the class — an ambiguity it correctly stays silent
// over (PSR-4 itself resolves such a clash arbitrarily at runtime, so a static
// tool must not guess). Excluding ONE of the two candidate files removes that
// file's own contribution to the ambiguity count and nothing else: the import
// now attributes to whichever root's copy remains — the same drop-then-decide
// rule pinned for Go and for Python above.
// ---------------------------------------------------------------------------
describe('runRelationPass — excluding one of two PSR-4 root copies of a PHP class attributes the import to whichever survives', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-pass-php-psr4-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    writeNode(root, 'app', 'App', 'caller.php');
    writeNode(root, 's1', 'S1', 'src1/Svc/S1.php');
    writeNode(root, 's2', 'S2', 'src2/Svc/S1.php');

    writeFileSync(
      path.join(root, 'composer.json'),
      JSON.stringify({ autoload: { 'psr-4': { 'App\\': ['src1', 'src2'] } } }),
      'utf-8',
    );
    mkdirSync(path.join(root, 'src1', 'Svc'), { recursive: true });
    mkdirSync(path.join(root, 'src2', 'Svc'), { recursive: true });
    writeFileSync(path.join(root, 'src1', 'Svc', 'S1.php'), '<?php\nnamespace App\\Svc;\nclass S1 {}\n', 'utf-8');
    writeFileSync(path.join(root, 'src2', 'Svc', 'S1.php'), '<?php\nnamespace App\\Svc;\nclass S1 {}\n', 'utf-8');
    writeFileSync(path.join(root, 'caller.php'), '<?php\nuse App\\Svc\\S1;\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('control: with no exclusion, the two PSR-4 roots silence the import for BOTH', async () => {
    writeFileSync(path.join(root, '.yggdrasil', 'yg-config.yaml'), `quality:\n  max_direct_relations: 10\n`, 'utf-8');
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-php-psr4-none'),
    });
    const app = result.violationsByNode.get('app');
    const flagged = app?.violations.some((v) => v.ownerNode === 's1' || v.ownerNode === 's2') ?? false;
    expect(flagged).toBe(false);
  });

  it("excluding the root that sorts FIRST ('src1/Svc/S1.php') attributes the import to 's2', the survivor", async () => {
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\ncoverage:\n  excluded:\n    - src1/Svc/S1.php\n`,
      'utf-8',
    );
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-php-psr4-first'),
    });
    const app = result.violationsByNode.get('app');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 's2')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 's1')).toBe(false);
  });

  it("excluding the root that sorts LAST ('src2/Svc/S1.php') attributes the import to 's1', the survivor", async () => {
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\ncoverage:\n  excluded:\n    - src2/Svc/S1.php\n`,
      'utf-8',
    );
    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(root, graph),
      symbolIndexDir: path.join(root, '.yg-cache-php-psr4-last'),
    });
    const app = result.violationsByNode.get('app');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 's1')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 's2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Java's ancestor-source-root search is nearest-first-wins, never "collect a
// candidate set and decide" — unlike Python's and PHP's resolvers above. The
// importer at src/main/java/com/app/ climbs its own ancestor chain looking
// for com/a/Zzz.java; a half-migrated or flat layout can leave the SAME FQN's
// file sitting under two different ancestor roots (one nested under
// src/main/java, one directly under src), and the nearer one always won —
// unconditionally, with no exclusion awareness at all — so excluding it could
// only silence the import, never fall through to the farther, still-live copy.
// The fixture (tests/fixtures/java-ancestor-root-shadow) is a permanent, real
// on-disk project; only coverage.excluded varies between the cases below, set
// in memory on the loaded graph before resolving.
// ---------------------------------------------------------------------------
describe('runRelationPass — excluding the nearer of two ancestor-root copies of a Java type lets a precise import fall through to the farther, still-live copy', () => {
  const symbolIndexDir = path.join(JAVA_SHADOW_FIXTURE, '.yggdrasil', '.ast-cache');

  it('control: with no exclusion, the nearer ancestor root wins', async () => {
    const graph = await loadGraph(JAVA_SHADOW_FIXTURE);
    const result = await runRelationPass(graph, JAVA_SHADOW_FIXTURE, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(JAVA_SHADOW_FIXTURE, graph),
      symbolIndexDir,
    });
    const app = result.violationsByNode.get('app-precise');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 'near')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 'far')).toBe(false);
  });

  it("excluding the nearer copy ('src/main/java/com/a/Zzz.java') attributes the import to the farther, still-live copy", async () => {
    const graph = await loadGraph(JAVA_SHADOW_FIXTURE);
    graph.config.coverage = { required: [], excluded: ['src/main/java/com/a/Zzz.java'], typeLevel: false };
    const result = await runRelationPass(graph, JAVA_SHADOW_FIXTURE, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(JAVA_SHADOW_FIXTURE, graph),
      symbolIndexDir,
    });
    const app = result.violationsByNode.get('app-precise');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 'far')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 'near')).toBe(false);
  });

  it("excluding the farther copy ('src/com/a/Zzz.java') leaves the nearer resolution unaffected", async () => {
    const graph = await loadGraph(JAVA_SHADOW_FIXTURE);
    graph.config.coverage = { required: [], excluded: ['src/com/a/Zzz.java'], typeLevel: false };
    const result = await runRelationPass(graph, JAVA_SHADOW_FIXTURE, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(JAVA_SHADOW_FIXTURE, graph),
      symbolIndexDir,
    });
    const app = result.violationsByNode.get('app-precise');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 'near')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 'far')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The same ancestor-root shape, through a WILDCARD import: the package resolver
// commits to the first ancestor directory that holds any .java file at all,
// which used to mean an excluded-only directory still ended the search — the
// caller's later exclusion filter had nothing left to fall back on. Same
// fixture, same near/far source roots — only the importer file and node differ.
// ---------------------------------------------------------------------------
describe('runRelationPass — excluding the nearer of two ancestor-root package directories lets a wildcard import fall through to the farther, still-live directory', () => {
  const symbolIndexDir = path.join(JAVA_SHADOW_FIXTURE, '.yggdrasil', '.ast-cache');

  it('control: with no exclusion, the nearer ancestor root directory wins', async () => {
    const graph = await loadGraph(JAVA_SHADOW_FIXTURE);
    const result = await runRelationPass(graph, JAVA_SHADOW_FIXTURE, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(JAVA_SHADOW_FIXTURE, graph),
      symbolIndexDir,
    });
    const app = result.violationsByNode.get('app-wildcard');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 'near')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 'far')).toBe(false);
  });

  it("excluding the nearer directory's only file attributes the import to the farther, still-live directory", async () => {
    const graph = await loadGraph(JAVA_SHADOW_FIXTURE);
    graph.config.coverage = { required: [], excluded: ['src/main/java/com/a/Zzz.java'], typeLevel: false };
    const result = await runRelationPass(graph, JAVA_SHADOW_FIXTURE, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(JAVA_SHADOW_FIXTURE, graph),
      symbolIndexDir,
    });
    const app = result.violationsByNode.get('app-wildcard');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 'far')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 'near')).toBe(false);
  });

  it("excluding the farther directory's only file leaves the nearer resolution unaffected", async () => {
    const graph = await loadGraph(JAVA_SHADOW_FIXTURE);
    graph.config.coverage = { required: [], excluded: ['src/com/a/Zzz.java'], typeLevel: false };
    const result = await runRelationPass(graph, JAVA_SHADOW_FIXTURE, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(JAVA_SHADOW_FIXTURE, graph),
      symbolIndexDir,
    });
    const app = result.violationsByNode.get('app-wildcard');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 'near')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 'far')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Python's per-root candidate search tries a module-as-file before a same-named
// package at every ancestor root, but previously stopped at the first EXISTING
// candidate regardless of exclusion — so at a single root holding both `mod.py`
// and `mod/__init__.py` (a package outranks a same-named module at runtime, per
// CPython's own import semantics), excluding the module could not fall through
// to the live package sitting right next to it. The fixture
// (tests/fixtures/python-modpkg-shadow) is a permanent, real on-disk project.
// ---------------------------------------------------------------------------
describe('runRelationPass — excluding a module file that shadows a same-root package attributes an absolute import to the live package', () => {
  const symbolIndexDir = path.join(PYTHON_SHADOW_FIXTURE, '.yggdrasil', '.ast-cache');

  it('control: with no exclusion, the module file wins over the same-root package', async () => {
    const graph = await loadGraph(PYTHON_SHADOW_FIXTURE);
    const result = await runRelationPass(graph, PYTHON_SHADOW_FIXTURE, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(PYTHON_SHADOW_FIXTURE, graph),
      symbolIndexDir,
    });
    const app = result.violationsByNode.get('app-abs');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 'modfile-abs')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 'modpkg-abs')).toBe(false);
  });

  it("excluding the module file ('lib/mod.py') attributes the import to the live package", async () => {
    const graph = await loadGraph(PYTHON_SHADOW_FIXTURE);
    graph.config.coverage = { required: [], excluded: ['lib/mod.py'], typeLevel: false };
    const result = await runRelationPass(graph, PYTHON_SHADOW_FIXTURE, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(PYTHON_SHADOW_FIXTURE, graph),
      symbolIndexDir,
    });
    const app = result.violationsByNode.get('app-abs');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 'modpkg-abs')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 'modfile-abs')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The same module/package shadow, through a RELATIVE import (`from .mod import
// X`) — the relative resolver received no isExcluded parameter at all, so
// excluding the module file had no effect on it whatsoever. Same fixture as
// above; the relative shape uses its own sibling module/package pair so the
// two shapes never interact on disk.
// ---------------------------------------------------------------------------
describe('runRelationPass — excluding a module file that shadows a same-root package attributes a relative import to the live package', () => {
  const symbolIndexDir = path.join(PYTHON_SHADOW_FIXTURE, '.yggdrasil', '.ast-cache');

  it('control: with no exclusion, the module file wins over the same-root package', async () => {
    const graph = await loadGraph(PYTHON_SHADOW_FIXTURE);
    const result = await runRelationPass(graph, PYTHON_SHADOW_FIXTURE, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(PYTHON_SHADOW_FIXTURE, graph),
      symbolIndexDir,
    });
    const app = result.violationsByNode.get('app-rel');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 'modfile-rel')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 'modpkg-rel')).toBe(false);
  });

  it("excluding the module file ('app/mod.py') attributes the import to the live package", async () => {
    const graph = await loadGraph(PYTHON_SHADOW_FIXTURE);
    graph.config.coverage = { required: [], excluded: ['app/mod.py'], typeLevel: false };
    const result = await runRelationPass(graph, PYTHON_SHADOW_FIXTURE, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(PYTHON_SHADOW_FIXTURE, graph),
      symbolIndexDir,
    });
    const app = result.violationsByNode.get('app-rel');
    expect(app).toBeDefined();
    expect(app!.verdict).toBe('refused');
    expect(app!.violations.some((v) => v.ownerNode === 'modpkg-rel')).toBe(true);
    expect(app!.violations.some((v) => v.ownerNode === 'modfile-rel')).toBe(false);
  });
});
