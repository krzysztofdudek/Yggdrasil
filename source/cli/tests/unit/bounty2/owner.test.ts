/**
 * Bug-bounty (bounty2): EXHAUSTIVE branch coverage of findOwner + `yg owner`.
 *
 * Target: src/cli/owner.ts
 *
 *   findOwner(graph, projectRoot, rawPath): OwnerResult
 *     - line 18: normalizeForMatch(normalizeProjectRelativePath(...)) — input
 *       normalization + project-root guard (throws on empty / escape).
 *     - line 22-24: normalizeMappingPaths(...).map(normalizeForMatch)
 *       .filter(len > 0) — blank / whitespace entries are dropped.
 *     - line 27: isGlobPattern(mappingPath) — TRUE branch (glob) vs FALSE branch
 *       (plain). Both sides exercised.
 *     - GLOB branch (27-33):
 *         * line 28: mappingEntryMatchesFile TRUE vs FALSE.
 *         * line 30: !best (first match) vs mappingPath.length > best.length
 *           (longer glob replaces) vs equal/shorter glob (kept) — all 3 arms.
 *         * sets exact:true => result.direct === true.
 *     - PLAIN branch (34-42):
 *         * line 35: file === mappingPath -> EARLY RETURN { direct:true }.
 *         * line 38: file.startsWith(mappingPath + '/') TRUE vs FALSE
 *           (non-boundary prefix must NOT match).
 *         * line 39: !best vs length > best.length vs equal/shorter — all 3 arms.
 *         * sets exact:false => result.direct === false (indirect).
 *     - line 47-49: best ? {...direct:best.exact} : { nodePath:null } — both
 *       ternary arms; the null arm carries no mappingPath / direct.
 *     - precedence: plain-exact early return beats any provisional glob `best`.
 *
 *   registerOwnerCommand action (52-104) output branches — exercised E2E by
 *   spawning the built binary against a temp copy of the e2e-lifecycle fixture:
 *     - line 65 !result.nodePath FALSE => "<file> -> <node>" (owned).
 *         * line 89 direct === false && mappingPath => indirect buildIssueMessage
 *           block ("File has no direct mapping." + ancestor dir + yg context).
 *         * direct === true => NO indirect block.
 *     - line 65 !result.nodePath TRUE => no-coverage; line 70 exists branch:
 *         * exists === true  => "no graph coverage" (mappable existing file).
 *         * exists === false => "no graph coverage (file not found)".
 *
 * This file is independent of tests/unit/bounty/path-ownership.test.ts — it adds
 * the per-arm `best`-replacement enumeration and the full CLI output-branch E2E
 * matrix (the existing bounty covers the matcher in isolation, not the command's
 * four rendered output paths).
 *
 * Determinism: no random data, no wall-clock reads inside assertions, every temp
 * dir cleaned in a finally. Pure findOwner tests do NO disk I/O (they read an
 * in-memory graph); the E2E tests build a fresh temp fixture per case.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Graph, GraphNode } from '../../../src/model/graph.js';
import { findOwner } from '../../../src/cli/owner.js';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory graph builders. findOwner reads only graph.nodes (a Map whose
// insertion order is the iteration order) — no filesystem access.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = '/workspace/project';

function makeNode(nodePath: string, mapping: string[]): GraphNode {
  return {
    path: nodePath,
    meta: { name: nodePath, type: 'service', mapping },
    children: [],
    parent: null,
  } as GraphNode;
}

function makeGraph(nodes: Array<[string, GraphNode]>): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(nodes),
    aspects: [],
    flows: [],
    rootPath: `${ROOT}/.yggdrasil`,
  } as unknown as Graph;
}

/** Build a graph from [nodePath, mappingPaths] pairs; declaration order = Map order. */
function graphOf(...entries: Array<[string, string[]]>): Graph {
  return makeGraph(entries.map(([p, m]) => [p, makeNode(p, m)] as [string, GraphNode]));
}

