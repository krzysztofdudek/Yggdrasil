// A node type's decision log below the CLI: the refusals of an add, the
// baseline it records, the lock section that holds it (read, written, refused
// when malformed), the check findings over it, the merge reconciliation of a
// type's log, the standing of replaced entries, and the fill's clean-up of a
// baseline whose type is gone. Exercised on the real loader over the lifecycle
// fixture; git only through the identity-carrying fixture helper.

import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { appendTypeLogEntry, readTypeLog, typeLogNameUsable, typeLogTargetRefusal } from '../../../src/core/log/type-log.js';
import { classifyLogStateFromLock } from '../../../src/core/check-log-state.js';
import { logMergeResolve } from '../../../src/core/log/log-merge-resolve.js';
import { composeLogEntry } from '../../../src/core/log/log-entry.js';
import { competingSuccessors, withStanding } from '../../../src/core/log/log-supersedes.js';
import { parseLog } from '../../../src/core/parsing/log-parser.js';
import { readLock, writeLock, readTypeLock, writeTypeLock, LockInvalidError } from '../../../src/io/lock-store.js';
import type { CheckIssue } from '../../../src/core/check-contract.js';
import type { Graph } from '../../../src/model/graph.js';
import { runGitFixture, FIXTURE_RM_OPTIONS } from '../../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'e2e-lifecycle');
const LOG_REL = '.yggdrasil/types/service/log.md';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, FIXTURE_RM_OPTIONS);
});

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-type-log-'));
  dirs.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

let clock = Date.parse('2026-09-01T00:00:00.000Z');
async function add(graph: Graph, reasonText: string, typeId = 'service', supersedes?: string[]): Promise<ReturnType<typeof appendTypeLogEntry>> {
  return appendTypeLogEntry({ graph, typeId, reasonText, nowMs: (clock += 1000), supersedes, adds: supersedes === undefined });
}

async function findings(graph: Graph, dir: string): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  await classifyLogStateFromLock(graph, dir, readLock(graph.rootPath), issues);
  return issues;
}

describe('type log — naming and refusals', () => {
  it('a type name that is not one plain path segment gets no log', async () => {
    expect(typeLogNameUsable('service')).toBe(true);
    for (const bad of ['', '.hidden', 'a/b', 'a\\b']) expect(typeLogNameUsable(bad)).toBe(false);
    const graph = await loadGraph(project());
    graph.architecture.node_types['a/b'] = { description: 'x' };
    expect(typeLogTargetRefusal(graph, 'a/b')?.code).toBe('command-error');
    expect(typeLogTargetRefusal(graph, 'toString')?.code).toBe('type-not-found');
    expect(typeLogTargetRefusal(graph, 'service')).toBeNull();
  });

  it('refuses a symlinked log, a conflicted log, a malformed log and an unreadable lock', async () => {
    const dir = project();
    const graph = await loadGraph(dir);
    const logAbs = path.join(dir, LOG_REL);
    mkdirSync(path.dirname(logAbs), { recursive: true });

    writeFileSync(path.join(dir, 'elsewhere.md'), '', 'utf-8');
    symlinkSync(path.join(dir, 'elsewhere.md'), logAbs);
    let r = await add(graph, 'x');
    expect(r.ok ? null : r.error.code).toBe('command-error');
    rmSync(logAbs);

    writeFileSync(logAbs, '<<<<<<< HEAD\n## [2026-01-01T00:00:00.000Z]\na\n=======\n>>>>>>> b\n', 'utf-8');
    r = await add(graph, 'x');
    expect(r.ok ? null : r.error.code).toBe('log-conflict');

    writeFileSync(logAbs, 'no header\n', 'utf-8');
    r = await add(graph, 'x');
    expect(r.ok ? null : r.error.code).toBe('log-format');
    const read = await readTypeLog(graph, 'service');
    expect(read.ok ? null : read.error.code).toBe('log-format');
    rmSync(logAbs);

    writeFileSync(path.join(dir, '.yggdrasil', 'yg-lock.types.json'), '{not json', 'utf-8');
    r = await add(graph, 'x');
    expect(r.ok ? null : r.error.code).toBe('lock-invalid');
  });
});

