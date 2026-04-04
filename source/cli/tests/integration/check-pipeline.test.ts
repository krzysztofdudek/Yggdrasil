import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { runCheck } from '../../src/core/check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../fixtures/sample-project');

describe('check-pipeline', () => {
  it('load fixture graph → runCheck → returns structured result', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // Pass null for gitTrackedFiles (fixtures aren't git repos)
    const result = await runCheck(graph, null);

    expect(result.nodeCount).toBeGreaterThan(0);
    expect(result.issues).toBeDefined();
    expect(result.suggestedNext === null || typeof result.suggestedNext === 'string').toBe(true);
  });

  it('runCheck returns all required CheckResult fields', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const result = await runCheck(graph, null);

    expect(result.projectName).toBeDefined();
    expect(typeof result.nodeCount).toBe('number');
    expect(result.nodeTypeCounts).toBeInstanceOf(Map);
    expect(typeof result.aspectCount).toBe('number');
    expect(typeof result.flowCount).toBe('number');
    expect(typeof result.coveredFiles).toBe('number');
    expect(typeof result.totalFiles).toBe('number');
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it('all issues have required code field', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const result = await runCheck(graph, null);

    for (const issue of result.issues) {
      expect(issue.code).toBeDefined();
      expect(issue.code.length).toBeGreaterThan(0);
    }
  });
});
