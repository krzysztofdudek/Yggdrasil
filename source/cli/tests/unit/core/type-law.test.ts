// Law on a node type below the CLI: which types a rule reaches and at what
// status, the version an admission names, the ratification line written and
// read back, the finding and its severity, and the one-time record of the law
// a graph already had. Exercised on the real loader over the lifecycle fixture.

import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, linkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../../src/core/graph-loader.js';
import {
  findUnratifiedTypeLaw,
  grandfatherTypeLaw,
  parseRatification,
  ratificationLine,
  ruleVersion,
  typeLawReach,
} from '../../../src/core/log/type-law.js';
import { appendAspectLogEntry, readAspectLog } from '../../../src/core/log/aspect-log.js';
import { classifyTypeLaw } from '../../../src/core/check-type-law.js';
import type { Graph } from '../../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'e2e-lifecycle');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-type-law-'));
  dirs.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const aspect = (graph: Graph, id: string) => graph.aspects.find((a) => a.id === id)!;
const NOW = Date.parse('2026-09-27T12:00:00.000Z');

describe('type law — reach', () => {
  it('reads each rule a type lists at the status the cascade gives it there', async () => {
    const graph = await loadGraph(project());
    const reach = typeLawReach(graph);
    expect(reach.get('no-todo-comments')).toEqual(new Map([['service', 'enforced']]));
    expect(reach.get('requires-named-export')).toEqual(new Map([['service', 'advisory']]));
    expect(reach.has('wip-rule')).toBe(false);
  });

  it('an attachment on the type raises the status, and an implied rule reaches the type too', async () => {
    const dir = project();
    const arch = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
    writeFileSync(arch, readFileSync(arch, 'utf-8').replace('      - requires-named-export', '      - id: requires-named-export\n        status: enforced'), 'utf-8');
    const implier = path.join(dir, '.yggdrasil', 'aspects', 'requires-named-export', 'yg-aspect.yaml');
    appendFileSync(implier, 'implies:\n  - id: wip-rule\n    status_inherit: own-default\n', 'utf-8');
    const graph = await loadGraph(dir);
    const reach = typeLawReach(graph);
    expect(reach.get('requires-named-export')?.get('service')).toBe('enforced');
    // own-default: the implied rule stands at its own default, draft.
    expect(reach.get('wip-rule')?.get('service')).toBe('draft');
  });

  it('a draft implier implies nothing', async () => {
    const dir = project();
    appendFileSync(path.join(dir, '.yggdrasil', 'aspects', 'wip-rule', 'yg-aspect.yaml'), 'implies:\n  - no-todo-comments\n', 'utf-8');
    const arch = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
    writeFileSync(arch, readFileSync(arch, 'utf-8').replace(/ {6}- no-todo-comments\n/, '      - wip-rule\n'), 'utf-8');
    const graph = await loadGraph(dir);
    expect(typeLawReach(graph).has('no-todo-comments')).toBe(false);
  });
});

describe('type law — version and the ratification line', () => {
  it('the version ignores status and follows what the rule demands', async () => {
    const dir = project();
    const before = ruleVersion(aspect(await loadGraph(dir), 'no-todo-comments'));
    expect(before).toMatch(/^[0-9a-f]{16}$/);
    const file = path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'yg-aspect.yaml');
    writeFileSync(file, readFileSync(file, 'utf-8').replace('status: enforced', 'status: advisory'), 'utf-8');
    expect(ruleVersion(aspect(await loadGraph(dir), 'no-todo-comments'))).toBe(before);
    appendFileSync(path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs'), '\n// changed\n', 'utf-8');
    expect(ruleVersion(aspect(await loadGraph(dir), 'no-todo-comments'))).not.toBe(before);
  });

  it('a reviewer rule\'s description is part of its version', async () => {
    const dir = project();
    const before = ruleVersion(aspect(await loadGraph(dir), 'has-doc-comment'));
    const file = path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment', 'yg-aspect.yaml');
    writeFileSync(file, readFileSync(file, 'utf-8').replace("describing the file's purpose.", "describing the file's purpose and owner."), 'utf-8');
    expect(ruleVersion(aspect(await loadGraph(dir), 'has-doc-comment'))).not.toBe(before);
  });

  it('writes one sentence and reads it back', () => {
    const one = ratificationLine({ types: ['service'], version: 'abcdef0123456789', by: 'Jane Doe' });
    expect(one).toBe('Ratified for type service: rule version abcdef0123456789, admitted by Jane Doe.');
    expect(parseRatification(`${one}\n\nWhy.`)).toEqual({ types: ['service'], version: 'abcdef0123456789', by: 'Jane Doe' });
    const two = ratificationLine({ types: ['api', 'service'], version: '0123', by: 'the team' });
    expect(two.startsWith('Ratified for types api, service:')).toBe(true);
    expect(parseRatification(two)?.types).toEqual(['api', 'service']);
    expect(parseRatification('Status: advisory → enforced, decided by x. Evidence: y')).toBeNull();
    expect(parseRatification('Ratified for type service without a version')).toBeNull();
  });
});