describe('type log — baseline, lock section, findings', () => {
  it('records the baseline in its own file, never in the logs file a 6.0.x reader opens, and refuses a malformed one', async () => {
    const dir = project();
    const graph = await loadGraph(dir);
    const first = await add(graph, 'First decision.');
    expect(first.ok).toBe(true);
    expect(readLock(graph.rootPath).types?.service?.log?.last_entry_datetime).toBe(first.ok ? first.datetime : '');

    const typesFile = path.join(dir, '.yggdrasil', 'yg-lock.types.json');
    const logsFile = path.join(dir, '.yggdrasil', 'yg-lock.logs.json');
    expect(JSON.parse(readFileSync(typesFile, 'utf-8')).types.service.log.last_entry_datetime).toBe(first.ok ? first.datetime : '');
    // What a 6.0.0 reader of the logs file accepts: exactly these top-level keys, whatever the type logs hold.
    if (existsSync(logsFile)) {
      for (const key of Object.keys(JSON.parse(readFileSync(logsFile, 'utf-8')))) expect(['version', 'verdicts', 'nodes']).toContain(key);
    }

    for (const bad of [
      '{not json',
      '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> b\n',
      JSON.stringify([]),
      JSON.stringify({ version: 2, types: {} }),
      JSON.stringify({ version: 1, types: [] }),
      JSON.stringify({ version: 1, types: { service: [] } }),
      JSON.stringify({ version: 1, types: { service: { log: 'x' } } }),
      JSON.stringify({ version: 1, types: { service: { log: { last_entry_datetime: 1, prefix_hash: 'h' } } } }),
    ]) {
      writeFileSync(typesFile, bad, 'utf-8');
      expect(() => readTypeLock(graph.rootPath)).toThrow(LockInvalidError);
    }
    // A key a later release adds is ignored, at the top and in an entry.
    writeFileSync(typesFile, JSON.stringify({ version: 1, later: 1, types: { service: { later: 1 }, module: { log: { last_entry_datetime: 'd', prefix_hash: 'h' } } } }), 'utf-8');
    expect(readTypeLock(graph.rootPath)).toEqual({ service: {}, module: { log: { last_entry_datetime: 'd', prefix_hash: 'h' } } });
    await writeTypeLock(graph.rootPath, {});
    expect(existsSync(typesFile)).toBe(false);
  });

  it('reads a committed lock file a later release extended at the top level, and one from before type logs', async () => {
    const dir = project();
    const graph = await loadGraph(dir);
    const logsFile = path.join(dir, '.yggdrasil', 'yg-lock.logs.json');
    const node = { log: { last_entry_datetime: '2026-01-01T00:00:00.000Z', prefix_hash: 'h' } };
    writeFileSync(logsFile, JSON.stringify({ version: 1, verdicts: {}, nodes: { 'services/orders': node } }), 'utf-8');
    expect(readLock(graph.rootPath).nodes['services/orders']).toEqual(node);
    writeFileSync(logsFile, JSON.stringify({ version: 1, verdicts: {}, nodes: { 'services/orders': node }, types: { x: {} }, somethingLater: [1] }), 'utf-8');
    const lock = readLock(graph.rootPath);
    expect(lock.nodes['services/orders']).toEqual(node);
    expect(lock.types).toBeUndefined();
    // Inside a known section the shape stays strict.
    writeFileSync(logsFile, JSON.stringify({ version: 1, verdicts: {}, nodes: { 'services/orders': { stray: 1 } } }), 'utf-8');
    expect(() => readLock(graph.rootPath)).toThrow(LockInvalidError);
  });

  it('a fill that read the lock before a type decision was added writes nothing over its baseline', async () => {
    const dir = project();
    const graph = await loadGraph(dir);
    // The fill's snapshot, taken before the add, as a full --approve takes it.
    const snapshot = readLock(graph.rootPath);
    const added = await add(graph, 'Decided while a fill was running.');
    expect(added.ok).toBe(true);
    const typesFile = path.join(dir, '.yggdrasil', 'yg-lock.types.json');
    const recorded = readFileSync(typesFile, 'utf-8');
    // The fill ends: it writes every lock file it owns from its old snapshot.
    await writeLock(graph.rootPath, snapshot, { scope: 'all', deterministicAspectIds: new Set() });
    expect(readFileSync(typesFile, 'utf-8')).toBe(recorded);
    expect(await findings(graph, dir)).toEqual([]);
  });

  it('reports a rewritten, a missing and a malformed type log, and an orphaned one', async () => {
    const dir = project();
    const graph = await loadGraph(dir);
    await add(graph, 'Retries are the caller\'s job.');
    expect(await findings(graph, dir)).toEqual([]);

    const logAbs = path.join(dir, LOG_REL);
    writeFileSync(logAbs, readFileSync(logAbs, 'utf-8').replace('caller', 'callee'), 'utf-8');
    expect((await findings(graph, dir)).map((i) => [i.code, i.unitKey])).toEqual([['log-integrity', `file:${LOG_REL}`]]);

    rmSync(logAbs);
    expect((await findings(graph, dir)).map((i) => i.code)).toEqual(['log-integrity']);

    rmSync(path.join(dir, '.yggdrasil', 'yg-lock.types.json'));
    writeFileSync(logAbs, 'no header\n', 'utf-8');
    expect((await findings(graph, dir)).map((i) => i.code)).toEqual(['log-format']);

    rmSync(logAbs);
    mkdirSync(path.join(dir, '.yggdrasil', 'types', 'ghost'), { recursive: true });
    mkdirSync(path.join(dir, '.yggdrasil', 'types', 'empty'), { recursive: true });
    writeFileSync(path.join(dir, '.yggdrasil', 'types', 'ghost', 'log.md'), '## [2026-01-01T00:00:00.000Z]\nold\n', 'utf-8');
    writeFileSync(path.join(dir, '.yggdrasil', 'types', 'stray.md'), 'not a directory\n', 'utf-8');
    const orphans = await findings(graph, dir);
    expect(orphans.map((i) => [i.code, i.severity, i.unitKey])).toEqual([['type-log-orphaned', 'warning', 'file:.yggdrasil/types/ghost/log.md']]);
  });
});

