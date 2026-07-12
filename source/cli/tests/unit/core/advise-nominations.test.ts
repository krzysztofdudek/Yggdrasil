import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { buildNominations, type SuppressAnomaly } from '../../../src/core/advise-nominations.js';

// Real on-disk fixture: a copy of the committed sample-project graph, with a
// far-past review_by injected onto one aspect so an overdue nomination is live.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');

const HEX64 = /^[0-9a-f]{64}$/;
const TODAY = new Date('2026-07-12T00:00:00.000Z');

describe('buildNominations — live sources', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(os.tmpdir(), 'yg-advise-noms-'));
    cpSync(FIXTURE, projectRoot, { recursive: true });
    // Give an existing aspect a review_by day that is always in the past.
    appendFileSync(
      path.join(projectRoot, '.yggdrasil', 'aspects', 'requires-logging', 'yg-aspect.yaml'),
      '\nreview_by: 2020-01-01\n',
      'utf-8',
    );
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('turns an overdue review_by into an evidence-bound nomination (deterministic hash)', async () => {
    const graph = await loadGraph(projectRoot);
    const noms = buildNominations(graph, { todayUtc: TODAY });

    const overdue = noms.find((n) => n.id === 'overdue-review-by:requires-logging');
    expect(overdue).toBeDefined();
    expect(overdue!.evidenceHash).toMatch(HEX64);
    expect(overdue!.next).toContain('requires your approval');

    // Same graph + same clock → identical evidence hash (deterministic).
    const again = buildNominations(graph, { todayUtc: TODAY });
    expect(again.find((n) => n.id === 'overdue-review-by:requires-logging')!.evidenceHash).toBe(
      overdue!.evidenceHash,
    );
  });

  it('maps a suppress-marker anomaly to a nomination whose hash tracks its evidence', async () => {
    const graph = await loadGraph(projectRoot);
    const anomaly: SuppressAnomaly = { file: 'src/x.ts', line: 5, aspectId: 'foo', risk: 'wildcard' };

    const noms = buildNominations(graph, { todayUtc: TODAY, suppressAnomalies: [anomaly] });
    const suppress = noms.find((n) => n.id === 'suppress-anomaly:src/x.ts:5');
    expect(suppress).toBeDefined();
    expect(suppress!.evidenceHash).toMatch(HEX64);

    // Evidence changed (risk differs) → the hash no longer matches, so a prior
    // decision would stop applying and the item returns as new.
    const changed = buildNominations(graph, {
      todayUtc: TODAY,
      suppressAnomalies: [{ ...anomaly, risk: 'typo' }],
    });
    expect(changed.find((n) => n.id === 'suppress-anomaly:src/x.ts:5')!.evidenceHash).not.toBe(
      suppress!.evidenceHash,
    );
  });

  it('orders nominations by classRank (structural graph issues before cadence)', async () => {
    const graph = await loadGraph(projectRoot);
    const noms = buildNominations(graph, { todayUtc: TODAY });
    const ranks = noms.map((n) => n.classRank);
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
  });
});
