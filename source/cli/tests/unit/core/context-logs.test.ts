// The logs `yg context` puts in front of an agent: the decisions in force for
// the subject's type and the types above it, and the component's own log —
// whole, or only its newest entries in force on a `log_required` type — with a
// log that cannot be read reported instead of given. Exercised in process on
// the real loader over the lifecycle fixture (a `service` type under the
// parent-only `module` type), so each branch of the reader is measured, not
// only reached through the spawned binary.

import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { appendTypeLogEntry } from '../../../src/core/log/type-log.js';
import { collectContextLogs } from '../../../src/core/log/context-logs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'e2e-lifecycle');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-context-logs-'));
  dirs.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function stamp(i: number): string {
  return new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * 1000).toISOString();
}

/** A node log of `count` entries, the entry at `supersededIndex` (if any) replaced by the last one. */
function nodeLog(count: number, supersededIndex?: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const supersedes = i === count - 1 && supersededIndex !== undefined ? `### Supersedes: ${stamp(supersededIndex)}\n` : '';
    parts.push(`## [${stamp(i)}]\n${supersedes}Entry number ${i}.\n`);
  }
  return parts.join('');
}

function writeNodeLog(dir: string, nodePath: string, content: string): void {
  const logDir = path.join(dir, '.yggdrasil', 'model', nodePath);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, 'log.md'), content, 'utf-8');
}

describe('collectContextLogs', () => {
  it('gives a type-governed file its type decisions with the parent chain, an unreadable one reported, and no node log', async () => {
    const dir = project();
    const graph = await loadGraph(dir);
    const r = await appendTypeLogEntry({ graph, typeId: 'service', reasonText: 'Services call each other over the queue.', nowMs: Date.parse(stamp(1)), adds: true });
    expect(r.ok).toBe(true);
    mkdirSync(path.join(dir, '.yggdrasil', 'types', 'module'), { recursive: true });
    writeFileSync(path.join(dir, '.yggdrasil', 'types', 'module', 'log.md'), 'not a log\n', 'utf-8');

    const logs = await collectContextLogs(graph, { typeId: 'service' });
    expect(logs.nodeLog).toBeUndefined();
    expect(logs.typeDecisions.map((d) => d.typeId)).toEqual(['service', 'module']);
    expect(logs.typeDecisions[0].logPath).toBe('.yggdrasil/types/service/log.md');
    expect(logs.typeDecisions[0].entries).toHaveLength(1);
    expect(logs.typeDecisions[0].unreadable).toBeUndefined();
    expect(logs.typeDecisions[1].unreadable).toBeDefined();
  });

  it('gives nothing for a node path the graph does not hold', async () => {
    const graph = await loadGraph(project());
    expect(await collectContextLogs(graph, { nodePath: 'services/nowhere' })).toEqual({ typeDecisions: [] });
  });

  it('gives no node log for a component without one', async () => {
    const graph = await loadGraph(project());
    const logs = await collectContextLogs(graph, { nodePath: 'services/orders' });
    expect(logs).toEqual({ typeDecisions: [] });
  });

  it('gives a component its whole log in force, leaving out a replaced entry', async () => {
    const dir = project();
    writeNodeLog(dir, 'services/orders', nodeLog(12, 3));
    const graph = await loadGraph(dir);
    const logs = await collectContextLogs(graph, { nodePath: 'services/orders' });
    expect(logs.nodeLog?.nodePath).toBe('services/orders');
    expect(logs.nodeLog?.logPath).toBe('.yggdrasil/model/services/orders/log.md');
    expect(logs.nodeLog?.trimmed).toBe(false);
    expect(logs.nodeLog?.entries).toHaveLength(11);
    expect(logs.nodeLog?.entries.map((e) => e.datetime)).not.toContain(stamp(3));
    expect(logs.nodeLog?.omitted).toBe(0);
    expect(logs.nodeLog?.unreadable).toBeUndefined();
  });

  it('gives only the newest entries in force on a log_required type, counting the rest', async () => {
    const dir = project();
    writeNodeLog(dir, 'services/orders', nodeLog(13));
    const graph = await loadGraph(dir);
    graph.architecture.node_types.service.log_required = true;
    const logs = await collectContextLogs(graph, { nodePath: 'services/orders' });
    expect(logs.nodeLog?.trimmed).toBe(true);
    expect(logs.nodeLog?.entries.map((e) => e.datetime)).toEqual(Array.from({ length: 10 }, (_, i) => stamp(i + 3)));
    expect(logs.nodeLog?.omitted).toBe(3);
  });

  it('reports a node log left with conflict markers, pointing at merge-resolve', async () => {
    const dir = project();
    writeNodeLog(dir, 'services/orders', `## [${stamp(0)}]\n<<<<<<< HEAD\nOurs.\n=======\nTheirs.\n>>>>>>> other\n`);
    const graph = await loadGraph(dir);
    const logs = await collectContextLogs(graph, { nodePath: 'services/orders' });
    expect(logs.nodeLog?.entries).toEqual([]);
    expect(logs.nodeLog?.omitted).toBe(0);
    expect(logs.nodeLog?.unreadable?.next).toBe('yg log merge-resolve --node services/orders');
  });

  it('reports a node log that does not parse, naming the file to repair', async () => {
    const dir = project();
    writeNodeLog(dir, 'services/orders', 'no heading here\n');
    const graph = await loadGraph(dir);
    const logs = await collectContextLogs(graph, { nodePath: 'services/orders' });
    expect(logs.nodeLog?.entries).toEqual([]);
    expect(logs.nodeLog?.unreadable?.next).toContain('.yggdrasil/model/services/orders/log.md');
  });
});
