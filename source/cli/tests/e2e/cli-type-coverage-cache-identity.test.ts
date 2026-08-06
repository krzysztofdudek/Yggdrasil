import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// The type-classification cache (io/type-class-cache.ts) is keyed by content
// plus architecture. A file's own repo-relative path was NOT part of that key,
// so two byte-identical files at different paths shared one cache entry and
// the second silently inherited the first's classification — on a COLD cache,
// within a single run, no error or warning. Which direction it went (a file
// falsely counted as covered, or a correctly-covered file falsely reported
// unmapped) was decided by directory scan order. This suite drives the real
// built binary against real on-disk projects — never the committed fixtures
// mutated in place — to pin both directions, plus the companion line-ending
// vector, at the process level: exit code and rendered output, not internal
// state.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const BASIC_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-basic');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { status: number | null; out: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** Every shard file written under a cache directory tree, recursively. */
function findShardFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = path.join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.json')) out.push(p);
    }
  };
  try {
    walk(root);
  } catch {
    // cache dir not created yet — no shards
  }
  return out;
}

/** A minimal from-scratch project: one classifying type, no nodes, type_level on. */
function buildMinimalProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-cache-identity-e2e-'));
  mkdirSync(path.join(dir, '.yggdrasil', 'model'), { recursive: true });
  writeFileSync(
    path.join(dir, '.yggdrasil', 'yg-config.yaml'),
    'version: "5.2.0"\ncoverage: { required: [src/], excluded: [], type_level: true }\n',
  );
  return dir;
}

