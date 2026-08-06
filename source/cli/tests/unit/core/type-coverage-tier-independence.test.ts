/**
 * ambiguous-node-type fires independent of the coverage-root tier a file
 * sits in — design row: "a BLOCKING ERROR at detection... independent of
 * the required/advisory coverage-ROOT tiers." The shared type-coverage-basic/
 * fixture never exercises the MIDDLE tier (neither required nor excluded —
 * partitionByCoverageTier's own middle bucket) for an ambiguous file, since
 * its coverage.required root (src/) covers everything not already excluded.
 * This fixture narrows coverage.required to src/ alone, so docs/ falls in
 * the middle tier, and gives every file in all three tiers the exact same
 * two-type overlap — proving ambiguity's severity does not soften outside
 * the required tier.
 *
 * Driven against the real, committed fixture project
 * tests/fixtures/type-coverage-tier-independence/ — a copy is made per test
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
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-tier-independence');

let tmpDirs: string[] = [];

function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-tier-independence-'));
  cpSync(FIXTURE, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

async function runOnFixture(dir: string): Promise<Awaited<ReturnType<typeof runCheck>>> {
  const graph = await loadGraph(dir);
  const files = await walkRepoFiles(dir);
  return runCheck(graph, files);
}

describe('ambiguous-node-type fires independent of the coverage-root tier', () => {
  it('a REQUIRED-tier ambiguous file blocks', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    const amb = result.issues.filter((i) => i.code === 'ambiguous-node-type');
    expect(amb.some((i) => i.messageData.what.includes('required_amb.ts'))).toBe(true);
    expect(amb.find((i) => i.messageData.what.includes('required_amb.ts'))?.severity).toBe('error');
  });

  it('a MIDDLE-tier (neither required nor excluded) ambiguous file ALSO blocks as an error — the design ruling under test', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    const amb = result.issues.find((i) => i.messageData.what.includes('middle_amb.ts'));
    expect(amb).toBeDefined();
    expect(amb!.code).toBe('ambiguous-node-type');
    // The load-bearing assertion: middle-tier files are ordinarily WARNING
    // (advisory) severity under partitionByCoverageTier. ambiguous-node-type
    // must NOT inherit that softer severity — it is tier-independent, real
    // severity everywhere.
    expect(amb!.severity).toBe('error');
  });

  it('an EXCLUDED-tier file matching both types is muted entirely — excluded-mute wins over ambiguity, consistent with the basic fixture', async () => {
    const dir = copyFixture();
    const result = await runOnFixture(dir);
    const mentions = result.issues.some((i) => i.messageData.what.includes('excluded_amb.ts'));
    expect(mentions).toBe(false);
  });
});
