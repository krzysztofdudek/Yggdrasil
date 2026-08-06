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
// End-to-end: Kotlin relation conformance is LIVE — and the FIRST language that
// resolves through the shared SymbolTable rather than a path mapping. We build a
// temp repo from scratch, spawn the REAL built binary, and assert:
//   1. an undeclared cross-node import is refused by `yg check --approve` (exit 1);
//   2. declaring the relation clears it under `--approve` (exit 0);
//   3. CRITICAL — a PLAIN `yg check` AFTER `--approve` returns exit 0 / verified
//      (NOT unverified). This proves verify.ts's parse-free symbol re-validation
//      reconstructs the SAME fingerprint the pass sealed. If this comes back
//      unverified, the symbol re-validation path is broken.
//
// Kotlin's package is decoupled from the directory, so the source dirs (src/a,
// src/b) deliberately do NOT mirror the package names (com.x.*).
// Mirrors tests/e2e/relation-java.test.ts, with the round-trip assertion added.
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
 * Build a temp repo with two component nodes a, b under src/, where a/Foo.kt
 * imports b's class across the node boundary (`import com.x.b.Bar`). The single
 * `component` type maps `src/**` and allows `uses: [component]`, so the only thing
 * verified is the deterministic relation-conformance pass (no aspects → no LLM
 * needed). Packages are decoupled from directories to exercise the SymbolTable.
 * `withRelation` controls whether a declares the relation to b.
 */
function buildRepo(label: string, withRelation: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), `yg-rel-kotlin-${label}-`));

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

  // Node b — the dependency target. Directory src/b, package com.x.b.
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

  // Source — a/Foo.kt depends on b/Bar.kt by FQN import. Note: src dir != package.
  writeFile(
    root,
    'src/a/Foo.kt',
    'package com.x.a\nimport com.x.b.Bar\nclass Foo {\n  val bar: Bar? = null\n}\n',
  );
  writeFile(
    root,
    'src/b/Bar.kt',
    'package com.x.b\nclass Bar\n',
  );

  return root;
}

describe.skipIf(!distExists)('CLI E2E — Kotlin relation conformance (live, symbol-table)', () => {
  it('refuses an undeclared cross-node import, then passes once the relation is declared', () => {
    // 1. No declared relation → the cross-node import is refused.
    const undeclared = buildRepo('undeclared', false);
    try {
      const refused = run(['check', '--approve'], undeclared);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('relation-undeclared-dependency');
      expect(refused.all).toContain('b');
      expect(refused.all).toContain('src/a/Foo.kt');
    } finally {
      rmSync(undeclared, { recursive: true, force: true });
    }

    // 2. With the relation declared (a --uses--> b) → check --approve passes.
    const declared = buildRepo('declared', true);
    try {
      const ok = run(['check', '--approve'], declared);
      expect(ok.status, ok.all).toBe(0);
      expect(ok.all).not.toContain('relation-undeclared-dependency');

      // 3. CRITICAL round-trip: a PLAIN `yg check` (no --approve, no parsing) after
      //    the seal must stay GREEN — the symbol verdict re-validates parse-free to
      //    the SAME fingerprint. A regression here surfaces as exit 1 / unverified.
      const plain = run(['check'], declared);
      expect(plain.status, plain.all).toBe(0);
      expect(plain.all).not.toContain('unverified');
      expect(plain.all).not.toContain('relation-undeclared-dependency');
    } finally {
      rmSync(declared, { recursive: true, force: true });
    }
  });
});