// ═════════════════════════════════════════════════════════════════════════════
// BRANCH: isGlobPattern FALSE -> plain branch -> line 35 file === mappingPath
//         => EARLY RETURN { direct:true } (the short-circuit).
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — plain branch: exact match early-returns direct:true', () => {
  it('exact file mapping returns direct:true and the matched file', () => {
    const g = graphOf(['svc/v', ['src/core/validator.ts']]);
    const r = findOwner(g, ROOT, 'src/core/validator.ts');
    expect(r.nodePath).toBe('svc/v');
    expect(r.mappingPath).toBe('src/core/validator.ts');
    expect(r.direct).toBe(true);
    expect(r.file).toBe('src/core/validator.ts');
  });

  it('querying a directory mapping entry EXACTLY is the exact branch (direct:true), not the prefix branch', () => {
    const g = graphOf(['n', ['src/core']]);
    const r = findOwner(g, ROOT, 'src/core');
    expect(r.nodePath).toBe('n');
    expect(r.direct).toBe(true);
  });

  it('the early return wins even if an EARLIER node provisionally set a glob best', () => {
    // The glob node is iterated first (sets best.exact=true provisionally), but
    // the later exact match hits `return` immediately — proving the return is a
    // hard short-circuit, not a "best so far".
    const g = graphOf(['glob', ['src/**/*.ts']], ['exact', ['src/a/file.ts']]);
    const r = findOwner(g, ROOT, 'src/a/file.ts');
    expect(r.nodePath).toBe('exact');
    expect(r.mappingPath).toBe('src/a/file.ts');
    expect(r.direct).toBe(true);
  });

  it('exact match wins over a LONGER glob string (exact beats length, via early return)', () => {
    const g = graphOf(['glob', ['src/deeply/nested/**/*.ts']], ['exact', ['src/x.ts']]);
    const r = findOwner(g, ROOT, 'src/x.ts');
    expect(r.nodePath).toBe('exact');
    expect(r.direct).toBe(true);
  });

  it('exact match wins over a directory prefix that also covers the file', () => {
    const g = graphOf(['dir', ['src']], ['file', ['src/a.ts']]);
    const r = findOwner(g, ROOT, 'src/a.ts');
    expect(r.nodePath).toBe('file');
    expect(r.direct).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BRANCH: plain branch -> line 38 file.startsWith(mappingPath + '/')
//         TRUE  => directory-prefix => best, exact:false (indirect)
//         FALSE => non-boundary prefix must NOT match.
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — plain branch: directory-prefix is indirect (direct:false)', () => {
  it('a file inside a mapped directory is indirect', () => {
    const g = graphOf(['svc/core', ['src/core']]);
    const r = findOwner(g, ROOT, 'src/core/validator.ts');
    expect(r.nodePath).toBe('svc/core');
    expect(r.mappingPath).toBe('src/core');
    expect(r.direct).toBe(false);
  });

  it('a deeply nested file under a mapped directory is still indirect', () => {
    const g = graphOf(['n', ['src']]);
    const r = findOwner(g, ROOT, 'src/a/b/c/deep.ts');
    expect(r.nodePath).toBe('n');
    expect(r.direct).toBe(false);
  });

  it('line 38 FALSE: a non-boundary prefix does NOT confer ownership', () => {
    // 'src/handle' is a string prefix of 'src/handlers/...' but NOT a directory
    // boundary (no following '/'), so startsWith(mappingPath + '/') is false.
    const g = graphOf(['n', ['src/handle']]);
    expect(findOwner(g, ROOT, 'src/handlers/order.ts').nodePath).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BRANCH: isGlobPattern TRUE -> glob branch -> line 28 mappingEntryMatchesFile
//         TRUE  => best.exact=true (direct)
//         FALSE => no update.
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — glob branch: a glob match is treated as direct:true', () => {
  it('a single-segment * glob match is direct', () => {
    const g = graphOf(['n', ['src/*.ts']]);
    const r = findOwner(g, ROOT, 'src/a.ts');
    expect(r.nodePath).toBe('n');
    expect(r.mappingPath).toBe('src/*.ts');
    expect(r.direct).toBe(true);
  });

  it('a suffix glob (*Repository.cs) matches a qualifying file as direct', () => {
    const g = graphOf(['repo', ['src/db/*Repository.cs']]);
    const r = findOwner(g, ROOT, 'src/db/FooRepository.cs');
    expect(r.nodePath).toBe('repo');
    expect(r.direct).toBe(true);
  });

  it('line 28 FALSE: a glob that does not match leaves the file unowned', () => {
    const g = graphOf(['repo', ['src/db/*Repository.cs']]);
    expect(findOwner(g, ROOT, 'src/db/Helper.cs').nodePath).toBeNull();
  });

  it('a ** glob matches at any depth (direct)', () => {
    const g = graphOf(['n', ['src/**/*.ts']]);
    expect(findOwner(g, ROOT, 'src/index.ts').direct).toBe(true);
    const deep = findOwner(g, ROOT, 'src/a/b/c.ts');
    expect(deep.nodePath).toBe('n');
    expect(deep.direct).toBe(true);
  });

  it('* does not cross a separator; ** does', () => {
    const star = graphOf(['n', ['src/*.ts']]);
    const dstar = graphOf(['n', ['src/**/*.ts']]);
    expect(findOwner(star, ROOT, 'src/a/b.ts').nodePath).toBeNull();
    expect(findOwner(dstar, ROOT, 'src/a/b.ts').nodePath).toBe('n');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BRANCH: line 30 / line 39 — the `best` replacement decision, ALL THREE ARMS:
//   (A) !best                                        -> first candidate adopted
//   (B) mappingPath.length >  best.mappingPath.length -> longer replaces
//   (C) mappingPath.length <= best.mappingPath.length -> kept (NO overwrite)
// Tested for the GLOB side (line 30) and the PLAIN-prefix side (line 39).
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — best replacement on the GLOB side (line 30)', () => {
  it('arm A (!best): first glob match is adopted', () => {
    const g = graphOf(['n', ['src/*.ts']]);
    expect(findOwner(g, ROOT, 'src/a.ts').nodePath).toBe('n');
  });

  it('arm B (longer > best): a longer glob replaces a shorter glob — order shorter-first', () => {
    const g = graphOf(['short', ['src/**']], ['long', ['src/**/*.ts']]);
    const r = findOwner(g, ROOT, 'src/a/b.ts');
    expect(r.nodePath).toBe('long');
    expect(r.mappingPath).toBe('src/**/*.ts');
    expect(r.direct).toBe(true);
  });

  it('arm B holds regardless of declaration order — longer glob declared FIRST still wins', () => {
    const g = graphOf(['long', ['src/**/*.ts']], ['short', ['src/**']]);
    expect(findOwner(g, ROOT, 'src/a/b.ts').nodePath).toBe('long');
  });

  it('arm C (equal length): the lexicographically-smaller node path wins the tie (declared first here)', () => {
    // 'g1' glob and 'g2' glob both equal-length and both match src/x.ts; the
    // tie is now broken DETERMINISTICALLY by lexicographic node path, so g1 (< g2) wins.
    const g = graphOf(['g1', ['src/*.ts']], ['g2', ['src/*.ts']]);
    const r = findOwner(g, ROOT, 'src/x.ts');
    expect(r.nodePath).toBe('g1');
    expect(r.mappingPath).toBe('src/*.ts');
  });

  it('arm C: reversing order does NOT flip the winner — the tie break is deterministic-lexicographic', () => {
    // Tie break is now lexicographic node path (was order-dependent — fixed bug): g1 (< g2)
    // wins regardless of declaration order, proving determinism.
    const g = graphOf(['g2', ['src/*.ts']], ['g1', ['src/*.ts']]);
    expect(findOwner(g, ROOT, 'src/x.ts').nodePath).toBe('g1'); // deterministic lexicographic tie-break since relation-conformance owner-index fix
  });

  it('arm C: a shorter later glob does NOT replace a longer earlier glob best', () => {
    const g = graphOf(['long', ['src/**/*.ts']], ['short', ['src/**']]);
    expect(findOwner(g, ROOT, 'src/a/b.ts').nodePath).toBe('long');
  });
});

describe('findOwner — best replacement on the PLAIN-prefix side (line 39)', () => {
  it('arm A (!best): first directory prefix is adopted', () => {
    const g = graphOf(['n', ['src']]);
    expect(findOwner(g, ROOT, 'src/a.ts').nodePath).toBe('n');
  });

  it('arm B (longer > best): the longer of two directory prefixes wins (more specific)', () => {
    const g = graphOf(['short', ['src']], ['long', ['src/core']]);
    const r = findOwner(g, ROOT, 'src/core/a.ts');
    expect(r.nodePath).toBe('long');
    expect(r.mappingPath).toBe('src/core');
    expect(r.direct).toBe(false);
  });

  it('arm B holds when the longer prefix is declared FIRST', () => {
    const g = graphOf(['long', ['src/core']], ['short', ['src']]);
    expect(findOwner(g, ROOT, 'src/core/a.ts').nodePath).toBe('long');
  });

  it('arm C (equal length): the lexicographically-smaller node path wins the tie deterministically', () => {
    // Tie break is now lexicographic node path (was order-dependent): a (< b) wins.
    const g = graphOf(['a', ['src/aaa']], ['b', ['src/aaa']]);
    const r = findOwner(g, ROOT, 'src/aaa/x.ts');
    expect(r.nodePath).toBe('a');
    expect(r.direct).toBe(false);
  });

  it('arm C: a shorter later prefix does NOT replace a longer earlier prefix best', () => {
    const g = graphOf(['long', ['src/core']], ['short', ['src']]);
    expect(findOwner(g, ROOT, 'src/core/a.ts').nodePath).toBe('long');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CROSS-KIND length comparison: a glob best and a plain-prefix best compete on
// raw string length only (the comparison is `mappingPath.length`, kind-agnostic).
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — glob vs plain-prefix compete on length only', () => {
  it('a longer glob beats a shorter directory prefix => direct:true', () => {
    // glob 'src/**/*.ts' (len 11) vs dir 'src' (len 3): glob wins, renders direct.
    const g = graphOf(['dir', ['src']], ['glob', ['src/**/*.ts']]);
    const r = findOwner(g, ROOT, 'src/a.ts');
    expect(r.nodePath).toBe('glob');
    expect(r.direct).toBe(true);
  });

  it('a longer directory prefix beats a shorter glob => direct:false', () => {
    // dir 's/a/b/c' (len 7) vs glob 's/*.ts' (len 6): dir wins, renders indirect.
    const g = graphOf(['glob', ['s/*.ts']], ['dir', ['s/a/b/c']]);
    const r = findOwner(g, ROOT, 's/a/b/c/x.ts');
    expect(r.nodePath).toBe('dir');
    expect(r.direct).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BRANCH: line 47-49 ternary — the FALSY arm (best === null) => { nodePath:null }.
// Also exercises line 22-24 filter (empty mapping, blank entries dropped).
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — no owner returns { nodePath:null }', () => {
  it('nothing maps the file => nodePath null, no mappingPath, no direct', () => {
    const g = graphOf(['svc/other', ['src/other/file.ts']]);
    const r = findOwner(g, ROOT, 'src/core/validator.ts');
    expect(r.nodePath).toBeNull();
    expect(r.mappingPath).toBeUndefined();
    expect(r.direct).toBeUndefined();
    expect(r.file).toBe('src/core/validator.ts');
  });

  it('an empty graph (no nodes) returns no owner', () => {
    expect(findOwner(makeGraph([]), ROOT, 'src/a.ts').nodePath).toBeNull();
  });

  it('a node with an empty mapping array owns nothing', () => {
    const g = graphOf(['n', []]);
    expect(findOwner(g, ROOT, 'src/a.ts').nodePath).toBeNull();
  });

  it('blank / whitespace-only mapping entries are filtered (len > 0) and own nothing', () => {
    const g = graphOf(['n', ['', '   ']]);
    expect(findOwner(g, ROOT, 'src/a.ts').nodePath).toBeNull();
  });

  it('the filter drops the blanks but a valid sibling entry still matches', () => {
    const g = graphOf(['n', ['', '   ', 'src/a.ts']]);
    const r = findOwner(g, ROOT, 'src/a.ts');
    expect(r.nodePath).toBe('n');
    expect(r.direct).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// INPUT NORMALIZATION & GUARDS (line 18 path normalization + throwing guards).
// ═════════════════════════════════════════════════════════════════════════════

describe('findOwner — input normalization and guards', () => {
  it('an absolute path inside the project root normalizes to project-relative', () => {
    const g = graphOf(['n', ['src/a.ts']]);
    const r = findOwner(g, ROOT, `${ROOT}/src/a.ts`);
    expect(r.file).toBe('src/a.ts');
    expect(r.nodePath).toBe('n');
    expect(r.direct).toBe(true);
  });

  it('a leading ./ on the query is stripped before matching', () => {
    const g = graphOf(['n', ['src/a.ts']]);
    const r = findOwner(g, ROOT, './src/a.ts');
    expect(r.nodePath).toBe('n');
    expect(r.file).toBe('src/a.ts');
  });

  it('throws for an empty path', () => {
    const g = graphOf(['n', ['src/a.ts']]);
    expect(() => findOwner(g, ROOT, '')).toThrow('Path cannot be empty');
  });

  it('throws for a path that escapes the project root', () => {
    const g = graphOf(['n', ['src/a.ts']]);
    expect(() => findOwner(g, ROOT, '../outside.ts')).toThrow('outside project root');
  });

  it('matching is case-sensitive', () => {
    const g = graphOf(['n', ['Src/A.ts']]);
    expect(findOwner(g, ROOT, 'src/a.ts').nodePath).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E2E — `yg owner` ACTION OUTPUT BRANCHES (registerOwnerCommand, lines 52-104).
// Each test copies the e2e-lifecycle fixture into a fresh temp dir, mutates it
// to drive ONE output branch, spawns the built binary, asserts the rendered
// text + exit code, and rmSync's the temp dir in a finally.
// ═════════════════════════════════════════════════════════════════════════════

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-owner2-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const ordersNodePath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');

describe.skipIf(!distExists)('CLI E2E — yg owner output branches', () => {
  it('OWNED DIRECT: an exact-mapped file prints "<file> -> <node>" with NO indirect block, exit 0', () => {
    const dir = copyFixture('direct');
    try {
      const { status, stdout } = run(['owner', '--file', 'src/services/orders.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('src/services/orders.ts -> services/orders');
      // direct:true => the indirect buildIssueMessage block must NOT render.
      expect(stdout).not.toContain('File has no direct mapping.');
      expect(stdout).not.toContain('Context comes from ancestor directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('OWNED INDIRECT: a file under a DIRECTORY mapping prints the no-direct-mapping block, exit 0', () => {
    const dir = copyFixture('indirect');
    try {
      // Remap the orders node to a DIRECTORY and place a file beneath it, so the
      // file is owned via directory-prefix (direct:false) — the indirect branch.
      mkdirSync(path.join(dir, 'src', 'services', 'sub'), { recursive: true });
      writeFileSync(
        path.join(dir, 'src', 'services', 'sub', 'deep.ts'),
        'export const x = 1;\n',
        'utf-8',
      );
      writeFileSync(
        ordersNodePath(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'mapping:',
          '  - src/services/sub',
          '',
        ].join('\n'),
        'utf-8',
      );
      const { status, stdout } = run(['owner', '--file', 'src/services/sub/deep.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('src/services/sub/deep.ts -> services/orders');
      expect(stdout).toContain('File has no direct mapping.');
      expect(stdout).toContain("Context comes from ancestor directory 'src/services/sub'.");
      expect(stdout).toContain('yg context --node services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NO COVERAGE (exists): an existing unmapped file prints "no graph coverage" (no "file not found"), exit 0', () => {
    const dir = copyFixture('exists');
    try {
      // A real on-disk file that no node maps -> exists === true branch.
      writeFileSync(path.join(dir, 'src', 'services', 'extra.ts'), 'export const y = 2;\n', 'utf-8');
      const { status, stdout } = run(['owner', '--file', 'src/services/extra.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('src/services/extra.ts -> no graph coverage');
      expect(stdout).not.toContain('file not found');
      expect(stdout).toContain('This file exists but no graph node maps it');
      // The components mapping other files in its directory are named as candidate owners.
      expect(stdout).toMatch(/src\/services\/extra\.ts -> no graph coverage\. (Candidate owners|No component maps anything in its directory)/);
      expect(stdout).toMatch(/Add 'src\/services\/extra\.ts' to the mapping|Create a node whose mapping covers 'src\/services\/extra\.ts'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NO COVERAGE (not found): a nonexistent unmapped path prints "(file not found)", exit 0', () => {
    const dir = copyFixture('notfound');
    try {
      const { status, stdout } = run(['owner', '--file', 'src/services/ghost.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('src/services/ghost.ts -> no graph coverage (file not found)');
      expect(stdout).toContain('This path does not exist on disk and is not mapped');
      expect(stdout).toContain('Check the path for typos');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('required-option guard: omitting --file exits non-zero and complains about --file', () => {
    const dir = copyFixture('reqopt');
    try {
      const { status, stderr } = run(['owner'], dir);
      expect(status).toBe(1);
      expect(stderr).toMatch(/required option|--file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GLOB ownership through the CLI: a glob-mapped file resolves to its node, direct (no indirect block)', () => {
    const dir = copyFixture('glob');
    try {
      // Remap orders via a glob that still matches orders.ts.
      writeFileSync(
        ordersNodePath(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'mapping:',
          '  - src/services/order*.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      const { status, stdout } = run(['owner', '--file', 'src/services/orders.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('src/services/orders.ts -> services/orders');
      // Glob match is treated as direct => no indirect block.
      expect(stdout).not.toContain('File has no direct mapping.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
