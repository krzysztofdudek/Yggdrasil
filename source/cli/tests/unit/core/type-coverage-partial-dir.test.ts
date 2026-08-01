/**
 * A directory with one explicit-node file and one type-covered sibling — the
 * two coverage mechanisms (an explicit node mapping, and the type-level
 * classification lattice) satisfying coverage for different files in the
 * SAME directory, with no cross-contamination between them.
 *
 * Driven against the real, committed fixture project
 * tests/fixtures/type-coverage-partial-dir/ — a copy is made per test
 * (mkdtemp) so nothing here ever mutates the committed fixture.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runCheck } from '../../../src/core/check.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-partial-dir');
const BIN = path.join(CLI_ROOT, 'dist', 'bin.js');

let tmpDirs: string[] = [];

function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-partial-dir-'));
  cpSync(FIXTURE, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe('a partially-owned directory: one explicit-node file, one type-covered sibling', () => {
  it('both satisfy coverage, via DIFFERENT mechanisms, with no cross-contamination', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const files = await walkRepoFiles(dir);
    const result = await runCheck(graph, files);
    expect(result.nodeOwnedFiles).toBe(1);   // handler.ts
    expect(result.typeCoveredCount).toBe(1); // sibling.ts
    expect(result.issues.some((i) => i.messageData?.what?.includes('sibling.ts'))).toBe(false);
  });
});

describe('yg context --file on the type-covered sibling of a directory with an explicit-node file', () => {
  it('names the matched type and reports the file as covered with no rules to enforce — it says nothing about the directory already having an explicit-node sibling', () => {
    const dir = copyFixture();
    const r = spawnSync('node', [BIN, 'context', '--file', 'src/svc/sibling.ts'], { cwd: dir, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Matched type: svc');
    expect(r.stdout).toContain('No rules from this type apply to this file');
    // This surface has no field and no computation for "a sibling file in
    // this same directory already has an explicit node" — pinning the real,
    // current absence rather than assuming a cross-file note that does not
    // exist. A later addition of that note should update this assertion
    // deliberately, not leave it silently green.
    expect(r.stdout).not.toMatch(/handler\.ts|already has an explicit node|other file.*node/i);
  });
});
