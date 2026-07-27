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
// End-to-end: Java relation conformance is LIVE. We build a temp repo from
// scratch, spawn the REAL built binary, and assert that an undeclared
// cross-node import is refused by `yg check --approve` (exit 1), then that
// declaring the relation clears it (exit 0). Mirrors tests/e2e/relation-python.test.ts.
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
 * Build a temp repo with two component nodes a, b under src/main/java/, where
 * a/Foo.java imports b/Bar.java across the node boundary
 * (`import com.b.Bar;`). The single `component` type maps `src/**` and allows
 * `uses: [component]`, so the only thing verified is the deterministic
 * relation-conformance pass (no aspects → no LLM needed). `withRelation` controls
 * whether a declares the relation to b.
 */
function buildRepo(label: string, withRelation: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), `yg-rel-java-${label}-`));

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
    'name: B\ndescription: Dependency target component.\ntype: component\nmapping:\n  - src/main/java/com/b\n',
  );
  // Node a — imports across the boundary into b. With/without the declared relation.
  const aNode = withRelation
    ? 'name: A\ndescription: Importing component.\ntype: component\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/main/java/com/a\n'
    : 'name: A\ndescription: Importing component.\ntype: component\nmapping:\n  - src/main/java/com/a\n';
  writeFile(root, '.yggdrasil/model/a/yg-node.yaml', aNode);

  // Source — a/Foo.java depends on b/Bar.java (FQN import, package = directory).
  writeFile(
    root,
    'src/main/java/com/a/Foo.java',
    'package com.a;\nimport com.b.Bar;\npublic class Foo {\n  Bar bar;\n}\n',
  );
  writeFile(
    root,
    'src/main/java/com/b/Bar.java',
    'package com.b;\npublic class Bar {}\n',
  );

  return root;
}

/**
 * Wildcard-import variant. a/Foo.java does `import com.b.*;`. The `com.b` package
 * directory is owned by one or two nodes depending on `split`:
 *   - split=false: a single node b maps src/main/java/com/b → one owner → edge fires.
 *   - split=true : two nodes b1, b2 each map a DISTINCT .java file inside com/b via
 *     a glob, so the package directory's files split across two owners → silence.
 */
function buildWildcardRepo(label: string, split: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), `yg-rel-java-wild-${label}-`));

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

  // Node a — wildcard-imports the com.b package. NO declared relation → any
  // resolved cross-node edge is a violation.
  writeFile(
    root,
    '.yggdrasil/model/a/yg-node.yaml',
    'name: A\ndescription: Importing component.\ntype: component\nmapping:\n  - src/main/java/com/a\n',
  );

  if (split) {
    // Two owners over the com.b directory — each maps ONE file via a glob.
    writeFile(
      root,
      '.yggdrasil/model/b1/yg-node.yaml',
      'name: B1\ndescription: Half of com.b.\ntype: component\nmapping:\n  - src/main/java/com/b/Bar.java\n',
    );
    writeFile(
      root,
      '.yggdrasil/model/b2/yg-node.yaml',
      'name: B2\ndescription: Other half of com.b.\ntype: component\nmapping:\n  - src/main/java/com/b/Baz.java\n',
    );
  } else {
    writeFile(
      root,
      '.yggdrasil/model/b/yg-node.yaml',
      'name: B\ndescription: Dependency target component.\ntype: component\nmapping:\n  - src/main/java/com/b\n',
    );
  }

  writeFile(
    root,
    'src/main/java/com/a/Foo.java',
    'package com.a;\nimport com.b.*;\npublic class Foo {\n  Bar bar;\n  Baz baz;\n}\n',
  );
  writeFile(root, 'src/main/java/com/b/Bar.java', 'package com.b;\npublic class Bar {}\n');
  writeFile(root, 'src/main/java/com/b/Baz.java', 'package com.b;\npublic class Baz {}\n');

  return root;
}

describe.skipIf(!distExists)('CLI E2E — Java relation conformance (live)', () => {
  it('refuses an undeclared cross-node import, then passes once the relation is declared', () => {
    // 1. No declared relation → the cross-node import is refused.
    const undeclared = buildRepo('undeclared', false);
    try {
      const refused = run(['check', '--approve'], undeclared);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('relation-undeclared-dependency');
      expect(refused.all).toContain('b');
      expect(refused.all).toContain('src/main/java/com/a/Foo.java');
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

  it('silences a wildcard import when the target package splits across two owners', () => {
    // com.b directory owned by b1 (Bar.java) and b2 (Baz.java): the wildcard
    // resolves to a SPLIT owner set → no attribution → no violation, even though
    // a declares no relation. Trade recall for zero false positives.
    const split = buildWildcardRepo('split', true);
    try {
      const r = run(['check', '--approve'], split);
      expect(r.status).toBe(0);
      expect(r.all).not.toContain('relation-undeclared-dependency');
    } finally {
      rmSync(split, { recursive: true, force: true });
    }
  });

  it('fires a wildcard import edge when the target package has exactly one owner', () => {
    // com.b directory owned wholly by node b: the wildcard resolves to a single
    // owner → undeclared cross-node edge → refused (a declares no relation).
    const single = buildWildcardRepo('single', false);
    try {
      const r = run(['check', '--approve'], single);
      expect(r.status).toBe(1);
      expect(r.all).toContain('relation-undeclared-dependency');
      expect(r.all).toContain('src/main/java/com/a/Foo.java');
    } finally {
      rmSync(single, { recursive: true, force: true });
    }
  });
});
