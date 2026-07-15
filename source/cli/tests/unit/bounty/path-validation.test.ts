/**
 * Bounty: path validation — overlap + type-when + allPathsMissing.
 *
 * Exhaustive coverage of:
 *   - checkMappingOverlap        (src/core/checks/mapping.ts)
 *       * plain string pass: file-duplicate-mapping, overlapping-mapping,
 *         ancestor-descendant child-wins allowed
 *       * glob file-level pass: two non-hierarchical nodes claim the same file
 *         via a glob -> overlapping-mapping; child-wins allowed; glob-free graphs
 *         only use the string pass.
 *   - checkTypeWhenMismatch      (src/core/checks/architecture.ts)
 *       * a glob mapping entry is expanded and the matched files are when-checked
 *         (no false positive on a glob whose files satisfy when; an error when
 *         one matched file violates when).
 *   - checkMappingPathsExist     (src/core/checks/mapping.ts)
 *       * glob matches-nothing -> error; glob matches >=1 -> no error
 *         (this is the allPathsMissing-for-glob behavior).
 *
 * Every graph is backed by a fresh mkdtemp temp dir so validator FS scans stay
 * bounded and never touch the repo. We build the Graph object inline (mirroring
 * the buildTestGraph helper) so we can set node `mapping:` and architecture
 * `when:` precisely — neither of which buildTestGraph exposes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  checkMappingOverlap,
  checkMappingPathsExist,
} from '../../../src/core/checks/mapping.js';
import { checkTypeWhenMismatch } from '../../../src/core/checks/architecture.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';
import type {
  Graph,
  GraphNode,
  ArchitectureNodeType,
} from '../../../src/model/graph.js';
import type { FileWhenPredicate } from '../../../src/model/file-when.js';

// --- temp-dir lifecycle ------------------------------------------------------

const tmpRoots: string[] = [];

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Create a fresh isolated project: returns { projectRoot, yggRoot }. The yggRoot
 * (.yggdrasil dir) is what Graph.rootPath points at; path.dirname(rootPath) is
 * the projectRoot the validators walk.
 */
async function makeProject(): Promise<{ projectRoot: string; yggRoot: string }> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-bounty-pathval-'));
  tmpRoots.push(projectRoot);
  const yggRoot = path.join(projectRoot, '.yggdrasil');
  await mkdir(yggRoot, { recursive: true });
  return { projectRoot, yggRoot };
}