describe('type law — the finding', () => {
  it('reports enforced type law with no admission as an error, and only once the setting asks for admission', async () => {
    const dir = project();
    expect(await classifyTypeLaw(await loadGraph(dir))).toEqual([]);
    appendFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), '\ntype_law:\n  ratification: true\n', 'utf-8');
    const issues = await classifyTypeLaw(await loadGraph(dir));
    expect(issues.map((i) => [i.aspectId, i.severity])).toEqual([['has-doc-comment', 'error'], ['no-todo-comments', 'error']]);
  });

  it('an admission of an earlier version is named, and a superseded one does not count', async () => {
    const dir = project();
    const graph = await loadGraph(dir);
    const first = await appendAspectLogEntry({
      yggRootPath: graph.rootPath,
      aspectId: 'no-todo-comments',
      reasonText: `${ratificationLine({ types: ['service'], version: '0000000000000000', by: 'Jane Doe' })}\n\nAn older reading.`,
      nowMs: NOW,
    });
    expect(first.ok).toBe(true);
    let found = (await findUnratifiedTypeLaw(graph)).find((f) => f.aspectId === 'no-todo-comments');
    expect(found?.earlier?.version).toBe('0000000000000000');

    const current = ruleVersion(aspect(graph, 'no-todo-comments'));
    const second = await appendAspectLogEntry({
      yggRootPath: graph.rootPath,
      aspectId: 'no-todo-comments',
      reasonText: `${ratificationLine({ types: ['service'], version: current, by: 'Jane Doe' })}\n\nAdmitted.`,
      nowMs: NOW + 1000,
    });
    expect(second.ok).toBe(true);
    expect((await findUnratifiedTypeLaw(graph)).some((f) => f.aspectId === 'no-todo-comments')).toBe(false);

    // Retracting the admission by superseding it brings the finding back.
    const retracted = await appendAspectLogEntry({
      yggRootPath: graph.rootPath,
      aspectId: 'no-todo-comments',
      reasonText: 'The admission was recorded for the wrong rule.',
      nowMs: NOW + 2000,
      supersedes: [second.ok ? second.datetime : ''],
    });
    expect(retracted.ok).toBe(true);
    found = (await findUnratifiedTypeLaw(graph)).find((f) => f.aspectId === 'no-todo-comments');
    expect(found?.types).toEqual(['service']);
  });

  it('a log that cannot be read is said, and counts as no admission', async () => {
    const dir = project();
    appendFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), '\ntype_law:\n  ratification: true\n', 'utf-8');
    writeFileSync(path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'log.md'), 'not a log\n', 'utf-8');
    const found = (await findUnratifiedTypeLaw(await loadGraph(dir))).find((f) => f.aspectId === 'no-todo-comments');
    expect(found?.logUnreadable).toBeDefined();
    const issue = (await classifyTypeLaw(await loadGraph(dir))).find((i) => i.aspectId === 'no-todo-comments');
    expect(issue?.messageData?.what).toContain('could not be read');
  });
});

describe('type law — the law a graph already had', () => {
  it('records each enforced rule on a type once, naming the upgrade, and leaves nothing unrecorded', async () => {
    const dir = project();
    const graph = await loadGraph(dir);
    const { recorded, failed } = await grandfatherTypeLaw(graph, NOW);
    expect(failed).toEqual([]);
    expect(recorded).toEqual([
      { aspectId: 'has-doc-comment', types: ['service'] },
      { aspectId: 'no-todo-comments', types: ['service'] },
    ]);
    const log = await readAspectLog(graph.rootPath, 'no-todo-comments');
    expect(log.ok && parseRatification(log.entries[0].body)?.by).toContain('yg init --upgrade');
    expect(await findUnratifiedTypeLaw(graph)).toEqual([]);
    expect((await grandfatherTypeLaw(graph, NOW + 1000)).recorded).toEqual([]);
  });

  it('a log that refuses the entry is reported, not skipped silently', async () => {
    const dir = project();
    // A hard-linked log is refused by every append: replacing it would split the history in two.
    const log = path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'log.md');
    writeFileSync(log, '', 'utf-8');
    linkSync(log, path.join(dir, 'elsewhere.md'));
    const { recorded, failed } = await grandfatherTypeLaw(await loadGraph(dir), NOW);
    expect(recorded.map((r) => r.aspectId)).toEqual(['has-doc-comment']);
    expect(failed.map((f) => f.aspectId)).toEqual(['no-todo-comments']);
  });
});
