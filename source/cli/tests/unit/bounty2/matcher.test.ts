import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeMappingPath,
  isGlobPattern,
  globMatch,
  mappingEntryMatchesFile,
} from '../../../src/utils/mapping-path.js';

// ---------------------------------------------------------------------------
// TARGET: src/utils/mapping-path.ts — the single mapping/glob matcher.
//
// This suite exercises EVERY branch / boolean sub-expression of the four
// exported functions, then confirms the matcher end-to-end through the CLI
// (`yg owner`) — the public surface that routes file paths through
// isGlobPattern + mappingEntryMatchesFile.
//
// Branch map (each enumerated below with at least one test for both sides):
//   normalizeMappingPath: trim / \\->/ / leading ./ / trailing /+ / empty / combos
//   isGlobPattern:        '*' present  vs  absent
//   globMatch:            { dot: true } dotfile  +  segment (* vs **) semantics
//   mappingEntryMatchesFile:
//       e === ''                -> false (early return)
//       isGlobPattern(e) true   -> globMatch(f, e)   (match + non-match)
//       isGlobPattern(e) false  -> f === e  ||  f.startsWith(e + '/')
//           left true  (exact)
//           left false / right true  (dir-prefix)
//           both false (no match)
// ---------------------------------------------------------------------------

// =========================================================================
// normalizeMappingPath — the 4-stage transform chain, each stage both ways.
// =========================================================================
describe('normalizeMappingPath', () => {
  it('returns an already-canonical path unchanged (no transform applies)', () => {
    expect(normalizeMappingPath('src/a.ts')).toBe('src/a.ts');
  });

  // --- Stage 1: trim() ---
  it('trims leading whitespace', () => {
    expect(normalizeMappingPath('   src/a.ts')).toBe('src/a.ts');
  });
  it('trims trailing whitespace', () => {
    expect(normalizeMappingPath('src/a.ts   ')).toBe('src/a.ts');
  });
  it('trims surrounding whitespace including tabs and newlines', () => {
    expect(normalizeMappingPath('\t\n  src/a.ts \n')).toBe('src/a.ts');
  });
  it('does NOT trim interior whitespace (path with a space stays)', () => {
    expect(normalizeMappingPath('src/a b.ts')).toBe('src/a b.ts');
  });

  // --- Stage 2: replace(/\\/g, '/') ---
  it('converts a single backslash to forward slash', () => {
    expect(normalizeMappingPath('src\\a.ts')).toBe('src/a.ts');
  });
  it('converts ALL backslashes (global flag), including doubled', () => {
    expect(normalizeMappingPath('a\\b\\c\\d.ts')).toBe('a/b/c/d.ts');
  });
  it('leaves a path with no backslashes unchanged by the slash stage', () => {
    expect(normalizeMappingPath('a/b/c.ts')).toBe('a/b/c.ts');
  });

  // --- Stage 3: replace(/^\.\//, '') — leading ./ ONLY ---
  it('strips a single leading ./', () => {
    expect(normalizeMappingPath('./src/a.ts')).toBe('src/a.ts');
  });
  it('strips a leading ./ that was originally a leading .\\ (backslash first)', () => {
    // backslash->slash runs before the leading-./ strip, so .\src becomes ./src then src
    expect(normalizeMappingPath('.\\src\\a.ts')).toBe('src/a.ts');
  });
  it('collapses every leading ./ (POSIX normalization) — the fs side resolves them too', () => {
    expect(normalizeMappingPath('././x')).toBe('x');
  });
  it('collapses a ./ segment that is not at the start', () => {
    expect(normalizeMappingPath('src/./a.ts')).toBe('src/a.ts');
  });
  it('does NOT strip a leading ../ (only ./ is anchored)', () => {
    expect(normalizeMappingPath('../src/a.ts')).toBe('../src/a.ts');
  });
  it('does NOT treat a leading . without slash as a prefix to strip', () => {
    expect(normalizeMappingPath('.hidden')).toBe('.hidden');
  });

  // --- Stage 4: replace(/\/+$/, '') — trailing slashes ---
  it('strips a single trailing slash', () => {
    expect(normalizeMappingPath('src/handlers/')).toBe('src/handlers');
  });
  it('strips multiple trailing slashes (one-or-more)', () => {
    expect(normalizeMappingPath('src/handlers///')).toBe('src/handlers');
  });
  it('collapses an interior slash run', () => {
    expect(normalizeMappingPath('src//handlers')).toBe('src/handlers');
  });

  // --- Empty / whitespace-only / combination cases ---
  it('returns empty string for empty input', () => {
    expect(normalizeMappingPath('')).toBe('');
  });
  it('returns empty string for whitespace-only input (trim collapses it)', () => {
    expect(normalizeMappingPath('   \t  ')).toBe('');
  });
  it('a lone "./" normalizes to empty (leading ./ stripped, nothing left)', () => {
    expect(normalizeMappingPath('./')).toBe('');
  });
  it('a lone "/" normalizes to empty (trailing slash stripped)', () => {
    expect(normalizeMappingPath('/')).toBe('');
  });
  it('applies all four stages together in order', () => {
    // trim -> backslash -> leading ./ -> trailing /
    expect(normalizeMappingPath('  .\\src\\handlers\\  ')).toBe('src/handlers');
  });
  it('a backslash-only leading dot path with trailing slash collapses fully', () => {
    expect(normalizeMappingPath('  .\\  ')).toBe('');
  });
});

