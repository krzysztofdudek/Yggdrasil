/**
 * scripts/grammars.mjs — the build step that turns grammar pins into dist/grammars/.
 * Spawned for real, offline (YG_GRAMMAR_OFFLINE=1) against a temp cache so no network
 * or toolchain is touched: a cache entry is used only when its bytes still hash to the
 * pin, a damaged entry is evicted and never shipped, and a failure writes nothing.
 * Seeds come from dist/grammars/, which the build verified against the pins (and
 * tests/unit/ast/grammar-pins.test.ts re-checks), so a seed named by its own sha256 is
 * exactly the cache entry the pin asks for.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(CLI_ROOT, 'scripts/grammars.mjs');
const DIST = path.join(CLI_ROOT, 'dist/grammars');
const RUST_WASM = 'tree-sitter-rust.wasm';
const RUST_TYPES = 'tree-sitter-rust.node-types.json';
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const rustWasmSha = () => sha256(path.join(DIST, RUST_WASM));

let work: string;
let cache: string;
let out: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'yg-grammar-pipeline-'));
  cache = path.join(work, 'cache');
  out = path.join(work, 'out');
  mkdirSync(cache);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function run(only: string) {
  return spawnSync('node', [SCRIPT, '--only', only, '--out', out], {
    encoding: 'utf-8',
    env: { ...process.env, YG_GRAMMAR_CACHE: cache, YG_GRAMMAR_OFFLINE: '1', YG_GRAMMAR_REBUILD: '' },
  });
}

function seed(which: 'good' | 'damaged') {
  copyFileSync(path.join(DIST, RUST_WASM), path.join(cache, rustWasmSha()));
  copyFileSync(path.join(DIST, RUST_TYPES), path.join(cache, sha256(path.join(DIST, RUST_TYPES))));
  if (which === 'damaged') writeFileSync(path.join(cache, rustWasmSha()), 'not the pinned wasm');
}

describe('scripts/grammars.mjs', () => {
  it('ships a GitHub-release grammar from a verified cache hit, offline', () => {
    seed('good');
    const r = run('rust');
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(path.join(out, RUST_WASM))).toEqual(readFileSync(path.join(DIST, RUST_WASM)));
    expect(existsSync(path.join(out, RUST_TYPES))).toBe(true);
  });

  it('evicts a damaged cache entry and ships nothing instead of the wrong bytes', () => {
    seed('damaged');
    const r = run('rust');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('evicted a damaged cache entry');
    expect(r.stderr).toContain('grammar rust is not in the cache');
    expect(existsSync(path.join(cache, rustWasmSha()))).toBe(false);
    expect(existsSync(path.join(out, RUST_WASM))).toBe(false);
  });

  it('writes nothing when any requested grammar cannot be materialized', () => {
    seed('good');
    const r = run('rust,java');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('grammar java is not in the cache');
    expect(existsSync(out)).toBe(false);
  });

  it('reads an npm-sourced grammar from its devDependency and verifies it without the cache', () => {
    const r = run('go');
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(path.join(out, 'tree-sitter-go.wasm'))).toEqual(readFileSync(path.join(DIST, 'tree-sitter-go.wasm')));
  });

  it('rejects an unknown language id', () => {
    const r = run('cobol');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--only names a language the registry does not have');
  });
});
