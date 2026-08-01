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

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runCheck } from '../../../src/core/check.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-partial-dir');

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
