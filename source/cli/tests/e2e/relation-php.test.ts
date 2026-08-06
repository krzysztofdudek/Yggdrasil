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
// End-to-end: PHP relation conformance is LIVE. We build a temp repo from
// scratch, spawn the REAL built binary, and assert that an undeclared
// cross-node `use` import is refused by `yg check --approve` (exit 1), then that
// declaring the relation clears it (exit 0). Mirrors tests/e2e/relation-java.test.ts.
//
// PSR-4 (composer.json): App\ → src/. Node `a` lives in App\A, node `b` in App\B.
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
 * Build a temp repo with two component nodes a, b under src/, where a/Foo.php imports
 * b/Bar.php across the node boundary (`use App\B\Bar;`). A composer.json PSR-4 map
 * (`App\` → `src/`) makes the FQNs resolvable to files. The single `component` type
 * maps `src/**` and allows `uses: [component]`, so the only thing verified is the
 * deterministic relation-conformance pass (no aspects → no LLM needed). `withRelation`
 * controls whether a declares the relation to b.
 */
function buildRepo(label: string, withRelation: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), `yg-rel-php-${label}-`));

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

  // composer.json PSR-4 map: App\ → src/. The namespace→path source of truth.
  writeFile(
    root,
    'composer.json',
    JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }, null, 2) + '\n',
  );

  // Node b — the dependency target.
  writeFile(
    root,
    '.yggdrasil/model/b/yg-node.yaml',
    'name: B\ndescription: Dependency target component.\ntype: component\nmapping:\n  - src/B\n',
  );
  // Node a — imports across the boundary into b. With/without the declared relation.
  const aNode = withRelation
    ? 'name: A\ndescription: Importing component.\ntype: component\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/A\n'
    : 'name: A\ndescription: Importing component.\ntype: component\nmapping:\n  - src/A\n';
  writeFile(root, '.yggdrasil/model/a/yg-node.yaml', aNode);

  // Source — a/Foo.php depends on b/Bar.php (FQN use import, PSR-4 App\ → src/).
  writeFile(
    root,
    'src/A/Foo.php',
    '<?php\nnamespace App\\A;\nuse App\\B\\Bar;\nclass Foo {\n  public ?Bar $bar = null;\n}\n',
  );
  writeFile(
    root,
    'src/B/Bar.php',
    '<?php\nnamespace App\\B;\nclass Bar {}\n',
  );

  return root;
}

describe.skipIf(!distExists)('CLI E2E — PHP relation conformance (live)', () => {
  it('refuses an undeclared cross-node import, then passes once the relation is declared', () => {
    // 1. No declared relation → the cross-node import is refused.
    const undeclared = buildRepo('undeclared', false);
    try {
      const refused = run(['check', '--approve'], undeclared);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('relation-undeclared-dependency');
      expect(refused.all).toContain('b');
      expect(refused.all).toContain('src/A/Foo.php');
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

  it('still flags a grouped class import (`use App\\B\\{Bar, Baz};`) across an undeclared boundary', () => {
    // Anti-over-silencing: the per-clause function/const guard must NOT suppress
    // ordinary class clauses. A grouped class import that crosses the a→b node
    // boundary with NO declared relation must still be refused, with BOTH classes
    // contributing edges into b.
    const root = mkdtempSync(path.join(tmpdir(), 'yg-rel-php-group-'));
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
      writeFile(
        root,
        'composer.json',
        JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }, null, 2) + '\n',
      );
      // Node a has NO declared relation to b.
      writeFile(
        root,
        '.yggdrasil/model/b/yg-node.yaml',
        'name: B\ndescription: Dependency target component.\ntype: component\nmapping:\n  - src/B\n',
      );
      writeFile(
        root,
        '.yggdrasil/model/a/yg-node.yaml',
        'name: A\ndescription: Importing component.\ntype: component\nmapping:\n  - src/A\n',
      );
      // Grouped class import — BOTH Bar and Baz cross the boundary into b.
      writeFile(
        root,
        'src/A/Foo.php',
        '<?php\nnamespace App\\A;\nuse App\\B\\{Bar, Baz};\nclass Foo {\n  public ?Bar $bar = null;\n  public ?Baz $baz = null;\n}\n',
      );
      writeFile(root, 'src/B/Bar.php', '<?php\nnamespace App\\B;\nclass Bar {}\n');
      writeFile(root, 'src/B/Baz.php', '<?php\nnamespace App\\B;\nclass Baz {}\n');

      const refused = run(['check', '--approve'], root);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('relation-undeclared-dependency');
      expect(refused.all).toContain('src/A/Foo.php');
      expect(refused.all).toContain('b');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
