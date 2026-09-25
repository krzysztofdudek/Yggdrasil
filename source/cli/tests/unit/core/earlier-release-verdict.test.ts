/**
 * A script verdict an earlier release recorded — before the deterministic
 * canonical form carried its contract marker, or under the parser grammar that
 * read the code then — no longer matches its key although nothing the check
 * reads has changed. The report names that cause (`keyed-by-earlier-release`)
 * and the free command that re-records it, never "a source edit, an aspect
 * edit, or a changed reference" and never the paid `--approve`. A verdict whose
 * inputs did move stays `stale`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';
import { nodeUnit } from '../../../src/model/lock.js';
import { runCheck } from '../../../src/core/check.js';
import { writeSeededLock } from '../helpers/seed-lock.js';
import { formatOutput } from '../../../src/cli/check-render-views.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-earlier-release-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): void {
  const abs = path.join(tmpDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function buildGraph(): Graph {
  const rootPath = path.join(tmpDir, '.yggdrasil');
  mkdirSync(rootPath, { recursive: true });
  const aspect: AspectDef = {
    id: 'no-todo', name: 'no-todo', reviewer: { type: 'deterministic' }, status: 'enforced',
    artifacts: [{ filename: 'check.mjs', content: 'export function check() { return []; }\n' }],
  } as AspectDef;
  const node: GraphNode = {
    path: 'svc',
    meta: { name: 'svc', type: 'service', aspects: ['no-todo'], mapping: ['src/a.ts'] },
    children: [], parent: null,
  } as GraphNode;
  return {
    config: { version: '6.0.0' },
    architecture: { node_types: { service: { description: 'test' } } },
    nodes: new Map([['svc', node]]),
    aspects: [aspect],
    flows: [], schemas: [], rootPath,
  } as unknown as Graph;
}

async function checkWith(spec: { contract?: number | null; touched?: Array<[string, string]> }, edit = false) {
  writeFile('src/a.ts', 'export const a = 1;\n');
  const graph = buildGraph();
  await writeSeededLock(graph, { verdicts: [{ aspectId: 'no-todo', unitKey: nodeUnit('svc'), ...spec }] });
  if (edit) writeFile('src/a.ts', 'export const a = 2;\n');
  const result = await runCheck(graph, ['src/a.ts']);
  return { result, issue: result.issues.find((i) => i.code === 'unverified') };
}

describe('a script verdict keyed by an earlier release', () => {
  it('holds when it was keyed by this release', async () => {
    const { issue } = await checkWith({});
    expect(issue).toBeUndefined();
  });

  it('recorded before the contract marker: named as the upgrade, fixed by the free lane', async () => {
    const { result, issue } = await checkWith({ contract: null });
    expect(issue?.unverifiedCause).toBe('keyed-by-earlier-release');
    expect(issue?.messageData.why).not.toContain('a source edit');
    expect(issue?.messageData.next).toBe('yg check --approve --only-deterministic');
    const out = formatOutput(result, { kind: 'full' }, false, false);
    expect(out).toContain('error[unverified] 1 pair whose script verdicts an earlier Yggdrasil release keyed — nothing changed; free to re-record');
    expect(out).toContain('  fix:  yg check --approve --only-deterministic  (1 script pair · free)');
  });

  it('recorded under an earlier grammar: the same cause', async () => {
    // A grammar observation whose stored digest is not the one this build ships.
    const { issue } = await checkWith({ touched: [['grammar:typescript', 'sha256:an-earlier-grammar']] });
    expect(issue?.unverifiedCause).toBe('keyed-by-earlier-release');
  });

  it('a verdict whose inputs moved is stale, as before', async () => {
    const { issue } = await checkWith({ contract: null }, true);
    expect(issue?.unverifiedCause).toBe('stale');
  });
});
