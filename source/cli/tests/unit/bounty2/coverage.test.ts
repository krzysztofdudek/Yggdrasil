/**
 * BOUNTY 2 — exhaustive branch coverage for the coverage-tier matching logic in
 *   src/core/check-coverage-tiers.ts
 *
 * Target tiers: normalizeRoot / matchesRoot / partitionByCoverageTier.
 *
 * Every if / boolean / ternary / early-return in the three target functions is
 * exercised, both sides. The functions are pure (no I/O), so the unit suites
 * import them directly. A final E2E group drives the same partition logic
 * through the real `yg check` binary against a temp git fixture, since
 * partitionByCoverageTier is reached from runCheck → cli/check.ts.
 *
 * Determinism: no random data, no wall-clock reads inside assertions, temp
 * trees created with mkdtemp under os.tmpdir() and removed in a finally block.
 * The repo's own files / src / .yggdrasil are never touched.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeRoot,
  matchesRoot,
  partitionByCoverageTier,
} from '../../../src/core/check-coverage-tiers.js';
import type { CoverageConfig } from '../../../src/model/graph.js';
import { gitFixtureEnv } from '../../support/git-fixture.js';

// ───────────────────────────────────────────────────────────────────────────
// normalizeRoot — POSIX, strip leading/trailing slashes, collapse internal
// double-slashes, "/" → "" (whole repo), trim, backslash → slash.
// ───────────────────────────────────────────────────────────────────────────
describe('normalizeRoot', () => {
  it('"/" → "" (whole-repo sentinel)', () => {
    // toPosixPath strips the trailing slash → "", the leading-slash strip is a
    // no-op on the already-empty string. Final result is the whole-repo "".
    expect(normalizeRoot('/')).toBe('');
  });

  it('empty string stays empty', () => {
    expect(normalizeRoot('')).toBe('');
  });

  it('strips a single leading slash', () => {
    expect(normalizeRoot('/services')).toBe('services');
  });

  it('strips multiple leading slashes (^/+)', () => {
    expect(normalizeRoot('///services')).toBe('services');
  });

  it('strips a trailing slash', () => {
    expect(normalizeRoot('services/')).toBe('services');
  });

  it('strips multiple trailing slashes', () => {
    expect(normalizeRoot('services///')).toBe('services');
  });

  it('strips both leading and trailing slashes together', () => {
    expect(normalizeRoot('/services/')).toBe('services');
  });

  it('collapses an internal double-slash run (/{2,}) to a single slash', () => {
    expect(normalizeRoot('services//nested')).toBe('services/nested');
  });

  it('collapses a 3+ internal slash run to a single slash', () => {
    expect(normalizeRoot('services///nested')).toBe('services/nested');
  });

  it('collapses multiple distinct internal runs', () => {
    expect(normalizeRoot('a//b///c')).toBe('a/b/c');
  });

  it('handles leading + internal + trailing slashes in one input', () => {
    expect(normalizeRoot('//a//b//')).toBe('a/b');
  });

  it('trims surrounding whitespace before normalizing', () => {
    expect(normalizeRoot('   services/nested   ')).toBe('services/nested');
  });

  it('whitespace-then-slash trims first then strips the slash', () => {
    expect(normalizeRoot('  /services/  ')).toBe('services');
  });

  it('converts backslash separators to forward slashes (toPosixPath)', () => {
    expect(normalizeRoot('services\\nested')).toBe('services/nested');
  });

  it('a plain root with no slashes to strip is returned unchanged (all replaces no-op)', () => {
    expect(normalizeRoot('services')).toBe('services');
  });

  it('preserves glob metacharacters verbatim (only slash handling applies)', () => {
    expect(normalizeRoot('/services/**/*.ts/')).toBe('services/**/*.ts');
    expect(normalizeRoot('**/*.generated.ts')).toBe('**/*.generated.ts');
  });

  it('a whitespace-only root normalizes to "" (whole repo)', () => {
    expect(normalizeRoot('   ')).toBe('');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// matchesRoot — normRoot === "" short-circuits true; else delegates to
// mappingEntryMatchesFile (glob via minimatch / plain exact / plain dir-prefix
// / no-match).
// ───────────────────────────────────────────────────────────────────────────
describe('matchesRoot', () => {
  it('empty normRoot (whole repo) matches every file — short-circuit true', () => {
    expect(matchesRoot('src/a.ts', '')).toBe(true);
    expect(matchesRoot('', '')).toBe(true);
    expect(matchesRoot('any/deeply/nested/file.txt', '')).toBe(true);
  });

  it('plain root: exact file match → true', () => {
    expect(matchesRoot('services/a.ts', 'services/a.ts')).toBe(true);
    expect(matchesRoot('services', 'services')).toBe(true);
  });

  it('plain root: directory-prefix match (file under root/) → true', () => {
    expect(matchesRoot('services/a.ts', 'services')).toBe(true);
    expect(matchesRoot('services/sub/deep/a.ts', 'services')).toBe(true);
  });

  it('plain root: sibling that shares a name prefix but is not under root → false', () => {
    // "services2/a.ts" does NOT start with "services/" — the dir-prefix guard
    // requires the slash, so this is a no-match (both startsWith and === fail).
    expect(matchesRoot('services2/a.ts', 'services')).toBe(false);
  });

  it('plain root: unrelated file → no match (false)', () => {
    expect(matchesRoot('lib/b.ts', 'services')).toBe(false);
  });

  it('glob root with ** matches files at any depth', () => {
    expect(matchesRoot('a/b/c.generated.ts', '**/*.generated.ts')).toBe(true);
    expect(matchesRoot('x.generated.ts', '**/*.generated.ts')).toBe(true);
  });

  it('glob root with single * stays within one path segment', () => {
    expect(matchesRoot('src/foo.ts', 'src/*.ts')).toBe(true);
    expect(matchesRoot('src/sub/foo.ts', 'src/*.ts')).toBe(false);
  });

  it('glob root that does not match the file → false', () => {
    expect(matchesRoot('src/foo.js', 'src/*.ts')).toBe(false);
  });

  it('a dotfile/dot-segment is matched by a glob (dot:true)', () => {
    // globMatch uses { dot: true }, so a leading-dot segment matches a star.
    expect(matchesRoot('.config/settings.ts', '*/*.ts')).toBe(true);
    expect(matchesRoot('src/.hidden.ts', 'src/*.ts')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// partitionByCoverageTier — the core tier classifier. Required-tier files are
// the error tier, middle-tier files are the warning tier, excluded files are
// silently dropped. Longest match wins; on an equal-length tie excluded wins.
// ───────────────────────────────────────────────────────────────────────────
describe('partitionByCoverageTier', () => {
  it('file in REQUIRED only → required (error) tier', () => {
    const r = partitionByCoverageTier(
      ['services/a.ts'],
      { required: ['services/'], excluded: [] },
    );
    expect(r.required).toEqual(['services/a.ts']);
    expect(r.middle).toEqual([]);
  });

  it('file in EXCLUDED only → dropped (silent), not in either bucket', () => {
    const r = partitionByCoverageTier(
      ['vendor/c.ts'],
      { required: [], excluded: ['vendor/'] },
    );
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual([]);
  });

  it('file in NEITHER → middle (warning) tier', () => {
    const r = partitionByCoverageTier(
      ['lib/b.ts'],
      { required: ['services/'], excluded: ['vendor/'] },
    );
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual(['lib/b.ts']);
  });

  it('file in BOTH, longer match in required → required wins', () => {
    // 'services/legacy/' (len 16) is required and longer than excluded
    // 'services/' (len 9). The longer required root claims the file.
    const r = partitionByCoverageTier(
      ['services/legacy/x.ts'],
      { required: ['services/legacy/'], excluded: ['services/'] },
    );
    expect(r.required).toEqual(['services/legacy/x.ts']);
    expect(r.middle).toEqual([]);
  });

  it('file in BOTH, longer match in excluded → excluded wins (silent)', () => {
    // 'services/legacy/' is excluded and longer than required 'services/'.
    const r = partitionByCoverageTier(
      ['services/legacy/x.ts', 'services/a.ts'],
      { required: ['services/'], excluded: ['services/legacy/'] },
    );
    // services/a.ts only matches required → error tier.
    expect(r.required).toEqual(['services/a.ts']);
    // services/legacy/x.ts: excluded root is longer → dropped.
    expect(r.middle).toEqual([]);
  });

  it('EQUAL-LENGTH tie between required and excluded → excluded wins (>= in excluded loop)', () => {
    // required ['foo/'] and excluded ['foo/'] normalize to the same 'foo' (len
    // 3). The excluded loop uses >=, so on the equal-length tie excluded wins
    // and the file is silently dropped.
    const r = partitionByCoverageTier(
      ['foo/x.ts'],
      { required: ['foo/'], excluded: ['foo/'] },
    );
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual([]);
  });

  it('EMPTY required → every non-excluded uncovered file falls to middle (warning)', () => {
    const r = partitionByCoverageTier(
      ['src/a.ts', 'lib/b.ts'],
      { required: [], excluded: [] },
    );
    expect(r.required).toEqual([]);
    expect(r.middle.sort()).toEqual(['lib/b.ts', 'src/a.ts']);
  });

  it('EMPTY required with excluded → excluded silent, the rest warn', () => {
    const r = partitionByCoverageTier(
      ['src/a.ts', 'vendor/c.ts'],
      { required: [], excluded: ['vendor/'] },
    );
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual(['src/a.ts']);
  });

  it('whole-repo required ("/") → every uncovered file is in the error tier', () => {
    const r = partitionByCoverageTier(
      ['src/a.ts', 'lib/b.ts'],
      { required: ['/'], excluded: [] },
    );
    expect(r.required.sort()).toEqual(['lib/b.ts', 'src/a.ts']);
    expect(r.middle).toEqual([]);
  });

  it('whole-repo required with a glob excluded → generated files dropped, rest blocked', () => {
    const r = partitionByCoverageTier(
      ['src/a.ts', 'src/x.generated.ts', 'lib/y.generated.ts'],
      { required: ['/'], excluded: ['**/*.generated.ts'] },
    );
    // '' (whole-repo required) has length 0; the glob excluded root matches the
    // generated files with length > 0, so excluded wins for those.
    expect(r.required).toEqual(['src/a.ts']);
    expect(r.middle).toEqual([]);
  });

  it('multi-required: shorter root after a longer one does NOT downgrade (the > guard false branch)', () => {
    // 'services/auth/' (len 13) is checked, then 'services/' (len 8). The second
    // iteration's `r.length > best.len` is FALSE, so best stays at the longer
    // root — the file lands in required either way, but this pins the guard.
    const r = partitionByCoverageTier(
      ['services/auth/x.ts'],
      { required: ['services/auth/', 'services/'], excluded: [] },
    );
    expect(r.required).toEqual(['services/auth/x.ts']);
    expect(r.middle).toEqual([]);
  });

  it('multi-required: a longer specific required root wins over a shorter one', () => {
    const r = partitionByCoverageTier(
      ['services/auth/x.ts', 'services/billing/y.ts'],
      { required: ['services/', 'services/auth/'], excluded: [] },
    );
    expect(r.required.sort()).toEqual(['services/auth/x.ts', 'services/billing/y.ts']);
    expect(r.middle).toEqual([]);
  });

  it('GLOB required scopes the error tier; non-matching files fall to warning', () => {
    const r = partitionByCoverageTier(
      ['services/auth/api/h.ts', 'services/auth/internal/x.ts'],
      { required: ['services/*/api/**'], excluded: [] },
    );
    expect(r.required).toEqual(['services/auth/api/h.ts']);
    expect(r.middle).toEqual(['services/auth/internal/x.ts']);
  });

  it('GLOB roots in BOTH required and excluded — longer glob wins per-file', () => {
    // required glob 'src/**' (len 6), excluded glob 'src/**/*.gen.ts' (len 15).
    // For a .gen.ts file both match but excluded is longer → dropped.
    // For a plain .ts file only required matches → error tier.
    const r = partitionByCoverageTier(
      ['src/a.ts', 'src/sub/b.gen.ts'],
      { required: ['src/**'], excluded: ['src/**/*.gen.ts'] },
    );
    expect(r.required).toEqual(['src/a.ts']);
    expect(r.middle).toEqual([]);
  });

  it('roots are normalized before matching (leading/trailing/double slashes ignored)', () => {
    // '/services//' normalizes to 'services'; the file matches it as a dir prefix.
    const r = partitionByCoverageTier(
      ['services/a.ts'],
      { required: ['/services//'], excluded: [] },
    );
    expect(r.required).toEqual(['services/a.ts']);
    expect(r.middle).toEqual([]);
  });

  it('empty uncovered input → both buckets empty (loop never runs)', () => {
    const r = partitionByCoverageTier([], { required: ['/'], excluded: [] });
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual([]);
  });

  it('preserves input order within each bucket and partitions a mixed batch', () => {
    const cov: CoverageConfig = { required: ['app/'], excluded: ['vendor/'] };
    const r = partitionByCoverageTier(
      ['app/one.ts', 'vendor/skip.ts', 'misc/two.ts', 'app/three.ts', 'misc/four.ts'],
      cov,
    );
    expect(r.required).toEqual(['app/one.ts', 'app/three.ts']);
    expect(r.middle).toEqual(['misc/two.ts', 'misc/four.ts']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E2E — drive partitionByCoverageTier through the real `yg check` binary.
// Coverage tiers are reached from runCheck (cli/check.ts) only when git tracked
// files are available, so each fixture is a fresh temp git repo. We assert the
// rendered tier (unmapped error / uncovered warning / silent) for a file placed
// under a required / middle / excluded root.
// ───────────────────────────────────────────────────────────────────────────
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

/** Copy the e2e-lifecycle fixture into a fresh temp git repo. */
function makeRepo(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-cov-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  // Initialize a real git repo so `git ls-files` returns tracked files (the
  // gate that enables the coverage scan in cli/check.ts).
  const env = gitFixtureEnv(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, env });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, env });
  return dir;
}

/** Stage + commit everything currently on disk so `git ls-files` sees it. */
function commitAll(dir: string): void {
  const env = gitFixtureEnv(dir);
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir, env });
}

const configPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-config.yaml');

/** Append a coverage block to the fixture's yg-config.yaml. */
function setCoverage(dir: string, required: string[], excluded: string[]): void {
  const fmt = (xs: string[]) => (xs.length === 0 ? '[]' : `[${xs.map(x => JSON.stringify(x)).join(', ')}]`);
  const existing = readFileSync(configPath(dir), 'utf-8');
  writeFileSync(
    configPath(dir),
    `${existing}\ncoverage:\n  required: ${fmt(required)}\n  excluded: ${fmt(excluded)}\n`,
    'utf-8',
  );
}

/** Write a brand-new uncovered source file (no node maps it). */
function addUncoveredFile(dir: string, relPath: string): void {
  const abs = path.join(dir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n', 'utf-8');
}

describe.skipIf(!distExists)('E2E — yg check renders the coverage tier of an uncovered file', () => {
  it('required root → uncovered file blocks as an `unmapped` error (exit 1)', () => {
    const dir = makeRepo('req');
    try {
      addUncoveredFile(dir, 'extra/foo.ts');
      // Require the extra/ root so the uncovered file is the blocking tier.
      setCoverage(dir, ['extra/'], []);
      commitAll(dir);
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('unmapped');
      expect(stdout).toContain('extra/foo.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('middle (no required match) → uncovered file surfaces as a non-blocking `uncovered` warning', () => {
    const dir = makeRepo('mid');
    try {
      addUncoveredFile(dir, 'extra/foo.ts');
      // Require an unrelated root; extra/foo.ts matches neither required nor
      // excluded → middle/advisory tier (warning, does not block on its own).
      setCoverage(dir, ['src/services/'], []);
      commitAll(dir);
      const { stdout } = run(['check'], dir);
      // The uncovered-advisory block renders under the `uncovered` label and is
      // NOT reported as an unmapped error for this file.
      expect(stdout).toContain('uncovered');
      expect(stdout).toContain('extra/foo.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excluded root → uncovered file is silent (no unmapped error, no uncovered warning)', () => {
    const dir = makeRepo('exc');
    try {
      addUncoveredFile(dir, 'extra/foo.ts');
      // require nothing, exclude the extra/ root → the file is dropped silently.
      setCoverage(dir, [], ['extra/']);
      commitAll(dir);
      const { stdout } = run(['check'], dir);
      // The excluded file must not appear anywhere in the coverage report.
      expect(stdout).not.toContain('extra/foo.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('glob excluded root drops a generated file anywhere in the tree', () => {
    const dir = makeRepo('globexc');
    try {
      addUncoveredFile(dir, 'extra/widget.generated.ts');
      addUncoveredFile(dir, 'extra/plain.ts');
      // Whole repo required, but a ** glob excludes generated files anywhere.
      setCoverage(dir, ['extra/'], ['**/*.generated.ts']);
      commitAll(dir);
      const { stdout } = run(['check'], dir);
      // The generated file is silently dropped; the plain file blocks.
      expect(stdout).not.toContain('extra/widget.generated.ts');
      expect(stdout).toContain('extra/plain.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