describe.skipIf(!distExists)('E2E: the type-classification cache never serves one file\'s verdict to another', () => {
  it('two byte-identical files under DIFFERENT path predicates, cold cache, single run: neither inherits the other\'s classification', () => {
    const dir = buildMinimalProject();
    try {
      writeFileSync(
        path.join(dir, '.yggdrasil', 'yg-architecture.yaml'),
        'node_types:\n' +
          '  alpha:\n' +
          '    description: "Alpha-layer source under src/alpha/."\n' +
          '    when: { path: "src/alpha/**" }\n',
      );
      mkdirSync(path.join(dir, 'src', 'alpha'), { recursive: true });
      mkdirSync(path.join(dir, 'src', 'beta'), { recursive: true });
      const body = 'export const shared = 1;\n';
      writeFileSync(path.join(dir, 'src', 'alpha', 'a.ts'), body);
      writeFileSync(path.join(dir, 'src', 'beta', 'b.ts'), body); // byte-identical, does NOT match 'alpha's path

      const { status, out } = run(['check', '--details'], dir);

      // src/beta/b.ts must NOT be silently absorbed into 'alpha' just because
      // src/alpha/a.ts (byte-identical) was classified first in the scan.
      expect(status).toBe(1);
      expect(out).toContain('yg check: FAIL');
      expect(out).toContain('1/2 files (0 node-owned, 1 type-covered, 0 excluded)');
      expect(out).toContain("'alpha' — 1 file covered: src/alpha/a.ts");
      expect(out).toContain('unmapped (1)');
      expect(out).toContain('src/beta/b.ts');

      // Structural proof, independent of the rendered text: two files, two
      // distinct cache identities — never one shared shard.
      expect(findShardFiles(path.join(dir, '.yggdrasil', '.type-class-cache')).length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the OTHER direction: giving an unmatched file the SAME bytes as a genuinely covered one never turns the covered file unmapped', () => {
    // type-coverage-basic: src/svc/handler.ts matches 'svc' (path: src/svc/**);
    // src/misc/plain.ts matches nothing. Overwriting plain.ts with handler.ts's
    // exact bytes reproduces the aliasing bug's OTHER direction — the
    // unmatched file sorts first in some scans, writes a "matches nothing"
    // shard, and the genuinely covered file would inherit it.
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-cache-identity-e2e-'));
    try {
      cpSync(BASIC_FIXTURE, dir, { recursive: true });
      const handlerBody = 'export function handle(): void {}\n';
      writeFileSync(path.join(dir, 'src', 'svc', 'handler.ts'), handlerBody);
      writeFileSync(path.join(dir, 'src', 'misc', 'plain.ts'), handlerBody); // now byte-identical to handler.ts

      const { out } = run(['check', '--details'], dir);

      // handler.ts must still read as type-covered by 'svc' — never demoted to
      // unmapped because plain.ts (byte-identical, wrong path) got classified
      // first and wrote a "matches nothing" shard under the shared content hash.
      expect(out).toContain("'svc' — 1 file covered: src/svc/handler.ts");
      expect(out).not.toMatch(/unmapped[\s\S]{0,200}src\/svc\/handler\.ts/);
      // plain.ts, meanwhile, still correctly matches nothing (its own path
      // satisfies no type's `when`) — the two are judged independently.
      expect(out).toMatch(/unmapped[\s\S]{0,200}src\/misc\/plain\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a CRLF file and its LF twin at different paths never collide into one verdict — the run that should FAIL does not flip to PASS', () => {
    const dir = buildMinimalProject();
    try {
      writeFileSync(
        path.join(dir, '.yggdrasil', 'yg-architecture.yaml'),
        'node_types:\n' +
          '  dos-script:\n' +
          '    description: "A script kept in CRLF form for the Windows build runner."\n' +
          '    when: { content: "echo hi\\r" }\n',
      );
      mkdirSync(path.join(dir, 'src'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'a-windows.sh'), '#!/bin/sh\r\necho hi\r\n');
      writeFileSync(path.join(dir, 'src', 'b-unix.sh'), '#!/bin/sh\necho hi\n');

      const { status, out } = run(['check', '--details'], dir);

      // b-unix.sh has no \r anywhere — it must never match 'dos-script' just
      // because a-windows.sh's line-ending-NORMALIZED content hash happens to
      // equal its own. The run must stay FAIL (b-unix.sh unmapped), not flip
      // to PASS by silently absorbing it.
      expect(status).toBe(1);
      expect(out).toContain('yg check: FAIL');
      expect(out).toContain("'dos-script' — 1 file covered: src/a-windows.sh");
      expect(out).toContain('unmapped (1)');
      expect(out).toContain('src/b-unix.sh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-saving a file with a different line-ending style, at the SAME path, across two separate CLI process runs, is detected as a content change', () => {
    const dir = buildMinimalProject();
    try {
      writeFileSync(
        path.join(dir, '.yggdrasil', 'yg-architecture.yaml'),
        'node_types:\n' +
          '  dos-script:\n' +
          '    description: "A script kept in CRLF form for the Windows build runner."\n' +
          '    when: { content: "echo hi\\r" }\n',
      );
      mkdirSync(path.join(dir, 'src'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'script.sh'), '#!/bin/sh\r\necho hi\r\n');

      const first = run(['check', '--details'], dir);
      expect(first.out).toContain("'dos-script' — 1 file covered: src/script.sh");

      // Same path, second PROCESS invocation (a fresh cache read from disk),
      // re-saved LF-only: the literal \r is gone.
      writeFileSync(path.join(dir, 'src', 'script.sh'), '#!/bin/sh\necho hi\n');
      const second = run(['check', '--details'], dir);

      // A key built from line-ending-normalized bytes would see an UNCHANGED
      // content hash across the edit and keep serving the CRLF-era verdict —
      // this is the bug this test pins.
      expect(second.out).not.toContain("'dos-script'");
      expect(second.out).toContain('unmapped (1)');
      expect(second.out).toContain('src/script.sh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`yg check --approve --only-deterministic` now reads and writes the classification cache, not zero entries', () => {
    const dir = buildMinimalProject();
    try {
      writeFileSync(
        path.join(dir, '.yggdrasil', 'yg-architecture.yaml'),
        'node_types:\n' +
          '  alpha:\n' +
          '    description: "Alpha-layer source under src/alpha/."\n' +
          '    when: { path: "src/alpha/**" }\n',
      );
      mkdirSync(path.join(dir, 'src', 'alpha'), { recursive: true });
      mkdirSync(path.join(dir, 'src', 'beta'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'alpha', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(path.join(dir, 'src', 'beta', 'b.ts'), 'export const b = 2;\n');

      const cacheDir = path.join(dir, '.yggdrasil', '.type-class-cache');
      expect(findShardFiles(cacheDir).length).toBe(0);

      run(['check', '--approve', '--only-deterministic'], dir);

      expect(findShardFiles(cacheDir).length).toBe(2); // one shard per file, no longer bypassed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`yg owner --file` on an unmapped file now reads and writes the classification cache too, via classifySingleFileCached', () => {
    const dir = buildMinimalProject();
    try {
      writeFileSync(
        path.join(dir, '.yggdrasil', 'yg-architecture.yaml'),
        'node_types:\n' +
          '  alpha:\n' +
          '    description: "Alpha-layer source under src/alpha/."\n' +
          '    when: { path: "src/alpha/**" }\n',
      );
      mkdirSync(path.join(dir, 'src', 'beta'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'beta', 'b.ts'), 'export const b = 2;\n'); // no node owns it, matches no type

      const cacheDir = path.join(dir, '.yggdrasil', '.type-class-cache');
      expect(findShardFiles(cacheDir).length).toBe(0);

      const { out } = run(['owner', '--file', 'src/beta/b.ts'], dir);
      expect(out).toContain('no graph coverage');

      // classifySingleFileCached, not the bare (uncached) classifySingleFile,
      // is what `yg owner --file` calls for an unmapped file — this is the
      // one shard-count proof that call site still writes through.
      expect(findShardFiles(cacheDir).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `coverage.type_level` off means every command that can classify a file
 * still answers (a path predicate is pure and needs no cache), but none of
 * them may touch `.yggdrasil/.type-class-cache/` — not create the directory,
 * not read a shard, not write one. Every command that reaches classification
 * gates on the flag before ever constructing a `TypeClassCache` instance;
 * this suite drives each of them, across two ways a project can be flag-off
 * (no `coverage:` block at all, and an explicit `type_level: false`), and
 * asserts the directory never comes into existence at all — not merely that
 * it holds zero shards, which `findShardFiles` above would also report for a
 * directory that exists but is empty.
 */
function buildFlagOffProject(coverageBlock: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-cache-identity-e2e-'));
  mkdirSync(path.join(dir, '.yggdrasil', 'model'), { recursive: true });
  writeFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), `version: "5.2.0"\n${coverageBlock}`);
  writeFileSync(
    path.join(dir, '.yggdrasil', 'yg-architecture.yaml'),
    'node_types:\n' +
      '  alpha:\n' +
      '    description: "Alpha-layer source under src/alpha/."\n' +
      '    when: { path: "src/alpha/**" }\n',
  );
  mkdirSync(path.join(dir, 'src', 'alpha'), { recursive: true });
  mkdirSync(path.join(dir, 'src', 'beta'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'alpha', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(dir, 'src', 'beta', 'b.ts'), 'export const b = 2;\n'); // matches no type — the shape yg type-suggest --file needs to reach classification
  return dir;
}

const FLAG_OFF_PROJECT_SHAPES: Array<[string, string]> = [
  ["no coverage: block at all — this repository's own shape", ''],
  ['coverage: present with type_level explicitly false', 'coverage: { required: [src/], excluded: [], type_level: false }\n'],
];

describe.skipIf(!distExists)('E2E: coverage.type_level off — the classification cache directory never comes into existence, on ANY command', () => {
  for (const [label, coverageBlock] of FLAG_OFF_PROJECT_SHAPES) {
    it(`${label}: check / check --approve / context / advise / aspects / structure / tree / find / suppressions / owner --file / impact --file / type-suggest --file all leave .type-class-cache/ absent`, () => {
      const dir = buildFlagOffProject(coverageBlock);
      const cacheDir = path.join(dir, '.yggdrasil', '.type-class-cache');
      try {
        expect(existsSync(cacheDir)).toBe(false);

        const commands: string[][] = [
          ['check'],
          ['check', '--details'],
          ['check', '--approve', '--only-deterministic'],
          ['context', '--file', 'src/beta/b.ts'],
          ['advise'],
          ['aspects'],
          ['structure'],
          ['tree'],
          ['find', 'alpha'],
          ['suppressions'],
          ['owner', '--file', 'src/beta/b.ts'],
          ['impact', '--file', 'src/beta/b.ts'],
          // The one call site that constructed its own TypeClassCache without
          // checking coverage.typeLevel first — everything above this line
          // already went through a gated wrapper and was never the risk;
          // this line is the actual regression this suite exists to pin.
          ['type-suggest', '--file', 'src/beta/b.ts'],
        ];
        for (const args of commands) {
          run(args, dir);
          expect(existsSync(cacheDir)).toBe(false);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
