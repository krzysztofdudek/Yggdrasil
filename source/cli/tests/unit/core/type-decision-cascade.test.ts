// The reader `yg context` uses to put area decisions in front of an agent: the
// decisions in force for a type AND for every type above it on its parent
// chain, nearest first. Exercised on the real loader over the lifecycle
// fixture, whose `service` type sits under the parent-only `module` type.

import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { appendTypeLogEntry, typeDecisionCascade } from '../../../src/core/log/type-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'e2e-lifecycle');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-type-cascade-'));
  dirs.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe('typeDecisionCascade', () => {
  it('returns the in-force decisions of the type and of its parent chain, nearest first', async () => {
    const dir = project();
    const graph = await loadGraph(dir);
    let now = Date.parse('2026-09-01T00:00:00.000Z');
    const add = async (typeId: string, reasonText: string, supersedes?: string[]): Promise<string> => {
      const r = await appendTypeLogEntry({ graph, typeId, reasonText, nowMs: (now += 1000), supersedes });
      if (!r.ok) throw new Error(r.error.what);
      return r.datetime;
    };
    await add('module', 'Modules never import each other directly.');
    const replaced = await add('service', 'Services call each other over HTTP.');
    await add('service', 'Services call each other over the queue.', [replaced]);

    const cascade = await typeDecisionCascade(graph, 'service');
    expect(cascade.map((c) => c.typeId)).toEqual(['service', 'module']);
    expect(cascade[0].entries.map((e) => e.datetime)).not.toContain(replaced);
    expect(cascade[0].entries).toHaveLength(1);
    expect(cascade[1].entries).toHaveLength(1);
  });

  it('leaves out a type with nothing in force, reports an unreadable log, and knows no unknown type', async () => {
    const dir = project();
    const graph = await loadGraph(dir);
    mkdirSync(path.join(dir, '.yggdrasil', 'types', 'module'), { recursive: true });
    writeFileSync(path.join(dir, '.yggdrasil', 'types', 'module', 'log.md'), 'not a log\n', 'utf-8');

    const cascade = await typeDecisionCascade(graph, 'service');
    expect(cascade).toHaveLength(1);
    expect(cascade[0].typeId).toBe('module');
    expect(cascade[0].unreadable).toBeDefined();
    expect(await typeDecisionCascade(graph, 'constructor')).toEqual([]);
  });
});