// =========================================================================
// isGlobPattern — single boolean: entry.includes('*')
// =========================================================================
describe('isGlobPattern', () => {
  it('true when a single * is present', () => {
    expect(isGlobPattern('src/*Repo.cs')).toBe(true);
  });
  it('true when ** is present', () => {
    expect(isGlobPattern('src/**/*.ts')).toBe(true);
  });
  it('true even if the * is at the very start', () => {
    expect(isGlobPattern('*.ts')).toBe(true);
  });
  it('true even if the * is the entire string', () => {
    expect(isGlobPattern('*')).toBe(true);
  });
  it('false for a plain file path (no *)', () => {
    expect(isGlobPattern('src/index.ts')).toBe(false);
  });
  it('false for ? — only * triggers glob', () => {
    expect(isGlobPattern('src/a?.ts')).toBe(false);
  });
  it('false for [ ] bracket name — treated literally', () => {
    expect(isGlobPattern('app/[id]/page.tsx')).toBe(false);
  });
  it('false for { } brace name — treated literally', () => {
    expect(isGlobPattern('src/{a,b}.ts')).toBe(false);
  });
  it('false for empty string', () => {
    expect(isGlobPattern('')).toBe(false);
  });
});

// =========================================================================
// globMatch — the sole minimatch site, { dot: true }. Verify dot behavior
// (both directions) and * vs ** segment semantics (both directions).
// =========================================================================
describe('globMatch', () => {
  it('matches a leading-dot segment because { dot: true } (positive)', () => {
    expect(globMatch('src/.hidden/file.ts', 'src/**/*.ts')).toBe(true);
  });
  it('matches a dotfile directly with a * glob because { dot: true }', () => {
    // Default minimatch (dot:false) would NOT match a leading-dot name with *;
    // dot:true means it does.
    expect(globMatch('.env', '*')).toBe(true);
  });
  it('matches a dotfile under a directory glob because { dot: true }', () => {
    expect(globMatch('src/.config', 'src/*')).toBe(true);
  });
  it('* does NOT cross a path separator (negative)', () => {
    expect(globMatch('src/sub/FooRepo.cs', 'src/*Repo.cs')).toBe(false);
  });
  it('* matches within a single segment (positive)', () => {
    expect(globMatch('src/FooRepo.cs', 'src/*Repo.cs')).toBe(true);
  });
  it('** crosses path separators (positive)', () => {
    expect(globMatch('src/a/b/c.ts', 'src/**/*.ts')).toBe(true);
  });
  it('** also matches a file directly under the root (zero intermediate dirs)', () => {
    expect(globMatch('src/index.ts', 'src/**/*.ts')).toBe(true);
  });
  it('a literal (no-wildcard) pattern matches verbatim, fails otherwise', () => {
    expect(globMatch('src/a.ts', 'src/a.ts')).toBe(true);
    expect(globMatch('src/b.ts', 'src/a.ts')).toBe(false);
  });
  it('matches the given strings verbatim — does not normalize a leading ./ for the caller', () => {
    // globMatch is the raw primitive; './src/a.ts' is NOT minimatch-equal to 'src/a.ts'.
    expect(globMatch('./src/a.ts', 'src/a.ts')).toBe(false);
  });
});

