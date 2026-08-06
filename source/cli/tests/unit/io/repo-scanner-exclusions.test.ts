import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isCoverageExcludedPath, countMappedButExcludedFiles } from '../../../src/io/repo-scanner.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';

describe('isCoverageExcludedPath', () => {
  it('returns false for an empty or dot path (both guard branches)', () => {
    expect(isCoverageExcludedPath('')).toBe(false);
    expect(isCoverageExcludedPath('.')).toBe(false);
    expect(isCoverageExcludedPath('./')).toBe(false);
  });

  it('excludes a `.git` path in every form (segment match)', () => {
    expect(isCoverageExcludedPath('.git')).toBe(true); // worktree pointer FILE or dir
    expect(isCoverageExcludedPath('.git/config')).toBe(true);
    expect(isCoverageExcludedPath('.git/')).toBe(true); // trailing-slash strip branch
    expect(isCoverageExcludedPath('sub/.git/HEAD')).toBe(true); // nested segment
    expect(isCoverageExcludedPath('sub\\.git\\HEAD')).toBe(true); // backslash-normalize branch
    expect(isCoverageExcludedPath('./.git')).toBe(true); // leading ./ strip branch
  });

  it('excludes the graph directory itself and everything inside it', () => {
    expect(isCoverageExcludedPath('.yggdrasil')).toBe(true); // exact-match branch
    expect(isCoverageExcludedPath('.yggdrasil/')).toBe(true);
    expect(isCoverageExcludedPath('.yggdrasil/yg-lock.nondeterministic.json')).toBe(true); // startsWith branch
    expect(isCoverageExcludedPath('.yggdrasil/model/cli/yg-node.yaml')).toBe(true);
  });

  it('does NOT exclude ordinary source paths, nor look-alikes', () => {
    expect(isCoverageExcludedPath('src/index.ts')).toBe(false);
    expect(isCoverageExcludedPath('README.md')).toBe(false);
    expect(isCoverageExcludedPath('git')).toBe(false); // not `.git`
    expect(isCoverageExcludedPath('src/.gitkeep')).toBe(false); // segment is `.gitkeep`, not `.git`
    expect(isCoverageExcludedPath('.yggdrasil-notes/x.md')).toBe(false); // prefix, not the dir
  });
});

describe('countMappedButExcludedFiles', () => {
  const tmpRoots: string[] = [];
  afterEach(async () => {
    while (tmpRoots.length > 0) {
      await rm(tmpRoots.pop()!, { recursive: true, force: true });
    }
  });

  async function makeProject(): Promise<{ projectRoot: string; yggRoot: string }> {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-repo-scanner-count-'));
    tmpRoots.push(projectRoot);
    const yggRoot = path.join(projectRoot, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    return { projectRoot, yggRoot };
  }

  async function writeFileEnsuringDir(abs: string, content: string): Promise<void> {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  function buildGraph(yggRoot: string, mapping: string[], excluded: string[]): Graph {
    const node = {
      path: 'svc',
      meta: { name: 'svc', type: 'service', mapping },
      children: [],
      parent: null,
    } as unknown as GraphNode;
    return {
      config: { coverage: { required: [], excluded, typeLevel: false } },
      architecture: { node_types: { service: { description: 'x' } } },
      nodes: new Map([['svc', node]]),
      aspects: [],
      flows: [],
      rootPath: yggRoot,
    } as unknown as Graph;
  }

  it('counts a file a directory mapping sweeps in that an excluded root removes from enforcement', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/svc/kept.ts'), 'export const kept = 1;\n');
    await writeFileEnsuringDir(path.join(projectRoot, 'src/svc/vendor/lib.ts'), 'export const lib = 1;\n');
    const graph = buildGraph(yggRoot, ['src/svc'], ['src/svc/vendor/']);
    const count = await countMappedButExcludedFiles(graph, ['src/svc/kept.ts', 'src/svc/vendor/lib.ts']);
    expect(count).toBe(1);
  });

  it('does not count a file that is excluded but never textually mapped by any node', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/svc/kept.ts'), 'export const kept = 1;\n');
    const graph = buildGraph(yggRoot, ['src/svc'], ['other/']);
    const count = await countMappedButExcludedFiles(graph, ['src/svc/kept.ts', 'other/file.ts']);
    expect(count).toBe(0);
  });

  it('control: with no coverage.excluded roots at all, nothing is counted', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/svc/kept.ts'), 'export const kept = 1;\n');
    const graph = buildGraph(yggRoot, ['src/svc'], []);
    const count = await countMappedButExcludedFiles(graph, ['src/svc/kept.ts']);
    expect(count).toBe(0);
  });
});
