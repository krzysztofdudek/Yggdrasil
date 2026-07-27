/**
 * Bug-bounty: exhaustive coverage of the path-coverage surface.
 *
 *   - scanUncoveredFiles (plain + glob mappings, .yggdrasil exclusion,
 *     nested-graph exclusion, sorting, multi-node union)
 *   - normalizeRoot ("/" → "", leading/trailing/double-slash, trim, backslash)
 *   - matchesRoot (whole-repo "", plain exact/prefix/sibling, glob ** and *)
 *   - partitionByCoverageTier (required/excluded, plain + glob roots,
 *     longest-match-wins, excluded-wins-equal-tie, require-nothing)
 *
 * These functions are pure (string math only — no filesystem I/O for the tier
 * helpers and scanUncoveredFiles), so in-memory graphs are used where possible.
 * The few loadGraph-backed cases use fresh mkdtemp dirs and rm them in finally;
 * the repo's own files are never touched.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  normalizeRoot,
  matchesRoot,
  partitionByCoverageTier,
  scanUncoveredFiles,
  scanGitignoredCoveredFiles,
} from '../../../src/core/check.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type { Graph, GraphNode, CoverageConfig } from '../../../src/model/graph.js';

// ── In-memory graph builder for scanUncoveredFiles ────────────────────────────
// scanUncoveredFiles reads only: graph.nodes (node.meta.mapping), graph.rootPath
// (string math: path.dirname + path.relative), and the gitTrackedFiles arg.
// No filesystem access, so a synthetic graph is exact and side-effect-free.
function graphWithMappings(mappings: string[][], rootPath = '/repo/.yggdrasil'): Graph {
  const nodes = new Map<string, GraphNode>();
  mappings.forEach((mapping, i) => {
    nodes.set(`n${i}`, {
      path: `n${i}`,
      meta: { name: `n${i}`, type: 'service', mapping },
      children: [],
      parent: null,
    } as unknown as GraphNode);
  });
  return { nodes, rootPath } as unknown as Graph;
}

const cov = (required: string[], excluded: string[]): CoverageConfig => ({ required, excluded, typeLevel: false });

// ──────────────────────────────────────────────────────────────────────────────
// normalizeRoot
// ──────────────────────────────────────────────────────────────────────────────

describe('normalizeRoot', () => {
  it('maps "/" to "" (whole repo)', () => {
    expect(normalizeRoot('/')).toBe('');
  });

  it('maps the empty string to ""', () => {
    expect(normalizeRoot('')).toBe('');
  });

  it('maps a whitespace-only string to ""', () => {
    expect(normalizeRoot('   ')).toBe('');
  });

  it('maps multiple leading slashes alone to ""', () => {
    expect(normalizeRoot('///')).toBe('');
  });

  it('leaves a clean plain root unchanged', () => {
    expect(normalizeRoot('services')).toBe('services');
    expect(normalizeRoot('a/b/c')).toBe('a/b/c');
  });

  it('strips a single leading slash', () => {
    expect(normalizeRoot('/services')).toBe('services');
  });

  it('strips a single trailing slash', () => {
    expect(normalizeRoot('services/')).toBe('services');
  });

  it('strips both leading and trailing slashes', () => {
    expect(normalizeRoot('/services/')).toBe('services');
    expect(normalizeRoot('/a/b/')).toBe('a/b');
  });

  it('strips multiple leading slashes', () => {
    expect(normalizeRoot('//services')).toBe('services');
    expect(normalizeRoot('///a/b')).toBe('a/b');
  });

  it('strips multiple trailing slashes', () => {
    expect(normalizeRoot('services//')).toBe('services');
    expect(normalizeRoot('a/b///')).toBe('a/b');
  });

  it('collapses internal double-slashes to single', () => {
    expect(normalizeRoot('services//nested')).toBe('services/nested');
    expect(normalizeRoot('a//b//c')).toBe('a/b/c');
  });

  it('collapses internal runs of three or more slashes', () => {
    expect(normalizeRoot('a///b')).toBe('a/b');
    expect(normalizeRoot('a////b')).toBe('a/b');
  });

  it('handles leading + internal + trailing slashes together', () => {
    expect(normalizeRoot('/services//nested/')).toBe('services/nested');
    expect(normalizeRoot('//a//b//')).toBe('a/b');
  });

  it('trims surrounding whitespace before normalizing', () => {
    expect(normalizeRoot('  services  ')).toBe('services');
    expect(normalizeRoot('  /a//b/  ')).toBe('a/b');
  });

  it('converts backslashes to forward slashes (Windows-native input)', () => {
    expect(normalizeRoot('services\\nested')).toBe('services/nested');
    expect(normalizeRoot('\\services\\')).toBe('services');
  });

  it('is idempotent — normalizing an already-normalized root is a no-op', () => {
    for (const r of ['', 'services', 'a/b/c']) {
      expect(normalizeRoot(normalizeRoot(r))).toBe(normalizeRoot(r));
    }
  });

  it('preserves glob metacharacters (only slash/whitespace touched)', () => {
    expect(normalizeRoot('/src/**/*.ts')).toBe('src/**/*.ts');
    expect(normalizeRoot('services/*/api/**/')).toBe('services/*/api/**');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// matchesRoot
