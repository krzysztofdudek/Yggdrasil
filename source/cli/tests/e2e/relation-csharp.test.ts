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
// End-to-end: C# relation conformance is LIVE — the HARDEST language and the
// design's poster child for SymbolTable resolution. C# has NO file-level import
// that names a file: `using` names a NAMESPACE (which spans files), so the
// dependency EDGE comes from a SYMBOL USE (here a fully-qualified `new
// MyApp.Payments.Gateway()`) resolved to an FQN and looked up in the shared
// SymbolTable. We build a temp repo from scratch, spawn the REAL built binary,
// and assert:
//   1. an undeclared cross-node type use is refused by `yg check --approve` (exit 1);
//   2. declaring the relation clears it under `--approve` (exit 0);
//   3. CRITICAL — a PLAIN `yg check` AFTER `--approve` returns exit 0 / verified
//      (NOT unverified). This proves verify.ts's parse-free symbol re-validation
//      reconstructs the SAME fingerprint the pass sealed. If this comes back
//      unverified, the symbol re-validation path is broken.
//
// C#'s namespace is decoupled from the directory, so the source dirs (src/a,
// src/b) deliberately do NOT mirror the namespaces (MyApp.*).
// Mirrors tests/e2e/relation-kotlin.test.ts.
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
 * Build a temp repo with two component nodes a, b under src/, where a/Order.cs
 * constructs b's type across the node boundary via a fully-qualified
 * `new MyApp.Payments.Gateway()`. The single `component` type maps `src/**` and
 * allows `uses: [component]`, so the only thing verified is the deterministic
 * relation-conformance pass (no aspects → no LLM needed). Namespaces are decoupled
 * from directories to exercise the SymbolTable. `withRelation` controls whether a
 * declares the relation to b.
 */
function buildRepo(label: string, withRelation: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), `yg-rel-csharp-${label}-`));

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
      'version: "6.0.0"',
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

  // Node b — the dependency target. Directory src/b, namespace MyApp.Payments.
  writeFile(
    root,
    '.yggdrasil/model/b/yg-node.yaml',
    'name: B\ndescription: Dependency target component.\ntype: component\nmapping:\n  - src/b\n',
  );
  // Node a — constructs b's type across the boundary. With/without the declared relation.
  const aNode = withRelation
    ? 'name: A\ndescription: Constructing component.\ntype: component\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/a\n'
    : 'name: A\ndescription: Constructing component.\ntype: component\nmapping:\n  - src/a\n';
  writeFile(root, '.yggdrasil/model/a/yg-node.yaml', aNode);

  // Source — a/Order.cs depends on b/Gateway.cs by a fully-qualified `new`. Note: src
  // dir != namespace. The symbol-table resolution maps MyApp.Payments.Gateway → src/b.
  writeFile(
    root,
    'src/a/Order.cs',
    [
      'namespace MyApp.Orders;',
      'public class Order {',
      '  public void Pay() {',
      '    var gw = new MyApp.Payments.Gateway();',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFile(
    root,
    'src/b/Gateway.cs',
    ['namespace MyApp.Payments;', 'public class Gateway { }', ''].join('\n'),
  );

  return root;
}

describe.skipIf(!distExists)('CLI E2E — C# relation conformance (live, symbol-table)', () => {
  it('refuses an undeclared cross-node type use, then passes once the relation is declared', () => {
    // 1. No declared relation → the cross-node type use is refused.
    const undeclared = buildRepo('undeclared', false);
    try {
      const refused = run(['check', '--approve'], undeclared);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('relation-undeclared-dependency');
      expect(refused.all).toContain('b');
      expect(refused.all).toContain('src/a/Order.cs');
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