describe('type log — merge reconciliation', () => {
  it('reconciles a type log conflicted by a merge and records its baseline; a missing one is refused', async () => {
    const dir = project();
    const git = (args: string[]): void => { runGitFixture(dir, args); };
    git(['init', '-q', '-b', 'main']);
    let graph = await loadGraph(dir);
    await add(graph, 'Shared.');
    git(['add', '-A']); git(['commit', '-q', '-m', 'base']);
    git(['checkout', '-q', '-b', 'b']);
    await add(graph, 'Side b.');
    git(['add', '-A']); git(['commit', '-q', '-m', 'b']);
    git(['checkout', '-q', 'main']);
    await add(graph, 'Side a.');
    git(['add', '-A']); git(['commit', '-q', '-m', 'a']);
    runGitFixture(dir, ['merge', 'b']);
    runGitFixture(dir, ['checkout', '--ours', '--', '.yggdrasil/yg-lock.types.json']);

    graph = await loadGraph(dir);
    const result = await logMergeResolve({ graph, typeId: 'service', repoRoot: dir });
    expect(result).toEqual({ ok: true, typeId: 'service', logPath: LOG_REL, target: '--type service', wroteUnion: true, inProgress: 'merge' });
    const read = await readTypeLog(graph, 'service');
    expect(read.ok ? read.entries.length : 0).toBe(3);
    expect(await findings(graph, dir)).toEqual([]);

    const unknown = await logMergeResolve({ graph, typeId: 'nope', repoRoot: dir });
    expect(unknown.ok ? null : unknown.error.code).toBe('type-not-found');
    const missing = await logMergeResolve({ graph, typeId: 'module', repoRoot: dir });
    expect(missing.ok ? null : missing.error.code).toBe('log-merge-log-missing');
  }, 60_000);
});

