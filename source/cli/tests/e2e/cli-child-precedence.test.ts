import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Hermetic E2E — CHILD-PRECEDENCE ("child wins") ownership through the public CLI.
//
// The pattern under test is the maintainer's "special case in a globbed
// directory": a parent node globs a directory (src/**/*.ts) and a child node
// claims one specific file inside it (src/special/thing.ts). The child (the
// deeper node) must own that file IMPLICITLY — the parent's glob does not
// co-own it — with no overlap error and no explicit restructuring.
//
// Everything is driven ONLY through the spawned binary (dist/bin.js) against a
// real on-disk fixture graph — no internal imports, no mocks. Every assertion is
// a fact a user would observe: `yg check` is green with no overlapping-mapping;
// `yg owner` names the child for the special file; `yg context --node` shows the
// special file carved OUT of the parent's source set and INTO the child's.
//
// Determinism: no network, no clock, no randomness. The fixture is authored
// inside a per-test mkdtemp and removed in a finally block; committed fixtures
// are never touched.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
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

/** Parent node globs the whole src tree; child node claims one specific file inside it. */
function scaffold(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-childprec-'));
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

  // Parent globs the directory; child claims the specific file inside it.
  writeNode('app', ['name: App', 'type: code', "description: 'App — globs the src tree'", 'mapping:', '  - "src/**/*.ts"', ''].join('\n'));
  writeNode('app/special', ['name: Special', 'type: code', "description: 'Owns one special-case file'", 'mapping:', '  - src/special/thing.ts', ''].join('\n'));

  writeSource('src/main.ts', 'export const main = 1;\n');
  writeSource('src/special/thing.ts', 'export const thing = 2;\n');
  return dir;
}

describe.skipIf(!distExists)('child-precedence ownership (E2E via bin.js)', () => {
  it('a child claiming a specific file inside a parent glob wins, with a green check and no overlap', () => {
    const dir = scaffold();
    try {
      const check = run(['check', '--no-approve'], dir);
      // Green: child-precedence carves the special file out of the parent, so the
      // two mappings are not a double-owned overlap.
      expect(check.status).toBe(0);
      expect(check.all).toContain('yg check: PASS');
      expect(check.all).not.toContain('overlapping-mapping');
      expect(check.all).not.toContain('file-duplicate-mapping');

      // The special file is owned by the CHILD, not the parent glob.
      const owner = run(['owner', '--file', 'src/special/thing.ts'], dir);
      expect(owner.status).toBe(0);
      expect(owner.all).toContain('app/special');
      expect(owner.all).not.toMatch(/->\s*app\s*$/m);

      // The generic file stays with the parent.
      const ownerMain = run(['owner', '--file', 'src/main.ts'], dir);
      expect(ownerMain.all).toContain('app');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the special file is carved OUT of the parent node and INTO the child node', () => {
    const dir = scaffold();
    try {
      const parent = run(['context', '--node', 'app'], dir);
      expect(parent.status).toBe(0);
      // Parent owns the generic file but NOT the child-claimed special file.
      expect(parent.all).toContain('src/main.ts');
      expect(parent.all).not.toContain('src/special/thing.ts');

      const child = run(['context', '--node', 'app/special'], dir);
      expect(child.status).toBe(0);
      expect(child.all).toContain('src/special/thing.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