async function writeFileEnsuringDir(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

interface NodeSpec {
  path: string;
  type?: string;
  mapping?: string[];
  parent?: string;
}

interface TypeSpec {
  when?: FileWhenPredicate;
  enforce?: 'strict';
}

/**
 * Build an inline Graph rooted at yggRoot. Nodes are stored in a Map in the
 * order given (graph insertion order matters for some checks). Parent links are
 * wired from `parent`. node_types are taken from `types` (caller controls
 * `when`); any node type not in `types` falls back to a description-only entry.
 */
function buildGraph(
  yggRoot: string,
  nodes: NodeSpec[],
  types: Record<string, TypeSpec> = {},
): Graph {
  const node_types: Record<string, ArchitectureNodeType> = {};
  for (const [id, spec] of Object.entries(types)) {
    node_types[id] = {
      description: `type ${id}`,
      ...(spec.when !== undefined ? { when: spec.when } : {}),
      ...(spec.enforce !== undefined ? { enforce: spec.enforce } : {}),
    };
  }

  const nodeByPath = new Map<string, GraphNode>();
  for (const n of nodes) {
    const type = n.type ?? 'service';
    if (node_types[type] === undefined) {
      node_types[type] = { description: `type ${type}` };
    }
    nodeByPath.set(n.path, {
      path: n.path,
      meta: { name: n.path, type, mapping: n.mapping },
      children: [],
      parent: null,
    } as GraphNode);
  }
  for (const n of nodes) {
    if (n.parent) {
      const child = nodeByPath.get(n.path)!;
      const parent = nodeByPath.get(n.parent)!;
      child.parent = parent;
      parent.children.push(child);
    }
  }

  return {
    config: {
      version: '5.0.0',
      reviewer: {
        tiers: { default: { provider: 'ollama', model: 'test', temperature: 0, consensus: 1 } },
        default: 'default',
      },
    },
    architecture: { node_types },
    nodes: nodeByPath,
    aspects: [],
    flows: [],
    rootPath: yggRoot,
  } as unknown as Graph;
}

function codes(issues: { code?: string }[]): string[] {
  return issues.map((i) => i.code).filter((c): c is string => c !== undefined);
}

// =============================================================================
// checkMappingOverlap — plain string pass (no glob anywhere)
// =============================================================================

describe('checkMappingOverlap — plain string pass', () => {
  it('two non-hierarchical nodes mapping the SAME exact file -> file-duplicate-mapping', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/shared.ts'] },
      { path: 'b', mapping: ['src/shared.ts'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(codes(issues)).toContain('file-duplicate-mapping');
    expect(codes(issues)).not.toContain('overlapping-mapping');
  });

  it('two non-hierarchical nodes with containment overlap (dir vs nested dir) -> overlapping-mapping', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/feature'] },
      { path: 'b', mapping: ['src/feature/sub'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(codes(issues)).toContain('overlapping-mapping');
    expect(codes(issues)).not.toContain('file-duplicate-mapping');
  });

  it('ancestor-descendant nodes with containment overlap is ALLOWED (child wins)', async () => {
    const { yggRoot } = await makeProject();
    // node "parent" maps src/feature; child node "parent/child" maps src/feature/sub.
    const graph = buildGraph(yggRoot, [
      { path: 'parent', mapping: ['src/feature'] },
      { path: 'parent/child', mapping: ['src/feature/sub'], parent: 'parent' },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });

  it('ancestor-descendant nodes mapping the SAME exact file STILL flags file-duplicate-mapping (child-wins is only for containment)', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'parent', mapping: ['src/feature/file.ts'] },
      { path: 'parent/child', mapping: ['src/feature/file.ts'], parent: 'parent' },
    ]);
    const issues = await checkMappingOverlap(graph);
    // Equal-path duplicates are flagged regardless of hierarchy: the child-wins
    // exemption is checked only after the equal-path branch (which `continue`s).
    expect(codes(issues)).toContain('file-duplicate-mapping');
  });

  it('non-overlapping plain mappings produce no issue', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/a'] },
      { path: 'b', mapping: ['src/b'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });

  it('a path that is a string-prefix but not a directory boundary does NOT overlap', async () => {
    const { yggRoot } = await makeProject();
    // 'src/feature' is a string prefix of 'src/feature-2' but not a path-segment
    // boundary, so arePathsOverlapping must return false.
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/feature'] },
      { path: 'b', mapping: ['src/feature-2'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });

  it('two entries within the SAME node never conflict with each other', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/x', 'src/x/y.ts'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });

  it('glob-free graph never runs the filesystem glob pass (no false positives, returns string-pass result)', async () => {
    const { yggRoot } = await makeProject();
    // Two siblings overlap by containment -> string pass yields overlapping-mapping.
    // Since there is NO glob entry anywhere, the glob FS pass is skipped entirely.
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src'] },
      { path: 'b', mapping: ['src/inner'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    // Exactly one overlapping-mapping from the string pass; no duplicate from a glob pass.
    expect(issues.filter((i) => i.code === 'overlapping-mapping')).toHaveLength(1);
  });

  it('leading ./ and trailing / are normalized away before comparison (same file -> duplicate)', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['./src/shared.ts'] },
      { path: 'b', mapping: ['src/shared.ts/'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(codes(issues)).toContain('file-duplicate-mapping');
  });
});

// =============================================================================
// checkMappingOverlap — glob file-level pass
// =============================================================================

describe('checkMappingOverlap — glob file-level pass', () => {
  it('two non-hierarchical nodes claim the SAME file (one via glob) -> overlapping-mapping', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    const graph = buildGraph(yggRoot, [
      // node "a" claims the file via a glob; node "b" claims it as an exact path.
      { path: 'a', mapping: ['src/repo/*Repository.cs'] },
      { path: 'b', mapping: ['src/repo/FooRepository.cs'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    const overlaps = issues.filter((i) => i.code === 'overlapping-mapping');
    expect(overlaps.length).toBeGreaterThanOrEqual(1);
    // The reported message lists the concrete conflicting file.
    expect(overlaps.some((i) => i.messageData.what.includes('src/repo/FooRepository.cs'))).toBe(true);
  });

  it('two non-hierarchical nodes both claim the same file via DIFFERENT globs -> overlapping-mapping', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/repo/*Repository.cs'] },
      { path: 'b', mapping: ['src/**/*.cs'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues.filter((i) => i.code === 'overlapping-mapping').length).toBeGreaterThanOrEqual(1);
  });

  it('glob entries that resolve to DISJOINT files produce no overlap', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    await writeFileEnsuringDir(path.join(projectRoot, 'src/svc/BarService.cs'), 'class Bar {}');
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/repo/*Repository.cs'] },
      { path: 'b', mapping: ['src/svc/*Service.cs'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });

  it('ancestor-descendant pair overlapping via a glob is ALLOWED (child-wins applies to the glob pass too)', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    const graph = buildGraph(yggRoot, [
      // parent maps the whole dir; child claims *Repository.cs via a glob.
      { path: 'svc', mapping: ['src/repo'] },
      { path: 'svc/repo', mapping: ['src/repo/*Repository.cs'], parent: 'svc' },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });

  it('three nodes claim one file (two siblings + one ancestor): ancestor is dropped, the two siblings still conflict', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/repo'] }, // ancestor of svc/x — dropped by child-wins
      { path: 'svc/x', mapping: ['src/repo/*Repository.cs'], parent: 'svc' },
      { path: 'other', mapping: ['src/repo/FooRepository.cs'] }, // unrelated sibling
    ]);
    const issues = await checkMappingOverlap(graph);
    // svc is an ancestor of svc/x, so it's pruned. Remaining leaves: svc/x and
    // other — two non-hierarchical owners -> overlap.
    const overlaps = issues.filter((i) => i.code === 'overlapping-mapping');
    expect(overlaps.length).toBeGreaterThanOrEqual(1);
    const msg = overlaps.map((i) => i.messageData.what).join('\n');
    expect(msg).toContain('svc/x');
    expect(msg).toContain('other');
  });

  it('child-precedence: a child claiming a specific file inside a parent glob is exempt (child wins)', async () => {
    // The parent globs src/**/*.cs and the graph-child claims the specific
    // src/repo/FooRepository.cs. Under child-precedence the deeper node wins
    // implicitly — the glob-aware runtime carve-out removes that file from the
    // parent's subject set — so this is NOT flagged, even though the child's entry
    // is not string-nested in the parent's glob. (This is the "special case in a
    // globbed directory" pattern.)
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/**/*.cs'] }, // glob; ancestor node
      { path: 'svc/inner', mapping: ['src/repo/FooRepository.cs'], parent: 'svc' },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues.filter((i) => i.code === 'overlapping-mapping')).toHaveLength(0);
  });

  it('a glob that matches a file owned by NO other node produces no overlap', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/Helper.cs'), 'class Helper {}');
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/repo/*Repository.cs'] },
      { path: 'b', mapping: ['src/repo/Helper.cs'] }, // a different, non-overlapping file
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });

  it('a single file owned by two siblings, only one via glob, reports exactly once', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/repo/*Repository.cs'] },
      { path: 'b', mapping: ['src/repo/FooRepository.cs'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    // The glob pass dedups per-file via `reported`, so the same file is flagged once.
    expect(issues.filter((i) => i.code === 'overlapping-mapping')).toHaveLength(1);
  });

  it('glob present but matching NO files on disk yields no overlap from the glob pass', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/Helper.cs'), 'class Helper {}');
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/repo/*Repository.cs'] }, // matches nothing
      { path: 'b', mapping: ['src/repo/Helper.cs'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues.filter((i) => i.code === 'overlapping-mapping')).toHaveLength(0);
  });
});

// =============================================================================
// checkTypeWhenMismatch — glob expansion + when-check
// =============================================================================

describe('checkTypeWhenMismatch — glob mapping entries', () => {
  it('NO false positive: glob whose matched files all satisfy when produces no error', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/BarRepository.cs'), 'class Bar {}');
    const graph = buildGraph(
      yggRoot,
      [{ path: 'svc', type: 'repo', mapping: ['src/repo/*Repository.cs'] }],
      { repo: { when: { path: '**/*Repository.cs' } } },
    );
    const cache = new FileContentCache();
    const { issues, unreadable } = await checkTypeWhenMismatch(graph, cache);
    expect(issues.filter((i) => i.code === 'type-when-mismatch')).toHaveLength(0);
    expect(unreadable).toHaveLength(0);
  });

  it('emits type-when-mismatch when one glob-matched file violates when (path predicate)', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    // The glob `src/repo/*` matches BOTH files, but when requires *Repository.cs.
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/Helper.cs'), 'class Helper {}');
    const graph = buildGraph(
      yggRoot,
      [{ path: 'svc', type: 'repo', mapping: ['src/repo/*'] }],
      { repo: { when: { path: '**/*Repository.cs' } } },
    );
    const cache = new FileContentCache();
    const { issues } = await checkTypeWhenMismatch(graph, cache);
    const mismatches = issues.filter((i) => i.code === 'type-when-mismatch');
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].nodePath).toBe('svc');
    expect(mismatches[0].messageData.what).toContain('src/repo/Helper.cs');
  });

  it('content-predicate when: glob expansion + content check passes when every matched file has the marker', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/a.svc.ts'), '@Injectable()\nexport class A {}');
    await writeFileEnsuringDir(path.join(projectRoot, 'src/b.svc.ts'), '@Injectable()\nexport class B {}');
    const graph = buildGraph(
      yggRoot,
      [{ path: 'svc', type: 'service', mapping: ['src/*.svc.ts'] }],
      { service: { when: { content: '@Injectable' } } },
    );
    const cache = new FileContentCache();
    const { issues } = await checkTypeWhenMismatch(graph, cache);
    expect(issues.filter((i) => i.code === 'type-when-mismatch')).toHaveLength(0);
  });

  it('content-predicate when: one glob-matched file missing the marker -> exactly one mismatch', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/a.svc.ts'), '@Injectable()\nexport class A {}');
    await writeFileEnsuringDir(path.join(projectRoot, 'src/b.svc.ts'), 'export class B {}'); // no marker
    const graph = buildGraph(
      yggRoot,
      [{ path: 'svc', type: 'service', mapping: ['src/*.svc.ts'] }],
      { service: { when: { content: '@Injectable' } } },
    );
    const cache = new FileContentCache();
    const { issues } = await checkTypeWhenMismatch(graph, cache);
    const mismatches = issues.filter((i) => i.code === 'type-when-mismatch');
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].messageData.what).toContain('src/b.svc.ts');
  });

  it('glob matching NOTHING yields no when-check (and no false type-when-mismatch) — emptiness is checkMappingPathsExist territory', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/Helper.cs'), 'class Helper {}');
    const graph = buildGraph(
      yggRoot,
      [{ path: 'svc', type: 'repo', mapping: ['src/repo/*Repository.cs'] }], // matches nothing
      { repo: { when: { path: '**/*Repository.cs' } } },
    );
    const cache = new FileContentCache();
    const { issues, unreadable } = await checkTypeWhenMismatch(graph, cache);
    expect(issues.filter((i) => i.code === 'type-when-mismatch')).toHaveLength(0);
    expect(unreadable).toHaveLength(0);
  });

  it('plain (non-glob) entry is still checked literally — file violating when -> mismatch', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/handler.ts'), 'export function handler() {}');
    const graph = buildGraph(
      yggRoot,
      [{ path: 'svc', type: 'service', mapping: ['src/handler.ts'] }],
      { service: { when: { content: '@Injectable' } } },
    );
    const cache = new FileContentCache();
    const { issues } = await checkTypeWhenMismatch(graph, cache);
    expect(issues.filter((i) => i.code === 'type-when-mismatch')).toHaveLength(1);
  });

  it('plain entry satisfying when -> no mismatch', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/handler.ts'), '@Injectable()\nexport class H {}');
    const graph = buildGraph(
      yggRoot,
      [{ path: 'svc', type: 'service', mapping: ['src/handler.ts'] }],
      { service: { when: { content: '@Injectable' } } },
    );
    const cache = new FileContentCache();
    const { issues } = await checkTypeWhenMismatch(graph, cache);
    expect(issues.filter((i) => i.code === 'type-when-mismatch')).toHaveLength(0);
  });

  it('type without a when predicate is skipped entirely (no mismatch even when mapping has odd files)', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/anything.cs'), 'class X {}');
    const graph = buildGraph(
      yggRoot,
      [{ path: 'svc', type: 'organizational', mapping: ['src/repo/*.cs'] }],
      { organizational: {} }, // no when
    );
    const cache = new FileContentCache();
    const { issues } = await checkTypeWhenMismatch(graph, cache);
    expect(issues.filter((i) => i.code === 'type-when-mismatch')).toHaveLength(0);
  });

  it('** glob expands across directories and each matched file is when-checked', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/a/FooRepository.cs'), 'class Foo {}');
    await writeFileEnsuringDir(path.join(projectRoot, 'src/a/b/BarRepository.cs'), 'class Bar {}');
    await writeFileEnsuringDir(path.join(projectRoot, 'src/a/b/Helper.cs'), 'class Helper {}'); // violates when
    const graph = buildGraph(
      yggRoot,
      [{ path: 'svc', type: 'repo', mapping: ['src/**/*.cs'] }],
      { repo: { when: { path: '**/*Repository.cs' } } },
    );
    const cache = new FileContentCache();
    const { issues } = await checkTypeWhenMismatch(graph, cache);
    const mismatches = issues.filter((i) => i.code === 'type-when-mismatch');
    // Only Helper.cs violates the when predicate.
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].messageData.what).toContain('src/a/b/Helper.cs');
  });
});

