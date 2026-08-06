import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// End-to-end: Go relation conformance is LIVE. We build a temp repo from
// scratch, spawn the REAL built binary, and assert that an undeclared
// cross-node package import is refused by `yg check --approve` (exit 1), then
// that declaring the relation clears it (exit 0). Mirrors
// tests/e2e/relation-python.test.ts.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, status: result.status, all: stdout + stderr };
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/**
 * Build a temp repo with two component nodes a, b under src/, where a/foo.go
 * imports package b across the node boundary (`import "example.com/m/src/b"`).
 * The single `component` type maps `src/**` and allows `uses: [component]`, so
 * the only thing verified is the deterministic relation-conformance pass (no
 * aspects → no LLM needed). A go.mod at the root supplies the module path.
 * `withRelation` controls whether a declares the relation to b.
 */
function buildRepo(label: string, withRelation: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), `yg-rel-go-${label}-`));

  writeFile(
    root,
    '.yggdrasil/yg-architecture.yaml',
    [
      'node_types:',
      '  component:',
      "    description: 'A source component mapped under src/.'",
      '    log_required: false',
      '    when:',
      '      path: "src/**"',
      '    relations:',
      '      uses: [component]',
      '',
    ].join('\n'),
  );
  writeFile(
    root,
    '.yggdrasil/yg-config.yaml',
    [
      'version: "5.2.0"',
      '',
      'quality:',
      '  max_direct_relations: 10',
      '',
      'coverage:',
      '  required: []',
      '',
      'reviewer:',
      '  default: standard',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: "qwen2.5-coder:0.5b"',
      '        endpoint: "http://host.docker.internal:11434"',
      '',
    ].join('\n'),
  );

  // go.mod at the repo root → module path `example.com/m`.
  writeFile(root, 'go.mod', 'module example.com/m\n\ngo 1.22\n');

  // Node b — the dependency target package.
  writeFile(
    root,
    '.yggdrasil/model/b/yg-node.yaml',
    'name: B\ndescription: Dependency target component.\ntype: component\nmapping:\n  - src/b\n',
  );
  // Node a — imports across the boundary into b. With/without the declared relation.
  const aNode = withRelation
    ? 'name: A\ndescription: Importing component.\ntype: component\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/a\n'
    : 'name: A\ndescription: Importing component.\ntype: component\nmapping:\n  - src/a\n';
  writeFile(root, '.yggdrasil/model/a/yg-node.yaml', aNode);

  // Source — a/foo.go imports package b (in-module path resolves via go.mod).
  writeFile(
    root,
    'src/a/foo.go',
    'package a\n\nimport "example.com/m/src/b"\n\nvar Foo = b.X\n',
  );
  writeFile(root, 'src/b/bar.go', 'package b\n\nvar X = 1\n');

  return root;
}

describe.skipIf(!distExists)('CLI E2E — Go relation conformance (live)', () => {
  it('silences a package directory split across two nodes, but still flags an undeclared edge for a single-owner package', () => {
    // buildSplitRepo: one Go package dir `src/pkg` whose two files belong to
    // DIFFERENT nodes — px maps src/pkg/a*.go, py maps src/pkg/z*.go. A third
    // node `caller` imports "example.com/m/src/pkg" and declares NO relation.
    // Because the package has 2 distinct owners, owner-set resolution silences
    // it: no edge, no violation. (Pre-fix: pick[0] attributes the whole import
    // to whichever node owns the lexicographically-first file → false positive.)
    function buildSplitRepo(label: string): string {
      const root = mkdtempSync(path.join(tmpdir(), `yg-rel-go-${label}-`));
      writeFile(
        root,
        '.yggdrasil/yg-architecture.yaml',
        [
          'node_types:',
          '  component:',
          "    description: 'A source component mapped under src/.'",
          '    log_required: false',
          '    when:',
          '      path: "src/**"',
          '    relations:',
          '      uses: [component]',
          '',
        ].join('\n'),
      );
      writeFile(
        root,
        '.yggdrasil/yg-config.yaml',
        [
          'version: "5.2.0"',
          '',
          'quality:',
          '  max_direct_relations: 10',
          '',
          'coverage:',
          '  required: []',
          '',
          'reviewer:',
          '  default: standard',
          '  tiers:',
          '    standard:',
          '      provider: ollama',
          '      consensus: 1',
          '      config:',
          '        model: "qwen2.5-coder:0.5b"',
          '        endpoint: "http://host.docker.internal:11434"',
          '',
        ].join('\n'),
      );
      writeFile(root, 'go.mod', 'module example.com/m\n\ngo 1.22\n');

      // Two owners carve ONE directory src/pkg via file-glob mappings.
      writeFile(
        root,
        '.yggdrasil/model/px/yg-node.yaml',
        'name: PX\ndescription: Owner of a-files in pkg.\ntype: component\nmapping:\n  - src/pkg/a*.go\n',
      );
      writeFile(
        root,
        '.yggdrasil/model/py/yg-node.yaml',
        'name: PY\ndescription: Owner of z-files in pkg.\ntype: component\nmapping:\n  - src/pkg/z*.go\n',
      );
      // caller imports the split package, declares NO relation.
      writeFile(
        root,
        '.yggdrasil/model/caller/yg-node.yaml',
        'name: Caller\ndescription: Imports the split package.\ntype: component\nmapping:\n  - src/caller\n',
      );

      // src/pkg split: a_one.go (owner px), z_two.go (owner py). Both package pkg.
      writeFile(root, 'src/pkg/a_one.go', 'package pkg\n\nvar A = 1\n');
      writeFile(root, 'src/pkg/z_two.go', 'package pkg\n\nvar Z = 2\n');
      // caller imports the package across the boundary.
      writeFile(
        root,
        'src/caller/use.go',
        'package caller\n\nimport "example.com/m/src/pkg"\n\nvar Use = pkg.A\n',
      );
      return root;
    }

    const split = buildSplitRepo('split');
    try {
      const res = run(['check', '--approve'], split);
      // Split package → owner-set silence → no undeclared-dependency, check passes.
      expect(res.all).not.toContain('relation-undeclared-dependency');
      expect(res.status).toBe(0);
    } finally {
      rmSync(split, { recursive: true, force: true });
    }

    // Paired positive: a SINGLE-owner package must still flag an undeclared edge
    // (proves the owner-set guard did not blanket-silence Go resolution).
    const single = buildRepo('single-owner', false);
    try {
      const res = run(['check', '--approve'], single);
      expect(res.status).toBe(1);
      expect(res.all).toContain('relation-undeclared-dependency');
      expect(res.all).toContain('src/a/foo.go');
    } finally {
      rmSync(single, { recursive: true, force: true });
    }
  });

  it('refuses an undeclared cross-node import, then passes once the relation is declared', () => {
    // 1. No declared relation → the cross-node import is refused.
    const undeclared = buildRepo('undeclared', false);
    try {
      const refused = run(['check', '--approve'], undeclared);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('relation-undeclared-dependency');
      expect(refused.all).toContain('b');
      expect(refused.all).toContain('src/a/foo.go');
    } finally {
      rmSync(undeclared, { recursive: true, force: true });
    }

    // 2. With the relation declared (a --uses--> b) → check passes.
    const declared = buildRepo('declared', true);
    try {
      const ok = run(['check', '--approve'], declared);
      expect(ok.status).toBe(0);
      expect(ok.all).not.toContain('relation-undeclared-dependency');
    } finally {
      rmSync(declared, { recursive: true, force: true });
    }
  });
});
