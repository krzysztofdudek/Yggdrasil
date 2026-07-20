import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { logAdd } from '../../../src/core/log/log-add.js';
import { parseLog } from '../../../src/core/parsing/log-parser.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setupNode(name: string): Promise<{ projectRoot: string; nodePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-logadd-'));
  dirs.push(root);
  const nodeDir = path.join(root, '.yggdrasil', 'model', name);
  await mkdir(nodeDir, { recursive: true });
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), `name: ${name}\ntype: module\ndescription: x\n`);
  return { projectRoot: root, nodePath: name };
}

describe('logAdd (core)', () => {
  it('creates log.md when not present', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logAdd({ graph, nodePath, reasonText: 'Initial setup', nowMs: 1000 });
    expect(result.ok).toBe(true);
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const content = await readFile(logPath, 'utf-8');
    expect(content).toMatch(/^## \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]\nInitial setup\n$/);
  });

  it('appends directly after existing trailing newline (no blank separator)', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    await writeFile(logPath, '## [2026-05-11T14:00:00.000Z]\nFirst.\n');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logAdd({ graph, nodePath, reasonText: 'Second', nowMs: 1000 });
    expect(result.ok).toBe(true);
    const content = await readFile(logPath, 'utf-8');
    expect(content.match(/^## \[/gm)?.length).toBe(2);
    expect(content).toMatch(/First\.\n## \[/);
    expect(content).toMatch(/\nSecond\n$/);
  });

  it('append-then-approve preserves integrity baseline byte-stability', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    await logAdd({ graph, nodePath, reasonText: 'first', nowMs: 1000 });
    const afterFirst = await readFile(logPath, 'utf-8');
    const entriesAfterFirst = parseLog(afterFirst);
    expect(entriesAfterFirst).toHaveLength(1);
    const baselineOffsetEnd = entriesAfterFirst[0].offsetEnd;
    expect(baselineOffsetEnd).toBe(Buffer.byteLength(afterFirst, 'utf-8'));

    await logAdd({ graph, nodePath, reasonText: 'second', nowMs: 2000 });
    const afterSecond = await readFile(logPath, 'utf-8');
    const entriesAfterSecond = parseLog(afterSecond);
    expect(entriesAfterSecond).toHaveLength(2);
    expect(entriesAfterSecond[0].offsetEnd).toBe(baselineOffsetEnd);
  });

  it('auto-bumps datetime when current time <= last entry', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const future = new Date(Date.now() + 60_000).toISOString();
    await writeFile(logPath, `## [${future}]\nFuture.\n`);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logAdd({ graph, nodePath, reasonText: 'Now', nowMs: 1000 });
    expect(result.ok).toBe(true);
    const content = await readFile(logPath, 'utf-8');
    const headers = [...content.matchAll(/^## \[(.+?)\]/gm)].map((m) => m[1]);
    expect(headers).toHaveLength(2);
    expect(headers[1] > headers[0]).toBe(true);
  });

  it('rejects empty reasonText after trim', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logAdd({ graph, nodePath, reasonText: '   ', nowMs: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toMatch(/reason.*empty/i);
  });

  it('rejects reasonText with level-2 header outside fence', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logAdd({ graph, nodePath, reasonText: 'intro\n## stray\n', nowMs: 1000 });
    expect(result.ok).toBe(false);
  });

  it('accepts reasonText with level-2 header INSIDE fence', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logAdd({
      graph,
      nodePath,
      reasonText: 'before\n```python\n## comment\n```\nafter',
      nowMs: 1000,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects reasonText with an unclosed code fence (never writes log.md)', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const result = await logAdd({
      graph,
      nodePath,
      reasonText: 'see code:\n```\nfoo()',
      nowMs: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toMatch(/unclosed code fence/i);
    // The rejection must happen before any write: log.md stays absent.
    await expect(readFile(logPath, 'utf-8')).rejects.toBeTruthy();
  });

  it('rejects an unclosed fence up front, so a later entry can never be swallowed', async () => {
    // Case B: entry 1 opens a fence it never closes; entry 2 leads with a bare
    // closing fence. Without the guard, both writes succeed and the shared
    // fence-aware parser merges entry 2 into entry 1's body — one entry silently
    // vanishes. The guard must reject the FIRST add before log.md is ever written.
    const { projectRoot, nodePath } = await setupNode('billing');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const first = await logAdd({
      graph,
      nodePath,
      reasonText: 'first entry:\n```python\nfoo()',
      nowMs: 1000,
    });
    expect(first.ok).toBe(false);
    await expect(readFile(logPath, 'utf-8')).rejects.toBeTruthy();

    // Corrected: both reasons individually fence-balanced — both add cleanly and
    // both entries survive as distinct headers.
    const a = await logAdd({
      graph,
      nodePath,
      reasonText: 'first entry:\n```python\nfoo()\n```',
      nowMs: 1000,
    });
    expect(a.ok).toBe(true);
    const b = await logAdd({
      graph,
      nodePath,
      reasonText: 'second entry justification text',
      nowMs: 2000,
    });
    expect(b.ok).toBe(true);
    const content = await readFile(logPath, 'utf-8');
    expect(parseLog(content)).toHaveLength(2);
  });

  it('accepts a reason whose fence closes with a CRLF-terminated line', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logAdd({
      graph,
      nodePath,
      reasonText: 'before\r\n```python\r\nfoo()\r\n```\r\nafter',
      nowMs: 1000,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects symlink log.md', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const target = path.join(projectRoot, 'real.md');
    await writeFile(target, '');
    await symlink(target, logPath);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logAdd({ graph, nodePath, reasonText: 'x', nowMs: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('symbolic link');
  });

  it('rejects hardlink log.md (st_nlink > 1)', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const other = path.join(projectRoot, 'other.md');
    await writeFile(logPath, '');
    await link(logPath, other);
    const s = await lstat(logPath);
    expect(s.nlink).toBe(2);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logAdd({ graph, nodePath, reasonText: 'x', nowMs: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('hard links');
  });

  it('rejects invalid node path (..)', async () => {
    const { projectRoot } = await setupNode('billing');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logAdd({ graph, nodePath: '../escape', reasonText: 'x', nowMs: 1000 });
    expect(result.ok).toBe(false);
  });

  it('rejects when node does not exist (no yg-node.yaml)', async () => {
    const { projectRoot } = await setupNode('billing');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logAdd({ graph, nodePath: 'missing', reasonText: 'x', nowMs: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('Node not found');
  });
});