// =============================================================================
// checkMappingPathsExist — glob (matches-nothing) + allPathsMissing(glob)
// =============================================================================

describe('checkMappingPathsExist — glob entries', () => {
  it('glob matching ZERO files on disk -> mapping-path-missing', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/Helper.cs'), 'class Helper {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/repo/*Repository.cs'] }, // matches nothing
    ]);
    const issues = await checkMappingPathsExist(graph);
    const missing = issues.filter((i) => i.code === 'mapping-path-missing');
    expect(missing).toHaveLength(1);
    expect(missing[0].nodePath).toBe('svc');
    expect(missing[0].messageData.what).toContain('src/repo/*Repository.cs');
  });

  it('glob matching at least ONE file -> NOT missing (allPathsMissing returns false for the glob)', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/repo/*Repository.cs'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    expect(issues.filter((i) => i.code === 'mapping-path-missing')).toHaveLength(0);
  });

  it('glob whose base directory does not exist at all -> mapping-path-missing', async () => {
    const { yggRoot } = await makeProject();
    // No files written; src/ does not exist.
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/**/*.ts'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    expect(issues.filter((i) => i.code === 'mapping-path-missing')).toHaveLength(1);
  });

  it('** glob matching one deep file -> not missing', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/a/b/c.ts'), 'export {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/**/*.ts'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    expect(issues.filter((i) => i.code === 'mapping-path-missing')).toHaveLength(0);
  });

  it('mixed mapping: a present plain file + a glob that matches nothing -> exactly one missing (the glob)', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/index.ts'), 'export {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/index.ts', 'src/repo/*Repository.cs'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    const missing = issues.filter((i) => i.code === 'mapping-path-missing');
    expect(missing).toHaveLength(1);
    expect(missing[0].messageData.what).toContain('src/repo/*Repository.cs');
  });

  it('plain present file -> no missing (backward compat)', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/index.ts'), 'export {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/index.ts'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    expect(issues.filter((i) => i.code === 'mapping-path-missing')).toHaveLength(0);
  });

  it('plain MISSING file -> mapping-path-missing (backward compat)', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/ghost.ts'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    const missing = issues.filter((i) => i.code === 'mapping-path-missing');
    expect(missing).toHaveLength(1);
    expect(missing[0].messageData.what).toContain('src/ghost.ts');
  });

  it('plain present DIRECTORY -> no missing (fileAccess succeeds on a directory)', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/feature/x.ts'), 'export {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/feature'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    expect(issues.filter((i) => i.code === 'mapping-path-missing')).toHaveLength(0);
  });

  it('two distinct glob entries each matching nothing -> two mapping-path-missing', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/Helper.cs'), 'class Helper {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/repo/*Repository.cs', 'src/svc/*Service.cs'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    expect(issues.filter((i) => i.code === 'mapping-path-missing')).toHaveLength(2);
  });
});
