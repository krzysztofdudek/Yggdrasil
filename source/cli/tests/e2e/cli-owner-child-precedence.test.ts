import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression for the confirmed owner-resolution disagreement: when a DESCENDANT
// node maps a shorter/broader pattern than its ANCESTOR, hierarchy-first
// ownership (which the gate's subject-set uses) attributes the file to the
// descendant — but cli/owner's old length-first selection picked the ancestor,
// so `yg owner` / `yg context --file` / `yg impact --file` all named the wrong
// node while the file was actually verified under the descendant's rules.
//
// This locks all four surfaces to the SAME owner (the descendant). It is the
// backstop the boundary aspect (which only guards the comparator) cannot give.
//
// Real on-disk fixture, driven only through the built bin.js.

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
 * Ancestor `app` maps a LONG directory (src/app/feature/deep/). Descendant
 * `app/child` maps a SHORTER, broader glob (src/**\/*.ts) that also covers the
 * one file. Hierarchy-first ownership carves the file out to the descendant;
 * a length-first resolver would wrongly keep it on the ancestor's longer dir.
 */
function scaffold(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-owner-childprec-'));
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

  writeNode(
    'app',
    ['name: App', 'type: code', "description: 'App — maps a deep directory'", 'mapping:', '  - src/app/feature/deep/', ''].join('\n'),
  );
  writeNode(
    'app/child',
    ['name: Child', 'type: code', "description: 'Child — globs the whole src tree'", 'mapping:', '  - "src/**/*.ts"', ''].join('\n'),
  );

  writeSource('src/app/feature/deep/thing.ts', 'export const thing = 1;\n');
  return dir;
}

describe.skipIf(!distExists)('cli/owner child-precedence (E2E via bin.js)', () => {
  it('names the DESCENDANT for a file it globs inside an ancestor directory — owner, context, impact, and subject-set all agree', () => {
    const dir = scaffold();
    const file = 'src/app/feature/deep/thing.ts';
    try {
      const owner = run(['owner', '--file', file], dir);
      const contextFile = run(['context', '--file', file], dir);
      const impactFile = run(['impact', '--file', file], dir);
      const contextChild = run(['context', '--node', 'app/child'], dir);
      const contextAncestor = run(['context', '--node', 'app'], dir);

      // yg owner --file → the descendant (child-precedence), not the ancestor.
      expect(owner.all).toContain(`${file} -> app/child`);

      // yg context --file → the descendant owns it.
      expect(contextFile.all).toContain(`${file} -> app/child`);
      expect(contextFile.all).toContain('Owner: app/child');

      // yg impact --file → blast radius rooted at the descendant.
      expect(impactFile.all).toContain('Impact of changes in app/child');

      // None of the three surfaces should resolve the file to the ancestor.
      expect(owner.all).not.toMatch(/-> app$/m);
      expect(contextFile.all).not.toContain('Owner: app (');

      // The subject-set the gate verifies must agree: app/child owns the file,
      // the ancestor owns zero files (the file is carved out to the descendant).
      expect(contextChild.all).toContain(file);
      expect(contextChild.all).toMatch(/Source files \(1\)/);
      expect(contextAncestor.all).not.toContain(file);
      expect(contextAncestor.all).toMatch(/Source files \(0\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
