/**
 * Bounty 2 — exhaustive branch coverage for the file-matching logic of:
 *   - checkMappingOverlap   (src/core/checks/mapping.ts)
 *   - checkMappingPathsExist(src/core/checks/mapping.ts)
 *
 * Every if / branch / ternary / early-return in those two functions is
 * exercised, both sides of every boolean:
 *
 * checkMappingOverlap — STRING pass (pairwise literal compare):
 *   - empty mapping entry dropped (length-0 filter)               [setup branch]
 *   - same node skip            (current.nodePath === candidate.nodePath)
 *   - disjoint skip             (!arePathsOverlapping; both sub-branches)
 *   - exact-equal               -> file-duplicate-mapping (continue)
 *   - containment, non-hierarchical -> overlapping-mapping
 *   - containment, ancestor->descendant ALLOWED (isHierarchical, dir A)
 *   - containment, descendant->ancestor ALLOWED (isHierarchical, dir B)
 *
 * checkMappingOverlap — GLOB file-level pass:
 *   - anyGlob === false -> whole pass skipped
 *   - anyGlob === true  -> pass runs
 *   - owners.length < 2 -> skip
 *   - owners.length >= 2 but !viaGlob -> skip (both plain owners)
 *   - viaGlob true, leaves < 2 (child-wins prunes ancestor) -> skip
 *   - viaGlob true, leaves >= 2 -> overlapping-mapping (+ reported dedup)
 *   - reported dedup: a file matched by two globs reports exactly once
 *
 * checkMappingPathsExist:
 *   - glob entry, matches >= 1  -> OK
 *   - glob entry, matches 0     -> mapping-path-missing
 *   - plain entry exists        -> OK (file and directory)
 *   - plain entry missing       -> mapping-path-missing
 *
 * E2E: the glob file-level overlap path AND the missing-path path are both
 * reachable through `yg check`, so a spawnSync test against a copy of the
 * e2e-lifecycle fixture confirms the end-to-end CLI contract.
 *
 * Determinism: every graph is backed by a fresh mkdtemp temp tree, cleaned in a
 * finally / afterEach. No random data; the wall clock is never read inside an
 * assertion. The repo's own files / src / .yggdrasil are never touched.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkMappingOverlap,
  checkMappingPathsExist,
} from '../../../src/core/checks/mapping.js';
import type { ValidationIssue } from '../../../src/model/validation.js';
import type {
  Graph,
  GraphNode,
  ArchitectureNodeType,
} from '../../../src/model/graph.js';

// --- temp-dir lifecycle ------------------------------------------------------

const tmpRoots: string[] = [];

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Fresh isolated project. `yggRoot` is what Graph.rootPath points at;
 * path.dirname(rootPath) is the projectRoot the validators walk.
 */
async function makeProject(): Promise<{ projectRoot: string; yggRoot: string }> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-bounty2-overlap-'));
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

/**
 * Build an inline Graph rooted at yggRoot. Insertion order into the Map is the
 * order given (some checks rely on graph insertion order). Parent links are
 * wired from `parent`.
 */
