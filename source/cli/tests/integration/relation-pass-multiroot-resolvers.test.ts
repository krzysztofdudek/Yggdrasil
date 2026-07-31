import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { guardedResolve } from '../../src/relations/resolve-path.js';

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
