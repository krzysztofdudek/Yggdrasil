import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock } from './support/read-lock.js';

// ---------------------------------------------------------------------------
// End-to-end: TypeScript relation conformance is LIVE. We build a temp repo
// from scratch, spawn the REAL built binary, and assert that an undeclared
// cross-node import is refused by `yg check --approve` (exit 1), then that
// declaring the relation clears it (exit 0). Mirrors the spawn pattern of the
// other tests/e2e/cli-*.test.ts suites.
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
 * Build a temp repo with two component nodes a, b under src/, where a/foo.ts
 * imports b/bar.ts across the node boundary. The single `component` type maps
 * `src/**` and allows `uses: [component]`, so the only thing verified is the
 * deterministic relation-conformance pass (no aspects → no LLM needed).
 * `withRelation` controls whether a declares the `uses` relation to b.
 */
function buildRepo(
  label: string,
  withRelation: boolean,
  fooSource = "import { x } from '../b/bar.js';\nexport const foo = x;\n",
): string {
  const root = mkdtempSync(path.join(tmpdir(), `yg-rel-ts-${label}-`));

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
  // A reviewer tier is required even for a deterministic-only project; it is
  // never invoked here (no aspects → no LLM pairs), only the relation pass runs.
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
  // Node a — imports across the boundary into b. With/without the declared relation.
  const aNode = withRelation
    ? 'name: A\ndescription: Importing component.\ntype: component\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/a\n'
    : 'name: A\ndescription: Importing component.\ntype: component\nmapping:\n  - src/a\n';
  writeFile(root, '.yggdrasil/model/a/yg-node.yaml', aNode);

  // Source — a/foo.ts depends on b/bar.ts (NodeNext '.js' specifier).
  writeFile(root, 'src/a/foo.ts', fooSource);
  writeFile(root, 'src/b/bar.ts', 'export const x = 1;\n');

  return root;
}

describe.skipIf(!distExists)('CLI E2E — TypeScript relation conformance (live)', () => {
  it('refuses an undeclared cross-node import, then passes once the relation is declared', () => {
    // 1. No declared relation → the cross-node import is refused.
    const undeclared = buildRepo('undeclared', false);
    try {
      const refused = run(['check', '--approve'], undeclared);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('relation-undeclared-dependency');
      // The refusal names the dependency target node and the importing file.
      expect(refused.all).toContain('b');
      expect(refused.all).toContain('src/a/foo.ts');

      // Plain `yg check` (no --approve) catches the same undeclared dependency
      // live — relations are computed every run, not read from a cache.
      const plain = run(['check'], undeclared);
      expect(plain.status).toBe(1);
      expect(plain.all).toContain('relation-undeclared-dependency');
    } finally {
      rmSync(undeclared, { recursive: true, force: true });
    }

    // 2. With the relation declared (a --uses--> b) → check passes.
    const declared = buildRepo('declared', true);
    try {
      const ok = run(['check', '--approve'], declared);
      expect(ok.status).toBe(0);
      expect(ok.all).not.toContain('relation-undeclared-dependency');

      // The lock carries no relation cache — relations are live, not stored.
      // The 5.1.0 triad splits the lock across three files; assert no relation
      // cache leaks into ANY of them (committed LLM/log files + the gitignored
      // deterministic file), and that the merged lock is format version 1.
      // Each split file is absent when its section is empty (empty → no file); an
      // absent file trivially carries no relation cache. Read whichever exist.
      const ygg = path.join(declared, '.yggdrasil');
      const readIfExists = (p: string) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');
      expect(readIfExists(path.join(ygg, 'yg-lock.nondeterministic.json'))).not.toContain('relation_verdicts');
      expect(readIfExists(path.join(ygg, 'yg-lock.logs.json'))).not.toContain('relation_verdicts');
      expect(readIfExists(path.join(ygg, '.yg-lock.deterministic.json'))).not.toContain('relation_verdicts');
      expect(readLock(ygg).version).toBe(1);
    } finally {
      rmSync(declared, { recursive: true, force: true });
    }
  });

  it('does NOT refuse an all-inline-type cross-node import (no runtime dependency)', () => {
    // `import { type X } from '../b/bar.js'` erases at compile time — it is not a
    // runtime dependency, so the undeclared-relation check must NOT fire even
    // though node a declares no `uses` relation to b.
    const typeOnly = buildRepo(
      'typeonly',
      false,
      "import { type X } from '../b/bar.js';\nexport type Y = X;\n",
    );
    try {
      const ok = run(['check', '--approve'], typeOnly);
      expect(ok.all).not.toContain('relation-undeclared-dependency');
      expect(ok.status).toBe(0);
    } finally {
      rmSync(typeOnly, { recursive: true, force: true });
    }
  });
});
