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
// End-to-end: Rust relation conformance is LIVE. We build a temp crate from
// scratch, spawn the REAL built binary, and assert that an undeclared cross-node
// `use crate::b::Bar;` is refused by `yg check --approve` (exit 1), then that
// declaring the relation clears it (exit 0). Mirrors tests/e2e/relation-go.test.ts.
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
 * Build a temp crate with two component nodes a, b under src/, where a/foo.rs
 * imports module b across the node boundary (`use crate::b::Bar;`). The single
 * `component` type maps `src/**` and allows `uses: [component]`, so the only thing
 * verified is the deterministic relation-conformance pass (no aspects → no LLM
 * needed). A Cargo.toml at the root supplies the crate name / module root.
 * `withRelation` controls whether a declares the relation to b.
 */
function buildRepo(label: string, withRelation: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), `yg-rel-rust-${label}-`));

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

  // Cargo.toml at the repo root → crate `mycrate`, src/ is the module-tree root.
  writeFile(
    root,
    'Cargo.toml',
    '[package]\nname = "mycrate"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  // Crate entry declaring the top-level modules.
  writeFile(root, 'src/lib.rs', 'pub mod a;\npub mod b;\n');

  // Node b — the dependency target module.
  writeFile(
    root,
    '.yggdrasil/model/b/yg-node.yaml',
    'name: B\ndescription: Dependency target component.\ntype: component\nmapping:\n  - src/b.rs\n',
  );
  // Node a — imports across the boundary into b. With/without the declared relation.
  const aNode = withRelation
    ? 'name: A\ndescription: Importing component.\ntype: component\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/a.rs\n'
    : 'name: A\ndescription: Importing component.\ntype: component\nmapping:\n  - src/a.rs\n';
  writeFile(root, '.yggdrasil/model/a/yg-node.yaml', aNode);

  // Source — a.rs imports module b (crate path resolves via the module tree to src/b.rs).
  writeFile(root, 'src/a.rs', 'use crate::b::Bar;\npub fn foo() -> u32 { Bar }\n');
  writeFile(root, 'src/b.rs', 'pub const Bar: u32 = 1;\n');

  return root;
}

describe.skipIf(!distExists)('CLI E2E — Rust relation conformance (live)', () => {
  it('refuses an undeclared cross-node import, then passes once the relation is declared', () => {
    // 1. No declared relation → the cross-node import is refused.
    const undeclared = buildRepo('undeclared', false);
    try {
      const refused = run(['check', '--approve'], undeclared);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('relation-undeclared-dependency');
      expect(refused.all).toContain('b');
      expect(refused.all).toContain('src/a.rs');
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