// =========================================================================
// mappingEntryMatchesFile — every branch and both sides of every boolean.
// =========================================================================
describe('mappingEntryMatchesFile — early-return (empty entry)', () => {
  it('empty entry string -> false (e === "" true)', () => {
    expect(mappingEntryMatchesFile('', 'src/a.ts')).toBe(false);
  });
  it('whitespace-only entry normalizes to "" -> false', () => {
    expect(mappingEntryMatchesFile('   ', 'src/a.ts')).toBe(false);
  });
  it('a lone "./" entry normalizes to "" -> false', () => {
    expect(mappingEntryMatchesFile('./', 'src/a.ts')).toBe(false);
  });
  it('a lone "/" entry normalizes to "" -> false even against a glob-shaped file', () => {
    expect(mappingEntryMatchesFile('/', '*')).toBe(false);
  });
});

describe('mappingEntryMatchesFile — glob branch (isGlobPattern true)', () => {
  it('glob entry that the file satisfies -> true', () => {
    expect(
      mappingEntryMatchesFile('Source/Database/*Repository.cs', 'Source/Database/FooRepository.cs'),
    ).toBe(true);
  });
  it('glob entry that the file does NOT satisfy -> false', () => {
    expect(
      mappingEntryMatchesFile('Source/Database/*Repository.cs', 'Source/Database/Helper.cs'),
    ).toBe(false);
  });
  it('* in a glob entry does not cross a separator', () => {
    expect(
      mappingEntryMatchesFile('Source/Database/*Repository.cs', 'Source/Database/sub/FooRepository.cs'),
    ).toBe(false);
  });
  it('** in a glob entry crosses separators (nested and flat)', () => {
    expect(mappingEntryMatchesFile('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(mappingEntryMatchesFile('src/**/*.ts', 'src/index.ts')).toBe(true);
  });
  it('** glob entry does not match a different root', () => {
    expect(mappingEntryMatchesFile('src/**/*.ts', 'lib/index.ts')).toBe(false);
  });
  it('glob branch honors { dot: true } via globMatch (dotfile under **)', () => {
    expect(mappingEntryMatchesFile('src/**/*.ts', 'src/.hidden/file.ts')).toBe(true);
  });
  it('both args normalized before the glob match (leading ./ on file)', () => {
    // file './src/x.ts' normalizes to 'src/x.ts' which the glob matches.
    expect(mappingEntryMatchesFile('src/*.ts', './src/x.ts')).toBe(true);
  });
  it('both args normalized before the glob match (backslashes in entry)', () => {
    expect(mappingEntryMatchesFile('src\\*.ts', 'src/x.ts')).toBe(true);
  });
  it('a glob entry with trailing slash is normalized then matched', () => {
    // 'src/*/' -> 'src/*' which matches a single child segment.
    expect(mappingEntryMatchesFile('src/*/', 'src/child')).toBe(true);
    expect(mappingEntryMatchesFile('src/*/', 'src/a/b')).toBe(false);
  });
});

describe('mappingEntryMatchesFile — plain branch (isGlobPattern false)', () => {
  // --- left side of ||: f === e ---
  it('exact match -> true (f === e left-true)', () => {
    expect(mappingEntryMatchesFile('src/index.ts', 'src/index.ts')).toBe(true);
  });
  it('exact match after normalizing leading ./ on the entry', () => {
    expect(mappingEntryMatchesFile('./src/index.ts', 'src/index.ts')).toBe(true);
  });
  it('exact match after normalizing leading ./ on the file', () => {
    expect(mappingEntryMatchesFile('src/index.ts', './src/index.ts')).toBe(true);
  });
  it('exact match after normalizing backslashes on both sides', () => {
    expect(mappingEntryMatchesFile('src\\index.ts', 'src/index.ts')).toBe(true);
  });
  it('exact match after stripping a trailing slash on the entry', () => {
    // 'src/index.ts/' -> 'src/index.ts' equals the file.
    expect(mappingEntryMatchesFile('src/index.ts/', 'src/index.ts')).toBe(true);
  });

  // --- right side of ||: f.startsWith(e + '/'), left was false ---
  it('directory-prefix match for an immediate child -> true (left false, right true)', () => {
    expect(mappingEntryMatchesFile('src/handlers', 'src/handlers/order.ts')).toBe(true);
  });
  it('directory-prefix match for a deeply nested file -> true', () => {
    expect(mappingEntryMatchesFile('src', 'src/a/b/c.ts')).toBe(true);
  });
  it('directory-prefix honors the / boundary (e + "/")', () => {
    // 'src/handle' is NOT a directory boundary of 'src/handlers/...'
    expect(mappingEntryMatchesFile('src/handle', 'src/handlers/order.ts')).toBe(false);
  });
  it('directory entry with a trailing slash still prefix-matches (normalized)', () => {
    expect(mappingEntryMatchesFile('src/handlers/', 'src/handlers/order.ts')).toBe(true);
  });
  it('a bracket directory entry covers its children literally (not a char class)', () => {
    expect(mappingEntryMatchesFile('app/[id]', 'app/[id]/page.tsx')).toBe(true);
  });
  it('a bracket file entry matches literally and not as a char class', () => {
    expect(mappingEntryMatchesFile('app/[id]/page.tsx', 'app/[id]/page.tsx')).toBe(true);
    expect(mappingEntryMatchesFile('app/[id]/page.tsx', 'app/i/page.tsx')).toBe(false);
  });

  // --- both sides of || false ---
  it('different path -> false (both sides false)', () => {
    expect(mappingEntryMatchesFile('src/handlers', 'lib/util.ts')).toBe(false);
  });
  it('the file is an ANCESTOR of the entry -> false (no reverse prefix)', () => {
    // entry 'src/a/b' is deeper than file 'src/a' — startsWith is one-directional.
    expect(mappingEntryMatchesFile('src/a/b', 'src/a')).toBe(false);
  });
  it('entry equal to file as a prefix without a separator -> false', () => {
    // 'srcfile.ts' must not match entry 'src' (no '/' boundary).
    expect(mappingEntryMatchesFile('src', 'srcfile.ts')).toBe(false);
  });
});

// =========================================================================
// E2E — confirm the matcher through the spawned CLI (`yg owner --file`).
// `yg owner` routes the file argument through isGlobPattern +
// mappingEntryMatchesFile (see src/cli/owner.ts findOwner). Each test builds a
// fresh temp copy of the e2e-lifecycle fixture, mutates the orders node's
// mapping, spawns the real binary, asserts the rendered owner resolution, and
// rmSync's the temp dir in a finally. No network, no LLM (owner is pure
// graph + path logic).
// =========================================================================
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

/** Rewrite the orders node's `mapping:` block to a single given entry. */
function setOrdersMapping(dir: string, entry: string): void {
  writeFileSync(
    ordersNodePath(dir),
    [
      'name: OrdersService',
      'description: Creates and retrieves customer orders.',
      'type: service',
      'aspects:',
      '  - wip-rule',
      'mapping:',
      `  - ${entry}`,
      '',
    ].join('\n'),
    'utf-8',
  );
}

describe.skipIf(!distExists)('E2E — mapping matcher via `yg owner --file`', () => {
  it('E1: exact plain mapping resolves the owning node (f === e branch)', () => {
    const dir = copyFixture('e1');
    try {
      const { status, stdout } = run(['owner', '--file', 'src/services/orders.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('src/services/orders.ts -> services/orders');
      // exact match => direct, so NO "no direct mapping" notice.
      expect(stdout).not.toContain('no direct mapping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E2: a leading ./ on the queried file still resolves the exact owner (normalize)', () => {
    const dir = copyFixture('e2');
    try {
      const { stdout } = run(['owner', '--file', './src/services/orders.ts'], dir);
      expect(stdout).toContain('-> services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E3: a single-segment * glob mapping resolves the owner (glob branch)', () => {
    const dir = copyFixture('e3');
    try {
      setOrdersMapping(dir, 'src/services/order*.ts');
      const { stdout } = run(['owner', '--file', 'src/services/orders.ts'], dir);
      expect(stdout).toContain('src/services/orders.ts -> services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E4: a * glob does NOT cross a separator — a nested file is not owned by the glob node', () => {
    const dir = copyFixture('e4');
    try {
      // orders globs only single-segment service files. payments node keeps
      // payments.ts. A deeper file under services/ is owned by neither.
      setOrdersMapping(dir, 'src/services/*.ts');
      writeFileSync(
        path.join(dir, 'src', 'services', 'orders.ts'),
        'export const orders = 1;\n',
        'utf-8',
      );
      // Create a nested file the single-* glob cannot reach.
      const nested = path.join(dir, 'src', 'services', 'sub');
      mkdirSync(nested, { recursive: true });
      writeFileSync(path.join(nested, 'orders.ts'), 'export const orders = 1;\n', 'utf-8');
      const { stdout } = run(['owner', '--file', 'src/services/sub/orders.ts'], dir);
      // The single-* glob does not cross '/', so this nested file has no owner.
      expect(stdout).toContain('no graph coverage');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E5: a ** glob mapping crosses separators and resolves the owner', () => {
    const dir = copyFixture('e5');
    try {
      setOrdersMapping(dir, 'src/**/*.ts');
      // remove the sibling payments node so there is no overlap ambiguity
      const payDir = path.join(dir, '.yggdrasil', 'model', 'services', 'payments');
      rmSync(payDir, { recursive: true, force: true });
      const { stdout } = run(['owner', '--file', 'src/services/orders.ts'], dir);
      expect(stdout).toContain('-> services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E6: a directory (plain prefix) mapping resolves with the "no direct mapping" notice', () => {
    const dir = copyFixture('e6');
    try {
      setOrdersMapping(dir, 'src/services');
      // move payments out so its exact mapping does not win for orders.ts
      writeFileSync(
        path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml'),
        ['name: PaymentsService', 'description: x', 'type: service', 'mapping:', '  - src/elsewhere.ts', ''].join('\n'),
        'utf-8',
      );
      const { stdout } = run(['owner', '--file', 'src/services/orders.ts'], dir);
      expect(stdout).toContain('-> services/orders');
      // prefix (non-exact) owner => the "no direct mapping" ancestor notice fires.
      expect(stdout).toContain('no direct mapping');
      expect(stdout).toContain("ancestor directory 'src/services'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E7: an existing-but-unmapped file resolves to no graph coverage (plain non-match)', () => {
    const dir = copyFixture('e7');
    try {
      writeFileSync(path.join(dir, 'src', 'standalone.ts'), 'export const z = 1;\n', 'utf-8');
      const { stdout } = run(['owner', '--file', 'src/standalone.ts'], dir);
      expect(stdout).toContain('no graph coverage');
      // it exists, so NOT the "(file not found)" variant.
      expect(stdout).not.toContain('file not found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
