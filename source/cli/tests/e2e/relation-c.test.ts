import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// End-to-end: C relation conformance is LIVE. We build a temp project from
// scratch, spawn the REAL built binary, and assert that an undeclared cross-node
// quoted `#include "b/bar.h"` is refused by `yg check --approve` (exit 1), then
// that declaring the relation clears it (exit 0). Mirrors
// tests/e2e/relation-rust.test.ts.
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
 * Build a temp project with two component nodes a, b under src/, where a/foo.c
 * quote-includes node b's header across the node boundary (`#include "../b/bar.h"`).
 * The single `component` type maps `src/**` and allows `uses: [component]`, so the
 * only thing verified is the deterministic relation-conformance pass (no aspects → no
 * LLM needed). `withRelation` controls whether a declares the relation to b.
 */
function buildRepo(label: string, withRelation: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), `yg-rel-c-${label}-`));

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

  // Node b — the dependency target (its header is what a includes).
  writeFile(
    root,
    '.yggdrasil/model/b/yg-node.yaml',
    'name: B\ndescription: Dependency target component.\ntype: component\nmapping:\n  - src/b/*\n',
  );
  // Node a — quote-includes b's header. With/without the declared relation.
  const aNode = withRelation
    ? 'name: A\ndescription: Importing component.\ntype: component\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/a/*\n'
    : 'name: A\ndescription: Importing component.\ntype: component\nmapping:\n  - src/a/*\n';
  writeFile(root, '.yggdrasil/model/a/yg-node.yaml', aNode);

  // Source — a/foo.c quote-includes b/bar.h (resolves relative to src/a → src/b/bar.h).
  writeFile(root, 'src/a/foo.c', '#include "../b/bar.h"\nint foo(void) { return bar(); }\n');
  writeFile(root, 'src/b/bar.h', '#pragma once\nint bar(void);\n');

  return root;
}

/**
 * Build a temp project where a/foo.c quote-includes "cfg.h" with NO sibling cfg.h next
 * to it. A same-basename header exists only at node b (src/b/cfg.h) — reachable ONLY via
 * the dropped ancestor include-root walk. a declares NO relation to b. With the walk gone
 * the include resolves to nothing → no cross-node edge → no violation. (Old behaviour:
 * the walk grabbed src/b/cfg.h and falsely flagged an undeclared a→b dependency.)
 */
function buildDecoyRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-rel-c-decoy-'));
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
  writeFile(root, '.yggdrasil/model/b/yg-node.yaml', 'name: B\ndescription: Dependency target component.\ntype: component\nmapping:\n  - src/b/*\n');
  // Node a declares NO relation to b.
  writeFile(root, '.yggdrasil/model/a/yg-node.yaml', 'name: A\ndescription: Importing component.\ntype: component\nmapping:\n  - src/a/*\n');
  // a/foo.c includes "cfg.h" — NO src/a/cfg.h sibling. The only cfg.h is in node b,
  // reachable solely through the dropped include-root walk.
  writeFile(root, 'src/a/foo.c', '#include "cfg.h"\nint foo(void) { return 0; }\n');
  writeFile(root, 'src/b/cfg.h', '#pragma once\n');
  return root;
}

describe.skipIf(!distExists)('CLI E2E — C relation conformance (live)', () => {
  it('refuses an undeclared cross-node #include, then passes once the relation is declared', () => {
    // 1. No declared relation → the cross-node include is refused.
    const undeclared = buildRepo('undeclared', false);
    try {
      const refused = run(['check', '--approve'], undeclared);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('relation-undeclared-dependency');
      expect(refused.all).toContain('b');
      expect(refused.all).toContain('src/a/foo.c');
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

  it('does not flag an include reachable only via the dropped include-root walk', () => {
    const decoy = buildDecoyRepo();
    try {
      const result = run(['check', '--approve'], decoy);
      // The include resolves to nothing (canonical relative join misses; no walk) → no
      // cross-node edge → no undeclared-dependency violation for the a→b decoy.
      expect(result.all).not.toContain('relation-undeclared-dependency');
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});