// ──────────────────────────────────────────────────────────────────────────────

describe('matchesRoot — whole-repo root', () => {
  it('empty root matches every file', () => {
    expect(matchesRoot('src/a.ts', '')).toBe(true);
    expect(matchesRoot('a.ts', '')).toBe(true);
    expect(matchesRoot('deeply/nested/path/file.txt', '')).toBe(true);
  });
});

describe('matchesRoot — plain roots', () => {
  it('matches an exact file/dir path', () => {
    expect(matchesRoot('services', 'services')).toBe(true);
  });

  it('matches a file directly under the root directory', () => {
    expect(matchesRoot('services/a.ts', 'services')).toBe(true);
  });

  it('matches a file nested deeply under the root directory', () => {
    expect(matchesRoot('services/auth/handler/x.ts', 'services')).toBe(true);
  });

  it('does NOT match a sibling whose name shares the root as a prefix', () => {
    expect(matchesRoot('services2/a.ts', 'services')).toBe(false);
    expect(matchesRoot('services-legacy/a.ts', 'services')).toBe(false);
  });

  it('does NOT match a parent of the root', () => {
    expect(matchesRoot('services', 'services/auth')).toBe(false);
  });

  it('does NOT match an unrelated path', () => {
    expect(matchesRoot('lib/b.ts', 'services')).toBe(false);
  });

  it('matches a nested plain root and its descendants', () => {
    expect(matchesRoot('services/auth', 'services/auth')).toBe(true);
    expect(matchesRoot('services/auth/x.ts', 'services/auth')).toBe(true);
    expect(matchesRoot('services/authz/x.ts', 'services/auth')).toBe(false);
  });
});