describe('entries that replace earlier ones', () => {
  it('a replaced entry reads as replaced, a dangling or forward reference replaces nothing', () => {
    let log = '';
    const at = (n: number): number => Date.parse('2026-01-01T00:00:00.000Z') + n * 1000;
    const put = (text: string, n: number, supersedes?: string[]): string => {
      const c = composeLogEntry(log, text, at(n), { supersedes });
      if (!c.ok) throw new Error(c.error.what);
      log = c.content;
      return c.datetime;
    };
    const a = put('a', 1);
    put('b', 2, [a, a]); // the duplicate is written once
    expect(log.match(/### Supersedes:/g)).toHaveLength(1);
    const refused = composeLogEntry(log, 'c', at(3), { supersedes: [a] });
    expect(refused.ok ? null : refused.error.code).toBe('log-supersedes-superseded');
    const unknown = composeLogEntry(log, 'c', at(3), { supersedes: ['2001-01-01T00:00:00.000Z'] });
    expect(unknown.ok ? null : unknown.error.code).toBe('log-supersedes-unknown');
    // A hand-written heading naming a datetime that is not strict ends the run of references.
    put('### Supersedes: yesterday\nprose', 4);
    expect(withStanding(parseLog(log)).map((e) => e.supersedes.length)).toEqual([0, 1, 0]);
  });

  it('a hand-written reference to a LATER entry, or to one the log does not hold, replaces nothing', () => {
    const A = '2026-01-01T00:00:01.000Z';
    const B = '2026-01-01T00:00:02.000Z';
    const C = '2026-01-01T00:00:03.000Z';
    // A names B, which comes after it: a forward reference cannot take B out of force.
    const forward = `## [${A}]\n### Supersedes: ${B}\n\nwritten first\n## [${B}]\nwritten second\n`;
    expect(withStanding(parseLog(forward)).map((e) => e.supersededBy)).toEqual([undefined, undefined]);
    // C names an entry the log does not hold, and itself: neither replaces anything.
    const dangling = `## [${A}]\na\n## [${C}]\n### Supersedes: 2001-01-01T00:00:00.000Z\n### Supersedes: ${C}\n\nc\n`;
    expect(withStanding(parseLog(dangling)).map((e) => e.supersededBy)).toEqual([undefined, undefined]);
    expect(competingSuccessors(withStanding(parseLog(forward)))).toEqual([]);
  });

  it('two successors of one entry both in force compete, until an entry supersedes them', () => {
    const [A, B, C, D] = ['01', '02', '03', '04'].map((n) => `2026-01-01T00:00:${n}.000Z`);
    const merged = `## [${A}]\na\n## [${B}]\n### Supersedes: ${A}\n\nb\n## [${C}]\n### Supersedes: ${A}\n\nc\n`;
    expect(competingSuccessors(withStanding(parseLog(merged)))).toEqual([{ target: A, successors: [B, C] }]);
    const settled = `${merged}## [${D}]\n### Supersedes: ${B}\n### Supersedes: ${C}\n\nd\n`;
    expect(competingSuccessors(withStanding(parseLog(settled)))).toEqual([]);
  });
});

describe('a full recording run drops the baseline of a type that no longer exists', () => {
  it('keeps a live type\'s baseline, drops a gone one, removes the file when it empties, and leaves it alone on a free run', async () => {
    const { garbageCollectAndRewrite } = await import('../../../src/core/fill-gc.js');
    const dir = project();
    const graph = await loadGraph(dir);
    const baseline = { last_entry_datetime: '2026-01-01T00:00:00.000Z', prefix_hash: 'h' };
    await writeTypeLock(graph.rootPath, { service: { log: baseline }, renamed: { log: baseline } });

    await garbageCollectAndRewrite(graph, readLock(graph.rootPath), async () => {}, { scope: 'deterministic' });
    expect(Object.keys(readTypeLock(graph.rootPath))).toEqual(['renamed', 'service']);

    const lock = readLock(graph.rootPath);
    await garbageCollectAndRewrite(graph, lock, async () => {});
    expect(Object.keys(readTypeLock(graph.rootPath))).toEqual(['service']);
    expect(Object.keys(lock.types ?? {})).toEqual(['service']);

    await writeTypeLock(graph.rootPath, { renamed: { log: baseline } });
    const again = readLock(graph.rootPath);
    await garbageCollectAndRewrite(graph, again, async () => {});
    expect(again.types).toBeUndefined();
    expect(existsSync(path.join(dir, '.yggdrasil', 'yg-lock.types.json'))).toBe(false);
  });
});
