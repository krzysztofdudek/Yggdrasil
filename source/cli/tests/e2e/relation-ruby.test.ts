import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// End-to-end: Ruby relation conformance is LIVE — the LAST and honestly
// LOWEST-detectability language. Ruby's ONE file-precise static link is
// `require_relative '<literal>'`; we use it for a real cross-node edge. We build
// a temp repo from scratch, spawn the REAL built binary, and assert:
//   1. an undeclared cross-node require_relative is refused by
//      `yg check --approve` (exit 1, relation-undeclared-dependency);
//   2. declaring the relation clears it under `--approve` (exit 0);
//   3. CRITICAL — a PLAIN `yg check` AFTER `--approve` returns exit 0 / verified
//      (NOT unverified). For a `path:` require_relative hint this proves
//      verify.ts's parse-free re-resolution reconstructs the SAME fingerprint the
//      pass sealed.
//
// Mirrors tests/e2e/relation-csharp.test.ts.
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
 * Build a temp repo with two component nodes a, b under src/, where a/order.rb
 * depends on b across the node boundary via `require_relative '../b/gateway'`.
 * The single `component` type maps `src/**` and allows `uses: [component]`, so the
 * only thing verified is the deterministic relation-conformance pass (no aspects →
 * no LLM needed). `withRelation` controls whether a declares the relation to b.
 */
function buildRepo(label: string, withRelation: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), `yg-rel-ruby-${label}-`));

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

  // Node b — the dependency target.
  writeFile(
    root,
    '.yggdrasil/model/b/yg-node.yaml',
    'name: B\ndescription: Dependency target component.\ntype: component\nmapping:\n  - src/b\n',
  );
  // Node a — require_relatives b's file across the boundary. With/without the relation.
  const aNode = withRelation
    ? 'name: A\ndescription: Requiring component.\ntype: component\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/a\n'
    : 'name: A\ndescription: Requiring component.\ntype: component\nmapping:\n  - src/a\n';
  writeFile(root, '.yggdrasil/model/a/yg-node.yaml', aNode);

  // Source — a/order.rb depends on b/gateway.rb by a require_relative path. The ruby
  // branch of makeResolvePathToFile maps '../b/gateway' → src/b/gateway.rb.
  writeFile(
    root,
    'src/a/order.rb',
    ["require_relative '../b/gateway'", 'class Order', '  def pay', '    Gateway.charge', '  end', 'end', ''].join('\n'),
  );
  writeFile(root, 'src/b/gateway.rb', ['class Gateway', '  def self.charge; end', 'end', ''].join('\n'));

  return root;
}

describe.skipIf(!distExists)('CLI E2E — Ruby relation conformance (live, require_relative)', () => {
  it('refuses an undeclared cross-node require_relative, then passes once the relation is declared', () => {
    // 1. No declared relation → the cross-node require_relative is refused.
    const undeclared = buildRepo('undeclared', false);
    try {
      const refused = run(['check', '--approve'], undeclared);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('relation-undeclared-dependency');
      expect(refused.all).toContain('b');
      expect(refused.all).toContain('src/a/order.rb');
    } finally {
      rmSync(undeclared, { recursive: true, force: true });
    }

    // 2. With the relation declared (a --uses--> b) → check --approve passes.
    const declared = buildRepo('declared', true);
    try {
      const ok = run(['check', '--approve'], declared);
      expect(ok.status, ok.all).toBe(0);
      expect(ok.all).not.toContain('relation-undeclared-dependency');

      // 3. CRITICAL round-trip: a PLAIN `yg check` (no --approve) after the seal must
      //    stay GREEN — the path verdict re-validates parse-free to the SAME fingerprint.
      const plain = run(['check'], declared);
      expect(plain.status, plain.all).toBe(0);
      expect(plain.all).not.toContain('unverified');
      expect(plain.all).not.toContain('relation-undeclared-dependency');
    } finally {
      rmSync(declared, { recursive: true, force: true });
    }
  });

  it('does NOT flag a bare namespaced constant that shadows a top-level same-name, but DOES flag a ::-rooted cross-node use', () => {
    // Repo: b defines a UNIQUE top-level `Helper`; a uses a BARE `Helper` inside
    // `module App`. Pre-C1 the flat symbol table resolved the bare use to b → false
    // cross-node edge with NO declared relation. Under C1 the bare-in-namespace use is
    // suppressed → no edge → check --approve is GREEN even WITHOUT a declared relation.
    const root = mkdtempSync(path.join(tmpdir(), 'yg-rel-ruby-c1-'));
    try {
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
      // b defines a UNIQUE top-level Helper. No relation declared by a.
      writeFile(root, '.yggdrasil/model/b/yg-node.yaml',
        'name: B\ndescription: Dependency target.\ntype: component\nmapping:\n  - src/b\n');
      writeFile(root, '.yggdrasil/model/a/yg-node.yaml',
        'name: A\ndescription: Requiring component.\ntype: component\nmapping:\n  - src/a\n');
      writeFile(root, 'src/b/helper.rb', ['class Helper', '  def self.run; end', 'end', ''].join('\n'));
      // a uses a BARE Helper INSIDE module App → suppressed by C1 → must NOT flag.
      writeFile(root, 'src/a/order.rb',
        ['module App', '  class Order', '    def go', '      Helper.run', '    end', '  end', 'end', ''].join('\n'));

      const green = run(['check', '--approve'], root);
      expect(green.status, green.all).toBe(0);
      expect(green.all).not.toContain('relation-undeclared-dependency');

      // Positive: change the use to a ::-rooted absolute reference to b's Helper. A
      // complete top-level path is NOT suppressed → the undeclared cross-node edge flags.
      writeFile(root, 'src/a/order.rb',
        ['module App', '  class Order', '    def go', '      ::Helper.run', '    end', '  end', 'end', ''].join('\n'));
      const flagged = run(['check', '--approve'], root);
      expect(flagged.status).toBe(1);
      expect(flagged.all).toContain('relation-undeclared-dependency');
      expect(flagged.all).toContain('src/a/order.rb');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
