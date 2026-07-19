import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Child-precedence must hold in the RELATION-conformance pass too: a file a child
// node claims inside a parent's glob is owned by the CHILD, so ITS outgoing
// dependencies are checked against the CHILD's declared relations — not the
// parent's. The parent (which enumerates the file first in graph insertion order)
// must NOT be blamed for a dependency the child correctly declared.
//
// Real on-disk fixture graph — no internal imports, no mocks. Driven only through
// the built bin.js and asserted against `yg check`.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: result.status, all: (result.stdout ?? '') + (result.stderr ?? '') };
}

const ARCHITECTURE = [
  'node_types:',
  '  module:',
  "    description: 'A rootable grouping'",
  '  code:',
  "    description: 'A code unit'",
  '    log_required: false',
  '    when:',
  '      path: "src/**/*.ts"',
  '    parents: [module, code]',
  '    relations:',
  '      calls: [code]',
  '',
].join('\n');

const CONFIG = [
  'quality:',
  '  max_direct_relations: 10',
  'reviewer:',
  '  tiers:',
  '    standard:',
  '      provider: ollama',
  '      consensus: 1',
  '      config:',
  '        model: test',
  '        endpoint: http://127.0.0.1:11434',
  '',
].join('\n');

/**
 * Parent `app` globs the src tree. Child `app/special` claims one file inside it,
 * and that file depends on a third node `lib`. Only the child declares the
 * relation to `lib`; the parent declares nothing.
 */
function scaffold(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-childprec-rel-'));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'aspects'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });
  writeFileSync(path.join(ygRoot, 'yg-architecture.yaml'), ARCHITECTURE, 'utf-8');
  writeFileSync(path.join(ygRoot, 'yg-config.yaml'), CONFIG, 'utf-8');

  const writeNode = (nodePath: string, yaml: string): void => {
    const nodeDir = path.join(ygRoot, 'model', ...nodePath.split('/'));
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(path.join(nodeDir, 'yg-node.yaml'), yaml, 'utf-8');
  };
  const writeSource = (relPath: string, body: string): void => {
    const abs = path.join(dir, ...relPath.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  };

  // Parent globs the directory; child claims the specific file inside it and
  // declares the relation its file actually needs.
  // `app` globs only its own subtree (src/app/**) so it does not overlap the
  // sibling `lib`; the child claims one file inside app's subtree.
  writeNode('app', ['name: App', 'type: code', "description: 'App — globs its subtree'", 'mapping:', '  - "src/app/**/*.ts"', ''].join('\n'));
  writeNode(
    'app/special',
    [
      'name: Special',
      'type: code',
      "description: 'Owns one special-case file that depends on lib'",
      'mapping:',
      '  - src/app/special/thing.ts',
      'relations:',
      '  - target: lib',
      '    type: calls',
      '',
    ].join('\n'),
  );
  writeNode('lib', ['name: Lib', 'type: code', "description: 'A dependency target'", 'mapping:', '  - src/lib.ts', ''].join('\n'));

  writeSource('src/app/main.ts', 'export const main = 1;\n');
  writeSource('src/lib.ts', 'export const lib = 1;\n');
  // The child-owned file imports lib — a real, statically resolvable cross-node dep.
  writeSource('src/app/special/thing.ts', "import { lib } from '../../lib';\nexport const thing = lib + 1;\n");
  return dir;
}

describe.skipIf(!distExists)('child-precedence in the relation-conformance pass (E2E via bin.js)', () => {
  it("attributes a child-owned file's dependency to the CHILD, so the parent is not falsely refused", () => {
    const dir = scaffold();
    try {
      const check = run(['check', '--no-approve'], dir);
      // Child owns thing.ts (child-precedence) and declares calls:lib, so the
      // dependency is satisfied. If the pass attributed thing.ts to the parent
      // (graph insertion order), the parent — which declares nothing — would be
      // refused with relation-undeclared-dependency, a false positive.
      expect(check.all).not.toContain('relation-undeclared-dependency');
      expect(check.all).not.toMatch(/undeclared dependency on lib/);
      expect(check.all).toContain('yg check: PASS');
      expect(check.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
