/**
 * Bug-bounty: exhaustive coverage of the path-coverage surface.
 *
 *   - scanUncoveredFiles (plain + glob mappings, .yggdrasil exclusion,
 *     nested-graph exclusion, sorting, multi-node union)
 *   - normalizeRoot ("/" → "", leading/trailing/double-slash, trim, backslash)
 *   - matchesRoot (whole-repo "", plain exact/prefix/sibling, glob ** and *)
 *   - partitionByCoverageTier (required/excluded, plain + glob roots,
 *     required-vs-required longest-match-wins, absolute exclusion (excluded
 *     always wins once it matches at all, independent of specificity),
 *     require-nothing)
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
  scanTrackedButIgnored,
} from '../../../src/core/check.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type { Graph, GraphNode, CoverageConfig } from '../../../src/model/graph.js';

// ── In-memory graph builder for scanUncoveredFiles ────────────────────────────
// scanUncoveredFiles reads only: graph.nodes (node.meta.mapping), graph.rootPath
// (string math: path.dirname + path.relative), and the coverageVisibleFiles arg.
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

describe('partitionByCoverageTier — required vs excluded precedence (absolute exclusion)', () => {
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

  // RENAMED from 'longest-match-wins' framing — absolute exclusion means excluded ALWAYS
  // wins once it matches at all, independent of how specific the required root is.
  it('excluded wins even when a MORE SPECIFIC required root also matches (absolute exclusion)', () => {
    // excluded 'services/' (broader), required 'services/api/' (more specific, would have
    // won under the retired longest-match rule) — now BOTH files are silenced: the
    // excluded-root file 'services/other/x.ts' as before, AND 'services/api/h.ts' too.
    const r = partitionByCoverageTier(
      ['services/api/h.ts', 'services/other/x.ts'],
      cov(['services/api/'], ['services/']),
    );
    expect(r.required).toEqual([]);
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
    // required 'src' matches src/x.gen.ts; excluded 'src/*.gen.ts' also matches →
    // excluded wins because it matches at all (absolute exclusion), independent of length.
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
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"\n');
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
// scanTrackedButIgnored — tracked∩gitignored anomaly detection
//
// The coverage walk (walkRepoFiles) and mapping expansion (expandMappingPaths)
// are BOTH plain disk walks that skip anything `.gitignore` excludes — neither
// consults the git index. So a file that is git-TRACKED (e.g. `git add -f`, or a
// `.gitignore` rule added after the file was already tracked) but gitignored is
// invisible to every one of those layers: it ships in the repository, yet
// nothing that governs coverage, classification, or enforcement ever sees it.
// `scanTrackedButIgnored` is the one place that still consults git (via the
// injected `trackedFiles` — real `git ls-files` output) to catch exactly this,
// independent of node mapping: severity is 'error' under a `coverage.required`
// root, 'warning' otherwise; `trackedFiles === null` (no git) silently skips it.
//
// Pure (no filesystem I/O) — an in-memory graph carrying only the coverage
// config is enough, so no makeProject/loadGraph fixture is needed here.
// ──────────────────────────────────────────────────────────────────────────────

function graphWithCoverage(required: string[], excluded: string[] = []): Graph {
  return {
    nodes: new Map(),
    config: { coverage: { required, excluded, typeLevel: false } },
  } as unknown as Graph;
}

// A real temp project directory (never touching this repo's own files), for the
// cases that must reach scanTrackedButIgnored's POSITIVE .gitignore confirmation —
// that confirmation reads a real root .gitignore off disk, so a fully in-memory
// graph (no gitignore load possible) cannot exercise it.
async function withTempRepo(
  files: Record<string, string>,
  fn: (projectRoot: string) => Promise<void>,
): Promise<void> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'ygg-tracked-ignored-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(projectRoot, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
    await fn(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function graphAt(
  projectRoot: string,
  required: string[],
  opts: { excluded?: string[]; mapping?: string[] } = {},
): Graph {
  const nodes = new Map<string, GraphNode>();
  if (opts.mapping && opts.mapping.length > 0) {
    nodes.set('n0', {
      path: 'n0',
      meta: { name: 'n0', type: 'service', mapping: opts.mapping },
      children: [],
      parent: null,
    } as unknown as GraphNode);
  }
  return {
    rootPath: path.join(projectRoot, '.yggdrasil'),
    nodes,
    config: { coverage: { required, excluded: opts.excluded ?? [], typeLevel: false } },
  } as unknown as Graph;
}

describe('scanTrackedButIgnored — tracked∩gitignored anomaly', () => {
  it('returns nothing when trackedFiles is null (no git available)', async () => {
    const graph = graphWithCoverage(['src/']);
    const issues = await scanTrackedButIgnored(graph, null, ['src/a.ts']);
    expect(issues).toEqual([]);
  });

  it('does NOT flag a tracked file that IS visible in the walk', async () => {
    // Never reaches the gitignore read (candidates is empty) — a fully
    // synthetic graph with no real rootPath is fine here.
    const graph = graphWithCoverage(['src/']);
    const issues = await scanTrackedButIgnored(graph, ['src/a.ts'], ['src/a.ts']);
    expect(issues).toEqual([]);
  });

  it('excludes the top-level .yggdrasil/ directory (walk-excluded by design, not by gitignore)', async () => {
    // walkRepoFiles never walks into the top-level .yggdrasil/ at all, so every
    // committed graph file would otherwise look "tracked but not walked" — a
    // false positive on the graph's own files. Must stay silent (candidates
    // empty — no real rootPath needed).
    const graph = graphWithCoverage(['/']);
    const issues = await scanTrackedButIgnored(
      graph,
      ['.yggdrasil/yg-architecture.yaml', 'src/a.ts'],
      ['src/a.ts'],
    );
    expect(issues).toEqual([]);
  });

  it('excludes files under a nested-graph subtree', async () => {
    // Candidates empty (both paths dropped by excludeNestedGraphSubtrees) — no
    // real rootPath needed.
    const graph = graphWithCoverage(['/']);
    const issues = await scanTrackedButIgnored(
      graph,
      ['pkg/.yggdrasil/yg-architecture.yaml', 'pkg/sub.ts'],
      [], // neither walked — pkg is a nested graph's own territory
    );
    expect(issues).toEqual([]);
  });

  it('flags a tracked file POSITIVELY matched by .gitignore as an ERROR under a required root (regression pin)', async () => {
    await withTempRepo(
      { '.gitignore': 'src/svc/secret.ts\n', 'src/svc/i.ts': '', 'src/svc/secret.ts': 'export const k = 1;\n' },
      async (root) => {
        const graph = graphAt(root, ['src/svc/']);
        const issues = await scanTrackedButIgnored(
          graph,
          ['src/svc/i.ts', 'src/svc/secret.ts'], // git ls-files: secret.ts force-tracked
          ['src/svc/i.ts'], // walkRepoFiles: secret.ts gitignored, never walked
        );
        expect(issues).toHaveLength(1);
        expect(issues[0].severity).toBe('error');
        expect(issues[0].code).toBe('tracked-file-gitignored');
        expect(issues[0].rule).toBe('tracked-file-gitignored');
        expect(issues[0].messageData.what).toContain('src/svc/secret.ts');
        expect(issues[0].messageData.next).toMatch(/git rm --cached/);
      },
    );
  });

  it('flags the same anomaly as a WARNING when it falls outside every required root', async () => {
    await withTempRepo(
      { '.gitignore': 'src/svc/secret.ts\n', 'src/svc/secret.ts': 'export const k = 1;\n' },
      async (root) => {
        const graph = graphAt(root, ['other/']);
        const issues = await scanTrackedButIgnored(graph, ['src/svc/secret.ts'], []);
        expect(issues).toHaveLength(1);
        expect(issues[0].severity).toBe('warning');
        expect(issues[0].code).toBe('tracked-file-gitignored');
      },
    );
  });

  it('flags every offending file, independent of any node mapping', async () => {
    // No mapping concept enters this check at all — unlike the retired
    // mapped-file-gitignored, a file need not be matched by any node mapping
    // to be flagged; "ships in the repo but nothing sees it" applies regardless.
    await withTempRepo(
      { '.gitignore': 'src/a.ts\nsrc/b.ts\n', 'src/a.ts': '', 'src/b.ts': '' },
      async (root) => {
        const graph = graphAt(root, ['src/']);
        const issues = await scanTrackedButIgnored(graph, ['src/a.ts', 'src/b.ts'], []);
        expect(issues).toHaveLength(2);
        expect(issues.every((i) => i.severity === 'error')).toBe(true);
      },
    );
  });

  it('does NOT flag a walk-absent tracked file that is not POSITIVELY gitignored (the CRITICAL fix)', async () => {
    // secret.ts is tracked and absent from the walk, exactly like the gitignore
    // case — but the project's .gitignore matches something else entirely. A
    // detector that inferred "gitignored" from absence alone would flag this;
    // the real check must not, because it is not actually gitignored (this
    // stands in for a symlink, a submodule gitlink, an unreadable-directory
    // residue, or an index/filesystem Unicode-normalization mismatch — every
    // shape the disk walk can skip a tracked path for OTHER than gitignore).
    await withTempRepo(
      { '.gitignore': 'unrelated/*.log\n', 'src/svc/secret.ts': 'export const k = 1;\n' },
      async (root) => {
        const graph = graphAt(root, ['src/svc/']);
        const issues = await scanTrackedButIgnored(graph, ['src/svc/secret.ts'], []);
        expect(issues).toEqual([]);
      },
    );
  });

  it('returns nothing when the project has no root .gitignore at all, even with a walk-absent tracked entry', async () => {
    await withTempRepo({ 'src/svc/secret.ts': 'export const k = 1;\n' }, async (root) => {
      const graph = graphAt(root, ['src/svc/']);
      const issues = await scanTrackedButIgnored(graph, ['src/svc/secret.ts'], []);
      expect(issues).toEqual([]);
    });
  });

  // ── C1 regression: one exclusion authority (partitionByCoverageTier), not a
  // second, independent `required`-only test that ignored coverage.excluded ──

  it('a force-tracked, gitignored file under a coverage.excluded root raises NO issue at all (the CRITICAL fix)', async () => {
    // Before the fix, severity was computed via requiredRoots.some(matchesRoot)
    // alone — coverage.excluded never entered the decision, so a gitignored
    // file under an excluded root (e.g. vendor/) still came back as a
    // non-blocking WARNING at worst, and as a blocking ERROR if `required`
    // happened to be the whole-repo default (["/"]) — either way a flag-OFF
    // repo's vendor/ blob could block CI. Routing through
    // partitionByCoverageTier gives this check the exact same excluded-root
    // exemption every other coverage check already has.
    await withTempRepo(
      { '.gitignore': 'vendor/blob.bin\n', 'vendor/blob.bin': 'binary-ish\n' },
      async (root) => {
        const graph = graphAt(root, ['/'], { excluded: ['vendor/'] });
        const issues = await scanTrackedButIgnored(graph, ['vendor/blob.bin'], []);
        expect(issues).toEqual([]);
      },
    );
  });

  it('a required root more specific than a broader excluded root is now silenced too (absolute exclusion beats specificity)', async () => {
    // Absolute exclusion, same authority (isExcludedByCoverage) as every other
    // coverage check: required 'src/api/' is more specific than excluded
    // 'src/' and would have won under the retired longest-match rule, but
    // exclusion now wins once it matches at all, regardless of specificity.
    await withTempRepo(
      { '.gitignore': 'src/api/secret.ts\n', 'src/api/secret.ts': 'export const k = 1;\n' },
      async (root) => {
        const graph = graphAt(root, ['src/api/'], { excluded: ['src/'] });
        const issues = await scanTrackedButIgnored(graph, ['src/api/secret.ts'], []);
        expect(issues).toEqual([]);
      },
    );
  });

  it('a shallower required root loses to a more specific excluded root nested inside it (no issue)', async () => {
    // Mirror of the previous case: excluded 'src/api/generated/' (length 17)
    // is more specific than required 'src/' (length 3), so the file is
    // excluded — required does not automatically win just by being declared.
    await withTempRepo(
      {
        '.gitignore': 'src/api/generated/blob.ts\n',
        'src/api/generated/blob.ts': 'export const k = 1;\n',
      },
      async (root) => {
        const graph = graphAt(root, ['src/'], { excluded: ['src/api/generated/'] });
        const issues = await scanTrackedButIgnored(graph, ['src/api/generated/blob.ts'], []);
        expect(issues).toEqual([]);
      },
    );
  });

  // ── A file explicitly named in a node's mapping is enforced regardless of
  // gitignore status (io/hash.ts hashes it unconditionally), so it was never
  // actually invisible — file-mapping-gitignored owns that case ──

  it('a file named DIRECTLY in a node mapping is exempt — file-mapping-gitignored already owns it, not this check', async () => {
    await withTempRepo(
      { '.gitignore': 'src/svc/secret.ts\n', 'src/svc/secret.ts': 'export const k = 1;\n' },
      async (root) => {
        const graph = graphAt(root, ['src/svc/'], { mapping: ['src/svc/secret.ts'] });
        const issues = await scanTrackedButIgnored(graph, ['src/svc/secret.ts'], []);
        expect(issues).toEqual([]);
      },
    );
  });

  it('a file only swept in via a DIRECTORY mapping entry is NOT exempt — only a literal, exact-path entry is', async () => {
    // The exemption is narrow: expandMappingPaths only skips the gitignore
    // filter for a literal, non-glob, exact-path entry (the else-branch that
    // never touches gitignoreStack). A directory entry still expands through
    // collectDirectoryFilePaths WITH the gitignore stack, so a gitignored file
    // reached only via a directory mapping remains genuinely invisible.
    await withTempRepo(
      { '.gitignore': 'src/svc/secret.ts\n', 'src/svc/secret.ts': 'export const k = 1;\n' },
      async (root) => {
        const graph = graphAt(root, ['src/svc/'], { mapping: ['src/svc/'] });
        const issues = await scanTrackedButIgnored(graph, ['src/svc/secret.ts'], []);
        expect(issues).toHaveLength(1);
        expect(issues[0].code).toBe('tracked-file-gitignored');
      },
    );
  });

  it('a glob mapping entry matching the file does NOT exempt it either', async () => {
    await withTempRepo(
      { '.gitignore': 'src/svc/secret.ts\n', 'src/svc/secret.ts': 'export const k = 1;\n' },
      async (root) => {
        const graph = graphAt(root, ['src/svc/'], { mapping: ['src/svc/*.ts'] });
        const issues = await scanTrackedButIgnored(graph, ['src/svc/secret.ts'], []);
        expect(issues).toHaveLength(1);
        expect(issues[0].code).toBe('tracked-file-gitignored');
      },
    );
  });
});