function buildGraph(yggRoot: string, nodes: NodeSpec[]): Graph {
  const node_types: Record<string, ArchitectureNodeType> = {};
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

function codes(issues: ValidationIssue[]): string[] {
  return issues.map((i) => i.code).filter((c): c is string => c !== undefined);
}
function overlaps(issues: ValidationIssue[]) {
  return issues.filter((i) => i.code === 'overlapping-mapping');
}
function missing(issues: ValidationIssue[]) {
  return issues.filter((i) => i.code === 'mapping-path-missing');
}

// =============================================================================
// checkMappingOverlap — STRING pass (literal pairwise compare, no glob)
// =============================================================================

describe('checkMappingOverlap — string pass: setup + skip branches', () => {
  it('empty / whitespace-only mapping entries are dropped (length-0 filter) — no overlap', async () => {
    const { yggRoot } = await makeProject();
    // '' and '   ' normalize to '' and are filtered out before pairing, so the
    // two nodes have no comparable entries and nothing overlaps.
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['', '   '] },
      { path: 'b', mapping: [''] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });

  it('two entries within the SAME node never conflict (same-node skip branch)', async () => {
    const { yggRoot } = await makeProject();
    // 'src/x' and 'src/x/y.ts' overlap by containment, but they belong to ONE
    // node — the current.nodePath === candidate.nodePath guard skips the pair.
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/x', 'src/x/y.ts'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });

  it('disjoint mappings in different nodes -> !arePathsOverlapping skip', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/a'] },
      { path: 'b', mapping: ['src/b'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });

  it('string-prefix that is NOT a path-segment boundary does NOT overlap (arePathsOverlapping false branch)', async () => {
    const { yggRoot } = await makeProject();
    // 'src/feature' is a prefix of 'src/feature-2' but not at a '/' boundary, so
    // neither startsWith(other + '/') holds — arePathsOverlapping returns false.
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/feature'] },
      { path: 'b', mapping: ['src/feature-2'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });
});

describe('checkMappingOverlap — string pass: report branches', () => {
  it('two non-hierarchical nodes mapping the SAME exact file -> file-duplicate-mapping', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/shared.ts'] },
      { path: 'b', mapping: ['src/shared.ts'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(codes(issues)).toContain('file-duplicate-mapping');
    // equal-path branch `continue`s, so no overlapping-mapping for this pair.
    expect(codes(issues)).not.toContain('overlapping-mapping');
    const dup = issues.find((i) => i.code === 'file-duplicate-mapping')!;
    expect(dup.nodePath).toBe('b'); // candidate.nodePath
    expect(dup.messageData.what).toContain('src/shared.ts');
  });

  it('normalization (leading ./ + trailing /) folds two spellings of one file -> duplicate', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['./src/shared.ts'] },
      { path: 'b', mapping: ['src/shared.ts/'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(codes(issues)).toContain('file-duplicate-mapping');
  });

  it('two non-hierarchical nodes with containment overlap -> overlapping-mapping (isHierarchical false)', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/feature'] },
      { path: 'b', mapping: ['src/feature/sub'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(codes(issues)).toContain('overlapping-mapping');
    expect(codes(issues)).not.toContain('file-duplicate-mapping');
    const ov = overlaps(issues)[0];
    expect(ov.nodePath).toBe('b'); // candidate.nodePath
    expect(ov.messageData.what).toContain('src/feature');
    expect(ov.messageData.what).toContain('src/feature/sub');
  });

  it('ancestor -> descendant containment is ALLOWED (isHierarchical via isAncestorNode(current, candidate))', async () => {
    const { yggRoot } = await makeProject();
    // current=parent (src/feature), candidate=parent/child (src/feature/sub):
    // isAncestorNode('parent','parent/child') is true -> hierarchical -> skip.
    const graph = buildGraph(yggRoot, [
      { path: 'parent', mapping: ['src/feature'] },
      { path: 'parent/child', mapping: ['src/feature/sub'], parent: 'parent' },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });

  it('descendant -> ancestor containment is ALLOWED (isHierarchical via the OTHER direction)', async () => {
    const { yggRoot } = await makeProject();
    // Insertion order child-first so `current`=child, `candidate`=parent: this
    // exercises isAncestorNode(candidate.nodePath, current.nodePath) — the second
    // disjunct of isHierarchical.
    const graph = buildGraph(yggRoot, [
      { path: 'parent/child', mapping: ['src/feature/sub'], parent: 'parent' },
      { path: 'parent', mapping: ['src/feature'] },
    ]);
    // wire parent link explicitly (buildGraph wires from `parent` field above)
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });

  it('descendant node with a BROADER mapping than its ancestor is exempt (child-precedence: deeper node wins)', async () => {
    // Child-precedence (child-wins): the deeper node owns the shared files even
    // when it maps a broader path than its ancestor. The runtime carve-out
    // (getChildMappingExclusions, glob-aware) removes the overlap from the
    // ancestor's subject set, so ownership is unambiguous and this is not flagged.
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'parent', mapping: ['src/feature/sub'] },
      { path: 'parent/child', mapping: ['src/feature'], parent: 'parent' },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(codes(issues)).not.toContain('overlapping-mapping');
  });

  it('ancestor-descendant mapping the SAME exact file STILL flags file-duplicate-mapping (equal branch runs before hierarchy check)', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'parent', mapping: ['src/feature/file.ts'] },
      { path: 'parent/child', mapping: ['src/feature/file.ts'], parent: 'parent' },
    ]);
    const issues = await checkMappingOverlap(graph);
    // The equal-path branch `continue`s BEFORE the isHierarchical exemption.
    expect(codes(issues)).toContain('file-duplicate-mapping');
  });
});

// =============================================================================
// checkMappingOverlap — GLOB file-level pass
// =============================================================================

describe('checkMappingOverlap — glob pass: gate (anyGlob)', () => {
  it('anyGlob === false: glob-free graph never runs the FS pass (string-pass result only, no duplicate report)', async () => {
    const { yggRoot } = await makeProject();
    // Two siblings overlap by containment -> exactly one overlapping-mapping from
    // the string pass. With no glob entry, the FS pass is skipped entirely, so it
    // cannot add a second (duplicate) report.
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src'] },
      { path: 'b', mapping: ['src/inner'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(overlaps(issues)).toHaveLength(1);
  });

  it('anyGlob === true: pass runs — two non-hierarchical nodes claim one file (one via glob) -> overlapping-mapping', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/repo/*Repository.cs'] }, // glob owner
      { path: 'b', mapping: ['src/repo/FooRepository.cs'] }, // plain owner
    ]);
    const issues = await checkMappingOverlap(graph);
    const ov = overlaps(issues);
    expect(ov.length).toBeGreaterThanOrEqual(1);
    expect(ov.some((i) => i.messageData.what.includes('src/repo/FooRepository.cs'))).toBe(true);
    // nodePath is leaves[0]
    expect(ov[0].nodePath).toBeDefined();
  });
});

describe('checkMappingOverlap — glob pass: per-file skip branches', () => {
  it('owners.length < 2: a globbed file owned by only ONE node -> no overlap', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/Helper.cs'), 'class Helper {}');
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/repo/*Repository.cs'] }, // matches only FooRepository.cs
      { path: 'b', mapping: ['src/repo/Helper.cs'] }, // a DIFFERENT file
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(issues).toHaveLength(0);
  });

  it('owners.length >= 2 but !viaGlob: BOTH owners are plain, file also matched by an unrelated glob elsewhere -> no glob-pass overlap for that file', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    // shared.ts is owned by two PLAIN entries (a, b) -> the string pass reports
    // file-duplicate-mapping. The glob gate is on because node g has a glob, but
    // g's glob matches a DIFFERENT file (other.cs). For shared.ts the two owners
    // are both plain (viaGlob=false) so the glob pass adds NO overlapping-mapping.
    await writeFileEnsuringDir(path.join(projectRoot, 'src/shared.ts'), 'export {}');
    await writeFileEnsuringDir(path.join(projectRoot, 'src/lib/other.cs'), 'class Other {}');
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/shared.ts'] },
      { path: 'b', mapping: ['src/shared.ts'] },
      { path: 'g', mapping: ['src/lib/*.cs'] }, // glob, turns the gate on; owns other.cs alone
    ]);
    const issues = await checkMappingOverlap(graph);
    // String pass: shared.ts duplicate.
    expect(codes(issues)).toContain('file-duplicate-mapping');
    // Glob pass must NOT add an overlapping-mapping: shared.ts has 2 plain owners
    // (viaGlob=false), and other.cs has only 1 owner (owners<2).
    expect(overlaps(issues)).toHaveLength(0);
  });

  it('viaGlob true, leaves < 2: ancestor + descendant both claim a file via globs -> child-wins prunes ancestor -> no overlap', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/repo'] }, // ancestor (plain dir owner)
      { path: 'svc/repo', mapping: ['src/repo/*Repository.cs'], parent: 'svc' }, // descendant via glob
    ]);
    const issues = await checkMappingOverlap(graph);
    // owners = [svc, svc/repo] (2), viaGlob true; child-wins drops svc (ancestor of
    // svc/repo) leaving 1 leaf -> leaves.length < 2 -> skip.
    expect(overlaps(issues)).toHaveLength(0);
  });

  it('child-precedence: a child claiming a specific file inside a parent glob is exempt (child wins, no overlap)', async () => {
    // The maintainer's "special case in a globbed directory" pattern: the parent
    // globs src/*/y.ts and the graph-child claims the specific src/x/y.ts. The
    // child (deeper node) wins IMPLICITLY — the glob-aware runtime carve-out
    // removes src/x/y.ts from the parent's subject set — so this is NOT an overlap,
    // even though the child's entry is not string-nested in the parent's glob.
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/x/y.ts'), 'export {}');
    const graph = buildGraph(yggRoot, [
      { path: 'app', mapping: ['src/*/y.ts'] }, // ancestor via glob
      { path: 'app/x', mapping: ['src/x/y.ts'], parent: 'app' }, // descendant claims the specific file
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(overlaps(issues)).toHaveLength(0);
  });

  it('viaGlob true, leaves >= 2: two siblings + one ancestor claim a file -> ancestor pruned, siblings still conflict', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/repo'] }, // ancestor of svc/x — pruned
      { path: 'svc/x', mapping: ['src/repo/*Repository.cs'], parent: 'svc' }, // glob leaf
      { path: 'other', mapping: ['src/repo/FooRepository.cs'] }, // unrelated sibling leaf
    ]);
    const issues = await checkMappingOverlap(graph);
    const ov = overlaps(issues);
    expect(ov.length).toBeGreaterThanOrEqual(1);
    const what = ov.map((i) => i.messageData.what).join('\n');
    expect(what).toContain('svc/x');
    expect(what).toContain('other');
    // svc (the pruned ancestor) must not appear in the leaves list.
    expect(ov[0].messageData.what).not.toMatch(/\n {2}svc\n/);
  });
});

describe('checkMappingOverlap — glob pass: dedup', () => {
  it('reported dedup: a file claimed via TWO different globs reports overlapping-mapping exactly once', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/repo/*Repository.cs'] },
      { path: 'b', mapping: ['src/**/*.cs'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    // The `reported` set keys on the file path, so the single file is flagged once.
    expect(overlaps(issues)).toHaveLength(1);
  });

  it('two DISJOINT glob files each claimed by two siblings: two distinct overlap reports (one per file)', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/BarRepository.cs'), 'class Bar {}');
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/repo/*Repository.cs'] }, // claims both via glob
      { path: 'foo', mapping: ['src/repo/FooRepository.cs'] },
      { path: 'bar', mapping: ['src/repo/BarRepository.cs'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    // FooRepository.cs and BarRepository.cs each have two non-hierarchical owners.
    expect(overlaps(issues)).toHaveLength(2);
  });

  it('glob present but resolving to NO files on disk: glob pass produces no overlap', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/Helper.cs'), 'class Helper {}');
    const graph = buildGraph(yggRoot, [
      { path: 'a', mapping: ['src/repo/*Repository.cs'] }, // matches nothing
      { path: 'b', mapping: ['src/repo/Helper.cs'] },
    ]);
    const issues = await checkMappingOverlap(graph);
    expect(overlaps(issues)).toHaveLength(0);
  });
});

// =============================================================================
// checkMappingPathsExist — glob + plain
// =============================================================================

describe('checkMappingPathsExist — glob entries', () => {
  it('glob matching >= 1 file -> NO mapping-path-missing', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/FooRepository.cs'), 'class Foo {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/repo/*Repository.cs'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    expect(missing(issues)).toHaveLength(0);
  });

  it('glob matching 0 files (sibling files exist, none match) -> mapping-path-missing', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/Helper.cs'), 'class Helper {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/repo/*Repository.cs'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    const m = missing(issues);
    expect(m).toHaveLength(1);
    expect(m[0].nodePath).toBe('svc');
    expect(m[0].messageData.what).toContain('src/repo/*Repository.cs');
    expect(m[0].messageData.what).toContain('matches no files on disk');
  });

  it('glob whose base directory does not exist at all -> mapping-path-missing', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/**/*.ts'] }, // src/ never created
    ]);
    const issues = await checkMappingPathsExist(graph);
    expect(missing(issues)).toHaveLength(1);
  });

  it('** glob matching one deep file -> not missing', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/a/b/c.ts'), 'export {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/**/*.ts'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    expect(missing(issues)).toHaveLength(0);
  });
});

describe('checkMappingPathsExist — plain entries', () => {
  it('plain present file -> no missing (fileAccess resolves)', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/index.ts'), 'export {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/index.ts'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    expect(missing(issues)).toHaveLength(0);
  });

  it('plain present DIRECTORY -> no missing (fileAccess succeeds on a directory)', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/feature/x.ts'), 'export {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/feature'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    expect(missing(issues)).toHaveLength(0);
  });

  it('plain MISSING file -> mapping-path-missing (fileAccess throws)', async () => {
    const { yggRoot } = await makeProject();
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/ghost.ts'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    const m = missing(issues);
    expect(m).toHaveLength(1);
    expect(m[0].nodePath).toBe('svc');
    expect(m[0].messageData.what).toContain('src/ghost.ts');
    expect(m[0].messageData.what).toContain('does not exist on disk');
  });

  it('mixed mapping: present plain file + glob matching nothing -> exactly one missing (the glob)', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/index.ts'), 'export {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/index.ts', 'src/repo/*Repository.cs'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    const m = missing(issues);
    expect(m).toHaveLength(1);
    expect(m[0].messageData.what).toContain('src/repo/*Repository.cs');
  });

  it('two distinct glob entries each matching nothing -> two mapping-path-missing', async () => {
    const { projectRoot, yggRoot } = await makeProject();
    await writeFileEnsuringDir(path.join(projectRoot, 'src/repo/Helper.cs'), 'class Helper {}');
    const graph = buildGraph(yggRoot, [
      { path: 'svc', mapping: ['src/repo/*Repository.cs', 'src/svc/*Service.cs'] },
    ]);
    const issues = await checkMappingPathsExist(graph);
    expect(missing(issues)).toHaveLength(2);
  });
});

// =============================================================================
// E2E — the glob overlap path AND the missing-path path through `yg check`.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-bounty2-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const ordersNodePath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');

describe.skipIf(!distExists)('checkMappingOverlap / checkMappingPathsExist — E2E via yg check', () => {
  it('glob-pass overlap: two sibling service nodes claim one file via a glob -> overlapping-mapping (exit 1)', () => {
    const dir = copyFixture('glob-overlap');
    try {
      // orders globs ALL service .ts files — which includes payments.ts, already
      // owned (exactly) by the sibling payments node. payments.ts now has two
      // non-hierarchical owners — only the glob file-level pass can see this.
      const y = readFileSync(ordersNodePath(dir), 'utf-8').replace(
        'src/services/orders.ts',
        'src/services/*.ts',
      );
      writeFileSync(ordersNodePath(dir), y, 'utf-8');
      const { all, status } = run(['check'], dir);
      expect(all).toContain('overlapping-mapping');
      expect(status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mapping-path-missing: a glob mapping that resolves to nothing -> mapping-path-missing (exit 1)', () => {
    const dir = copyFixture('glob-missing');
    try {
      // orders maps a glob that matches no file under src/services.
      const y = readFileSync(ordersNodePath(dir), 'utf-8').replace(
        'src/services/orders.ts',
        'src/services/*Repository.ts',
      );
      writeFileSync(ordersNodePath(dir), y, 'utf-8');
      const { all, status } = run(['check'], dir);
      expect(all).toContain('mapping-path-missing');
      expect(status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mapping-path-missing: a plain mapping to a deleted file -> mapping-path-missing (exit 1)', () => {
    const dir = copyFixture('plain-missing');
    try {
      // Point orders at a file that does not exist on disk.
      const y = readFileSync(ordersNodePath(dir), 'utf-8').replace(
        'src/services/orders.ts',
        'src/services/ghost.ts',
      );
      writeFileSync(ordersNodePath(dir), y, 'utf-8');
      const { all, status } = run(['check'], dir);
      expect(all).toContain('mapping-path-missing');
      expect(all).toContain('src/services/ghost.ts');
      expect(status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