describe('matchesRoot — glob roots', () => {
  it('a leading ** glob matches files at any depth', () => {
    expect(matchesRoot('a/b/c.generated.ts', '**/*.generated.ts')).toBe(true);
    expect(matchesRoot('x.generated.ts', '**/*.generated.ts')).toBe(true);
    expect(matchesRoot('deeply/nested/x.generated.ts', '**/*.generated.ts')).toBe(true);
  });

  it('a ** glob does not match a file failing the trailing pattern', () => {
    expect(matchesRoot('a/b/c.ts', '**/*.generated.ts')).toBe(false);
  });

  it('a single-star glob stays within one path segment', () => {
    expect(matchesRoot('src/foo.ts', 'src/*.ts')).toBe(true);
    expect(matchesRoot('src/sub/foo.ts', 'src/*.ts')).toBe(false);
  });

  it('a single-star glob does not match a different extension', () => {
    expect(matchesRoot('src/foo.js', 'src/*.ts')).toBe(false);
  });

  it('a mid-path single-star matches exactly one intervening segment', () => {
    expect(matchesRoot('services/auth/api/h.ts', 'services/*/api/**')).toBe(true);
    expect(matchesRoot('services/auth/internal/x.ts', 'services/*/api/**')).toBe(false);
    // '*' cannot span two segments
    expect(matchesRoot('services/auth/sub/api/h.ts', 'services/*/api/**')).toBe(false);
  });

  it('a ** in the middle spans zero or more segments', () => {
    expect(matchesRoot('services/api/h.ts', 'services/**/h.ts')).toBe(true);
    expect(matchesRoot('services/a/b/h.ts', 'services/**/h.ts')).toBe(true);
  });

  it('a trailing-segment star matches dotfiles (dot:true)', () => {
    expect(matchesRoot('src/.eslintrc.ts', 'src/*.ts')).toBe(true);
  });

  it('a ** glob matches a dotfile segment in the path (dot:true)', () => {
    expect(matchesRoot('.github/workflows/ci.yml', '**/*.yml')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// partitionByCoverageTier — plain roots
// ──────────────────────────────────────────────────────────────────────────────

describe('partitionByCoverageTier — default whole-repo', () => {
  it('required ["/"] puts every uncovered file in the error tier', () => {
    const r = partitionByCoverageTier(['src/a.ts', 'lib/b.ts'], cov(['/'], []));
    expect(r.required.sort()).toEqual(['lib/b.ts', 'src/a.ts']);
    expect(r.middle).toEqual([]);
  });

  it('empty uncovered list yields empty tiers', () => {
    const r = partitionByCoverageTier([], cov(['/'], []));
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual([]);
  });
});

describe('partitionByCoverageTier — require-nothing', () => {
  it('empty required → every uncovered file is a non-blocking warning', () => {
    const r = partitionByCoverageTier(['src/a.ts', 'lib/b.ts'], cov([], []));
    expect(r.required).toEqual([]);
    expect(r.middle.sort()).toEqual(['lib/b.ts', 'src/a.ts']);
  });

  it('empty required + excluded → excluded silent, the rest warn', () => {
    const r = partitionByCoverageTier(['src/a.ts', 'vendor/c.ts'], cov([], ['vendor/']));
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual(['src/a.ts']);
  });

  it('empty required + excluded "/" (whole repo silent) → nothing surfaces', () => {
    const r = partitionByCoverageTier(['src/a.ts', 'lib/b.ts'], cov([], ['/']));
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual([]);
  });
});

describe('partitionByCoverageTier — scoped required + excluded', () => {
  it('required-matching → error tier, no-match → warning, excluded → dropped', () => {
    const r = partitionByCoverageTier(
      ['services/a.ts', 'lib/b.ts', 'vendor/c.ts'],
      cov(['services/'], ['vendor/']),
    );
    expect(r.required).toEqual(['services/a.ts']);
    expect(r.middle).toEqual(['lib/b.ts']);
  });

  it('a file matching neither required nor excluded falls to the middle (warning) tier', () => {
    const r = partitionByCoverageTier(['orphan/x.ts'], cov(['services/'], ['vendor/']));
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual(['orphan/x.ts']);
  });

  it('preserves input order within each tier (no internal sort)', () => {
    const r = partitionByCoverageTier(
      ['services/z.ts', 'services/a.ts', 'lib/z.ts', 'lib/a.ts'],
      cov(['services/'], []),
    );
    expect(r.required).toEqual(['services/z.ts', 'services/a.ts']);
    expect(r.middle).toEqual(['lib/z.ts', 'lib/a.ts']);
  });

  it('a file is never placed in both tiers', () => {
    const r = partitionByCoverageTier(
      ['services/a.ts', 'lib/b.ts'],
      cov(['services/'], []),
    );
    const all = [...r.required, ...r.middle];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('partitionByCoverageTier — longest-match-wins', () => {
  it('a more specific required root beats a broader required root', () => {
    const r = partitionByCoverageTier(
      ['services/auth/x.ts', 'services/billing/y.ts'],
      cov(['services/', 'services/auth/'], []),
    );
    expect(r.required.sort()).toEqual(['services/auth/x.ts', 'services/billing/y.ts']);
    expect(r.middle).toEqual([]);
  });

  it('a more specific excluded root beats a broader required root (file dropped)', () => {
    const r = partitionByCoverageTier(
      ['services/legacy/x.ts', 'services/a.ts'],
      cov(['services/'], ['services/legacy/']),
    );
    expect(r.required).toEqual(['services/a.ts']);
    expect(r.middle).toEqual([]);
  });

  it('a more specific required root beats a broader excluded root (file required)', () => {
    // excluded 'services/' (len 8), required 'services/api/' (len 12) → longer required wins
    const r = partitionByCoverageTier(
      ['services/api/h.ts', 'services/other/x.ts'],
      cov(['services/api/'], ['services/']),
    );
    expect(r.required).toEqual(['services/api/h.ts']);
    // services/other/x.ts matches only excluded → dropped
    expect(r.middle).toEqual([]);
  });
});

describe('partitionByCoverageTier — equal-length tie: excluded wins', () => {
  it('identical required and excluded root → excluded wins (silent)', () => {
    const r = partitionByCoverageTier(['foo/x.ts'], cov(['foo/'], ['foo/']));
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual([]);
  });

  it('required ["/"] and excluded ["/"] (both normalize to "") → excluded wins, all silent', () => {
    const r = partitionByCoverageTier(['a.ts', 'b/c.ts'], cov(['/'], ['/']));
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual([]);
  });

  it('two roots of equal length, one required one excluded → excluded wins', () => {
    // 'aaa/' and 'bbb/' both normalize to length 3; file under each
    const r = partitionByCoverageTier(
      ['aaa/x.ts', 'bbb/y.ts'],
      cov(['aaa/', 'bbb/'], ['bbb/']),
    );
    expect(r.required).toEqual(['aaa/x.ts']);
    expect(r.middle).toEqual([]); // bbb/y.ts excluded (tie → excluded)
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// partitionByCoverageTier — glob roots
// ──────────────────────────────────────────────────────────────────────────────

describe('partitionByCoverageTier — glob roots', () => {
  it('an excluded glob drops generated files anywhere; the rest keep their tier', () => {
    const r = partitionByCoverageTier(
      ['src/a.ts', 'src/x.generated.ts', 'lib/y.generated.ts'],
      cov(['/'], ['**/*.generated.ts']),
    );
    expect(r.required).toEqual(['src/a.ts']);
    expect(r.middle).toEqual([]);
  });

  it('a required glob scopes the blocking tier; non-matching files fall to warning', () => {
    const r = partitionByCoverageTier(
      ['services/auth/api/h.ts', 'services/auth/internal/x.ts'],
      cov(['services/*/api/**'], []),
    );
    expect(r.required).toEqual(['services/auth/api/h.ts']);
    expect(r.middle).toEqual(['services/auth/internal/x.ts']);
  });

  it('a single-star required glob does not match across a path segment', () => {
    const r = partitionByCoverageTier(
      ['src/a.ts', 'src/sub/b.ts'],
      cov(['src/*.ts'], []),
    );
    expect(r.required).toEqual(['src/a.ts']);
    expect(r.middle).toEqual(['src/sub/b.ts']);
  });

  it('required ["/"] with a deeper required glob: both match, longer wins, still required', () => {
    const r = partitionByCoverageTier(
      ['src/foo.ts'],
      cov(['/', 'src/*.ts'], []),
    );
    expect(r.required).toEqual(['src/foo.ts']);
    expect(r.middle).toEqual([]);
  });

  it('a glob excluded root longer than the matching required plain root drops the file', () => {
    // required 'src' (len 3) matches src/x.gen.ts; excluded 'src/*.gen.ts' (len 12) also
    // matches → longer (excluded) wins → dropped
    const r = partitionByCoverageTier(
      ['src/x.gen.ts', 'src/x.ts'],
      cov(['src'], ['src/*.gen.ts']),
    );
    expect(r.required).toEqual(['src/x.ts']);
    expect(r.middle).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// scanUncoveredFiles — in-memory graphs (pure string math)
// ──────────────────────────────────────────────────────────────────────────────

describe('scanUncoveredFiles — plain mappings', () => {
  it('a directory mapping covers exact, direct-child, and deep-nested files', () => {
    const g = graphWithMappings([['src/svc']]);
    const u = scanUncoveredFiles(g, ['src/svc', 'src/svc/a.ts', 'src/svc/sub/b.ts']);
    expect(u).toEqual([]);
  });

  it('a directory mapping does NOT cover a sibling with the same prefix', () => {
    const g = graphWithMappings([['src/svc']]);
    const u = scanUncoveredFiles(g, ['src/svc/a.ts', 'src/svc2/b.ts']);
    expect(u).toEqual(['src/svc2/b.ts']);
  });

  it('returns files not covered by any mapping', () => {
    const g = graphWithMappings([['src/svc']]);
    const u = scanUncoveredFiles(g, ['src/svc/a.ts', 'lib/u.ts', 'package.json']);
    expect(u).toEqual(['lib/u.ts', 'package.json']);
  });

  it('a node with no mapping covers nothing', () => {
    const g = graphWithMappings([[]]);
    const u = scanUncoveredFiles(g, ['src/a.ts', 'lib/b.ts']);
    expect(u).toEqual(['lib/b.ts', 'src/a.ts']);
  });

  it('unions coverage across multiple nodes', () => {
    const g = graphWithMappings([['src/a'], ['src/b']]);
    const u = scanUncoveredFiles(g, ['src/a/x.ts', 'src/b/y.ts', 'src/c/z.ts']);
    expect(u).toEqual(['src/c/z.ts']);
  });

  it('returns the uncovered list sorted', () => {
    const g = graphWithMappings([['covered']]);
    const u = scanUncoveredFiles(g, ['z.ts', 'a.ts', 'm.ts', 'covered/x.ts']);
    expect(u).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });

  it('normalizes backslash separators in tracked file paths', () => {
    const g = graphWithMappings([['src/svc']]);
    const u = scanUncoveredFiles(g, ['src\\svc\\a.ts', 'lib\\b.ts']);
    expect(u).toEqual(['lib/b.ts']);
  });

  it('trims whitespace around tracked file entries', () => {
    const g = graphWithMappings([['src/svc']]);
    const u = scanUncoveredFiles(g, ['  src/svc/a.ts  ', '  lib/b.ts  ']);
    expect(u).toEqual(['lib/b.ts']);
  });
});

describe('scanUncoveredFiles — glob mappings', () => {
  it('a *Repository.cs glob covers only matching files in that directory', () => {
    const g = graphWithMappings([['src/repo/*Repository.cs']]);
    const u = scanUncoveredFiles(g, [
      'src/repo/FooRepository.cs',
      'src/repo/BarRepository.cs',
      'src/repo/Helper.cs',
    ]);
    expect(u).toEqual(['src/repo/Helper.cs']);
  });

  it('a single-star glob does not reach into subdirectories', () => {
    const g = graphWithMappings([['src/repo/*Repository.cs']]);
    const u = scanUncoveredFiles(g, ['src/repo/sub/DeepRepository.cs']);
    expect(u).toEqual(['src/repo/sub/DeepRepository.cs']);
  });

  it('a src/**/*.ts glob covers .ts files at any depth but not other extensions', () => {
    const g = graphWithMappings([['src/**/*.ts']]);
    const u = scanUncoveredFiles(g, ['src/index.ts', 'src/a/b/c.ts', 'src/util.js']);
    expect(u).toEqual(['src/util.js']);
  });

  it('mixes a glob node and a plain node', () => {
    const g = graphWithMappings([['src/**/*.ts'], ['assets']]);
    const u = scanUncoveredFiles(g, [
      'src/a.ts',
      'assets/logo.png',
      'src/a.css',
    ]);
    expect(u).toEqual(['src/a.css']);
  });
});

describe('scanUncoveredFiles — graph-self and nested-graph exclusion', () => {
  it("excludes the bound graph's own .yggdrasil/ files", () => {
    const g = graphWithMappings([['src/svc']], '/repo/.yggdrasil');
    const u = scanUncoveredFiles(g, [
      'src/svc/a.ts',
      '.yggdrasil/model/svc/yg-node.yaml',
      '.yggdrasil/yg-config.yaml',
    ]);
    expect(u).toEqual([]);
  });

  it('excludes the .yggdrasil prefix path itself (exact equality)', () => {
    const g = graphWithMappings([[]], '/repo/.yggdrasil');
    const u = scanUncoveredFiles(g, ['.yggdrasil']);
    expect(u).toEqual([]);
  });

  it('does NOT exclude a path that merely starts with the yggPrefix string', () => {
    // '.yggdrasilX/...' shares the prefix string but is not under '.yggdrasil/'
    const g = graphWithMappings([[]], '/repo/.yggdrasil');
    const u = scanUncoveredFiles(g, ['.yggdrasilX/file.ts']);
    expect(u).toEqual(['.yggdrasilX/file.ts']);
  });

  it('skips files under a nested-graph subtree (directory with its own .yggdrasil/)', () => {
    const g = graphWithMappings([['src']], '/repo/.yggdrasil');
    const u = scanUncoveredFiles(g, [
      'src/index.ts',
      'apps/.yggdrasil/yg-config.yaml',
      'apps/web/main.ts',
    ]);
    // Everything under apps/ is governed by the nested graph → excluded entirely
    expect(u).not.toContain('apps/web/main.ts');
    expect(u).not.toContain('apps/.yggdrasil/yg-config.yaml');
    expect(u).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// scanUncoveredFiles — loadGraph-backed (real FS, fresh temp dirs)
// ──────────────────────────────────────────────────────────────────────────────

async function makeProject(opts: {
  mappingYaml: string;
  files: Record<string, string>;
}): Promise<{ tmpDir: string }> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'ygg-bounty-pathcov-'));
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc', 'repo');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'model', 'svc'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.1.0"\n');
  await writeFile(
    path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'),
    'name: Svc\ntype: service\ndescription: parent\n',
  );
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    `name: Repo\ntype: service\ndescription: repo layer\n${opts.mappingYaml}`,
  );
  for (const [rel, content] of Object.entries(opts.files)) {
    const abs = path.join(tmpDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return { tmpDir };
}

describe('scanUncoveredFiles — loadGraph integration', () => {
  it('glob mapping loaded from yg-node.yaml covers only matching files', async () => {
    const { tmpDir } = await makeProject({
      mappingYaml: 'mapping:\n  - src/repo/*Repository.cs\n',
      files: {
        'src/repo/FooRepository.cs': 'class Foo {}',
        'src/repo/Helper.cs': 'class Helper {}',
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      const u = scanUncoveredFiles(graph, [
        'src/repo/FooRepository.cs',
        'src/repo/Helper.cs',
      ]);
      expect(u).toEqual(['src/repo/Helper.cs']);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('plain directory mapping loaded from yg-node.yaml covers everything inside', async () => {
    const { tmpDir } = await makeProject({
      mappingYaml: 'mapping:\n  - src/repo\n',
      files: {
        'src/repo/FooRepository.cs': 'class Foo {}',
        'src/repo/Helper.cs': 'class Helper {}',
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      const u = scanUncoveredFiles(graph, [
        'src/repo/FooRepository.cs',
        'src/repo/Helper.cs',
      ]);
      expect(u).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Integration: scanUncoveredFiles → partitionByCoverageTier (end-to-end tiering)
// ──────────────────────────────────────────────────────────────────────────────

describe('scanUncoveredFiles + partitionByCoverageTier together', () => {
  it('uncovered files split into error / warning / silent by coverage roots', () => {
    const g = graphWithMappings([['src/svc']]);
    const uncovered = scanUncoveredFiles(g, [
      'src/svc/i.ts', // covered → not uncovered
      'src/svc2/extra.ts', // uncovered, under required
      'lib/u.ts', // uncovered, middle
      'vendor/v.ts', // uncovered, excluded
    ]);
    expect(uncovered).toEqual(['lib/u.ts', 'src/svc2/extra.ts', 'vendor/v.ts']);
    const tiers = partitionByCoverageTier(uncovered, cov(['src/'], ['vendor/']));
    expect(tiers.required).toEqual(['src/svc2/extra.ts']);
    expect(tiers.middle).toEqual(['lib/u.ts']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// scanGitignoredCoveredFiles — silent-drop false-green detection
//
// A git-tracked file that is ALSO gitignored (legal: `git add -f`, or a
// .gitignore rule added after the file was tracked) and is reached ONLY through a
// directory/glob mapping entry is counted "covered" by the coverage scan yet is
// dropped from every node's expanded subject set by the gitignore filter → it
// produces no review pair → a false green. This detection flags exactly those.
//
// Reads the real .gitignore and resolves absolute paths, so these cases use the
// loadGraph-backed makeProject helper (fresh temp dirs, rm'd in finally).
// ──────────────────────────────────────────────────────────────────────────────

describe('scanGitignoredCoveredFiles — silent-drop detection', () => {
  it('flags a directory-mapped, git-tracked file that is gitignored', async () => {
    const { tmpDir } = await makeProject({
      mappingYaml: 'mapping:\n  - src/repo\n',
      files: {
        '.gitignore': 'src/repo/secret.ts\n',
        'src/repo/FooRepository.cs': 'class Foo {}',
        'src/repo/secret.ts': 'export const k = 1;',
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      // Both files are git-tracked (e.g. secret.ts via `git add -f`).
      const offending = await scanGitignoredCoveredFiles(graph, [
        'src/repo/FooRepository.cs',
        'src/repo/secret.ts',
      ]);
      expect(offending).toEqual(['src/repo/secret.ts']);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does NOT flag the file when a directly-named mapping entry also points at it', async () => {
    // Control: the directory entry would drop it, but the direct file entry
    // bypasses gitignore and includes it → no silent drop → no issue.
    const { tmpDir } = await makeProject({
      mappingYaml: 'mapping:\n  - src/repo\n  - src/repo/secret.ts\n',
      files: {
        '.gitignore': 'src/repo/secret.ts\n',
        'src/repo/FooRepository.cs': 'class Foo {}',
        'src/repo/secret.ts': 'export const k = 1;',
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      const offending = await scanGitignoredCoveredFiles(graph, [
        'src/repo/FooRepository.cs',
        'src/repo/secret.ts',
      ]);
      expect(offending).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does NOT flag a directory-mapped, git-tracked file that is NOT gitignored', async () => {
    const { tmpDir } = await makeProject({
      mappingYaml: 'mapping:\n  - src/repo\n',
      files: {
        '.gitignore': 'src/repo/other.ts\n',
        'src/repo/FooRepository.cs': 'class Foo {}',
        'src/repo/secret.ts': 'export const k = 1;',
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      const offending = await scanGitignoredCoveredFiles(graph, [
        'src/repo/FooRepository.cs',
        'src/repo/secret.ts',
      ]);
      expect(offending).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('flags a glob-mapped, git-tracked file that is gitignored', async () => {
    const { tmpDir } = await makeProject({
      mappingYaml: 'mapping:\n  - src/repo/**/*.ts\n',
      files: {
        '.gitignore': 'src/repo/secret.ts\n',
        'src/repo/keep.ts': 'export const a = 1;',
        'src/repo/secret.ts': 'export const k = 1;',
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      const offending = await scanGitignoredCoveredFiles(graph, [
        'src/repo/keep.ts',
        'src/repo/secret.ts',
      ]);
      expect(offending).toEqual(['src/repo/secret.ts']);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns nothing when no .gitignore is present', async () => {
    const { tmpDir } = await makeProject({
      mappingYaml: 'mapping:\n  - src/repo\n',
      files: {
        'src/repo/FooRepository.cs': 'class Foo {}',
        'src/repo/secret.ts': 'export const k = 1;',
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      const offending = await scanGitignoredCoveredFiles(graph, [
        'src/repo/FooRepository.cs',
        'src/repo/secret.ts',
      ]);
      expect(offending).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does NOT flag a gitignored file that is not in any mapping', async () => {
    // Condition (2) fails: not matched by any mapping entry → handled by the
    // plain unmapped-files / uncovered scan, not this detection.
    const { tmpDir } = await makeProject({
      mappingYaml: 'mapping:\n  - src/repo\n',
      files: {
        '.gitignore': 'build/out.ts\n',
        'src/repo/FooRepository.cs': 'class Foo {}',
        'build/out.ts': 'export const k = 1;',
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      const offending = await scanGitignoredCoveredFiles(graph, [
        'src/repo/FooRepository.cs',
        'build/out.ts',
      ]);
      expect(offending).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
