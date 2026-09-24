/**
 * scripts/check-install.mjs — repo-check's first step: does node_modules hold
 * what package-lock.json pins? Spawned for real against temporary package trees.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/check-install.mjs');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tree(lockPackages: Record<string, { version: string; optional?: boolean }>, installed: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-check-install-'));
  dirs.push(root);
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' }, ...lockPackages } }));
  for (const [key, version] of Object.entries(installed)) {
    mkdirSync(path.join(root, key), { recursive: true });
    writeFileSync(path.join(root, key, 'package.json'), JSON.stringify({ name: key.split('node_modules/').pop(), version }));
  }
  return root;
}
const run = (root: string) => spawnSync('node', [SCRIPT, root], { encoding: 'utf-8' });

describe('scripts/check-install.mjs', () => {
  it('passes when every locked package is installed at its locked version (a missing optional one is fine)', () => {
    const root = tree(
      { 'node_modules/vitest': { version: '5.0.0' }, 'node_modules/@esbuild/darwin-arm64': { version: '0.28.1', optional: true } },
      { 'node_modules/vitest': '5.0.0' },
    );
    const r = run(root);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('node_modules matches package-lock.json');
  });

  it('fails on a version drift and a missing package, naming each and the npm ci fix', () => {
    const root = tree(
      { 'node_modules/web-tree-sitter': { version: '0.27.0' }, 'node_modules/vitest': { version: '5.0.0' } },
      { 'node_modules/web-tree-sitter': '0.26.12' },
    );
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('web-tree-sitter: installed 0.26.12, lock 0.27.0');
    expect(r.stderr).toContain('vitest: missing (lock: 5.0.0)');
    expect(r.stderr).toContain('npm ci');
  });

  it('fails when there is no package-lock.json', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'yg-check-install-'));
    dirs.push(root);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no package-lock.json');
  });
});
