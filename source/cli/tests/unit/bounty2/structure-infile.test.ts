/**
 * Bounty 2 — branch-coverage suite for the structure runner's file-matching
 * surface: buildOwnFiles (via runStructureAspect), isPathInMapping, and the
 * inFile DSL.
 *
 * Targets studied in full:
 *   - src/structure/runner.ts          (buildOwnFiles — exercised through runStructureAspect)
 *   - src/structure/expand-mapping-sync.ts  (isPathInMapping)
 *   - src/ast/file-path.ts             (inFile DSL)
 *
 * Branch map enumerated below; each `it` names the branch(es) it takes. Both
 * sides of every boolean are exercised.
 *
 * Determinism: no random data, no wall-clock reads inside assertions; every
 * temp tree is created via mkdtemp under os.tmpdir() and removed in a finally.
 * Only this one test file is created — no source or .yggdrasil change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  cpSync,
  chmodSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPathInMapping, normalizeMappingPath } from '../../../src/structure/expand-mapping-sync.js';
import { inFile, type InFilePattern } from '../../../src/ast/file-path.js';
import type { SourceFile } from '../../../src/ast/types.js';
import { runStructureAspect } from '../../../src/structure/runner.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');

/**
 * Whether this runtime actually enforces a chmod(0o000) restriction on a file
 * readable by its owner. A privileged process (root, or certain containers)
 * ignores file mode bits entirely, so a test relying on readFileSync genuinely
 * failing under 0o000 cannot execute there. Probed ONCE at module load — never
 * per-test, never inside an assertion — so the one test that depends on it can
 * be marked SKIPPED for this environment via `it.skipIf`, an honest, explicit
 * non-execution rather than a passing assertion about a branch never taken.
 */
function probeEnforcesFilePermissions(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-permcheck-'));
  const probe = path.join(dir, 'probe.txt');
  writeFileSync(probe, 'x');
  chmodSync(probe, 0o000);
  let enforced = false;
  try {
    readFileSync(probe, 'utf8');
  } catch {
    enforced = true;
  }
  chmodSync(probe, 0o644); // restore so rmSync can remove it
  rmSync(dir, { recursive: true, force: true });
  return enforced;
}
const ENFORCES_FILE_PERMISSIONS = probeEnforcesFilePermissions();
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

// inFile only ever reads `file.path`; a SourceFile carries an `ast` field we do
// not need here, so build a minimal object and cast through unknown.
function sf(p: string): SourceFile {
  return { path: p, content: '', ast: undefined as unknown } as unknown as SourceFile;
}

// ===========================================================================
// isPathInMapping — src/structure/expand-mapping-sync.ts
//
//   const c = normalizeMappingPath(candidate);
//   if (c === '') return false;                    // BRANCH A (empty candidate)
//   return mapping.some(raw => mappingEntryMatchesFile(raw, c));  // BRANCH B
//
// mappingEntryMatchesFile (src/utils/mapping-path.ts) underlies BRANCH B:
//   if (e === '') return false;                    // empty entry
//   if (isGlobPattern(e)) return globMatch(f, e);  // glob branch (match / no-match)
//   return f === e || f.startsWith(e + '/');       // exact OR dir-prefix
// ===========================================================================
describe('isPathInMapping — every branch', () => {
  it('BRANCH A true: empty candidate after normalization returns false', () => {
    // '   ' trims to '' ; './' strips to '' ; '/' -> '' (trailing slash stripped).
    expect(isPathInMapping('   ', ['src'])).toBe(false);
    expect(isPathInMapping('./', ['src'])).toBe(false);
    expect(isPathInMapping('', ['src'])).toBe(false);
  });

  it('BRANCH A false + BRANCH B some()=>false: non-empty candidate, no entry matches', () => {
    expect(isPathInMapping('src/a.ts', ['lib', 'docs'])).toBe(false);
    // Empty mapping array: some() over [] is false.
    expect(isPathInMapping('src/a.ts', [])).toBe(false);
  });

  it('BRANCH B exact-match entry: candidate equals a literal entry', () => {
    expect(isPathInMapping('src/a.ts', ['src/a.ts'])).toBe(true);
    // ./-prefix and trailing whitespace are normalized on both sides.
    expect(isPathInMapping('./src/a.ts', ['src/a.ts'])).toBe(true);
    expect(isPathInMapping('src/a.ts', ['  src/a.ts  '])).toBe(true);
  });

  it('BRANCH B dir-prefix entry: candidate is a descendant of a mapped directory', () => {
    expect(isPathInMapping('src/lib/b.ts', ['src'])).toBe(true);
    expect(isPathInMapping('src/lib/b.ts', ['src/lib'])).toBe(true);
    // Sibling-prefix that is NOT a path boundary must NOT match (src vs srcx).
    expect(isPathInMapping('srcx/b.ts', ['src'])).toBe(false);
  });

  it('BRANCH B glob entry — match side: a *-glob entry matches the candidate', () => {
    expect(isPathInMapping('src/lib/b.ts', ['src/**/*.ts'])).toBe(true);
    // single-star does not cross a path segment
    expect(isPathInMapping('src/b.ts', ['src/*.ts'])).toBe(true);
  });

  it('BRANCH B glob entry — no-match side: a *-glob entry does not match the candidate', () => {
    // single-star must NOT cross a '/'
    expect(isPathInMapping('src/lib/b.ts', ['src/*.ts'])).toBe(false);
    // extension mismatch
    expect(isPathInMapping('src/b.js', ['src/**/*.ts'])).toBe(false);
  });

  it('BRANCH B empty entry (mappingEntryMatchesFile e==="" guard): empty entry never matches', () => {
    // Whitespace-only entry normalizes to '' inside mappingEntryMatchesFile.
    expect(isPathInMapping('src/a.ts', ['   '])).toBe(false);
    // An empty entry alongside a real one: only the real one can match.
    expect(isPathInMapping('src/a.ts', ['', 'src/a.ts'])).toBe(true);
    expect(isPathInMapping('src/a.ts', ['', 'lib'])).toBe(false);
  });

  it('normalizeMappingPath re-export is the canonical normalizer (sanity)', () => {
    expect(normalizeMappingPath('./src/a.ts/')).toBe('src/a.ts');
    expect(normalizeMappingPath('  a\\b  ')).toBe('a/b');
    expect(normalizeMappingPath('/')).toBe('');
  });
});

// ===========================================================================
// inFile DSL — src/ast/file-path.ts
//
//   if ('glob' in pattern) return globMatch(file.path, pattern.glob);  // glob branch
//   if ('regex' in pattern) return pattern.regex.test(file.path);      // regex branch
//   if ('contains' in pattern) return file.path.includes(pattern.contains); // contains branch
//   return false;                                                      // none branch
// ===========================================================================
describe('inFile DSL — every branch (both sides of each predicate)', () => {
  it('glob branch — match', () => {
    expect(inFile(sf('src/lib/b.ts'), { glob: 'src/**/*.ts' })).toBe(true);
    expect(inFile(sf('src/b.ts'), { glob: 'src/*.ts' })).toBe(true);
  });

  it('glob branch — no match', () => {
    // single-star must not cross '/'
    expect(inFile(sf('src/lib/b.ts'), { glob: 'src/*.ts' })).toBe(false);
    expect(inFile(sf('src/b.js'), { glob: 'src/**/*.ts' })).toBe(false);
  });

  it('regex branch — match', () => {
    expect(inFile(sf('src/components/Button.tsx'), { regex: /\.tsx$/ })).toBe(true);
    expect(inFile(sf('a/b/c'), { regex: /^a\// })).toBe(true);
  });

  it('regex branch — no match', () => {
    expect(inFile(sf('src/components/Button.ts'), { regex: /\.tsx$/ })).toBe(false);
    expect(inFile(sf('x/b/c'), { regex: /^a\// })).toBe(false);
  });

  it('contains branch — match', () => {
    expect(inFile(sf('src/services/orders.ts'), { contains: 'services' })).toBe(true);
    expect(inFile(sf('a/b/c.ts'), { contains: '.ts' })).toBe(true);
  });

  it('contains branch — no match', () => {
    expect(inFile(sf('src/lib/orders.ts'), { contains: 'services' })).toBe(false);
    expect(inFile(sf('a/b/c.js'), { contains: '.ts' })).toBe(false);
  });

  it('none branch — pattern object carries no recognized key returns false', () => {
    // Cast an unrecognized shape through the union: every `in` check fails,
    // falling through to `return false`.
    const bogus = { something: 'x' } as unknown as InFilePattern;
    expect(inFile(sf('src/a.ts'), bogus)).toBe(false);
  });

  it('precedence — glob is checked before regex/contains when multiple keys present', () => {
    // Object with both glob and contains: glob branch wins; glob mismatch -> false
    // even though contains would have matched, proving glob is evaluated first.
    const both = { glob: 'src/*.ts', contains: 'lib' } as unknown as InFilePattern;
    expect(inFile(sf('src/lib/b.ts'), both)).toBe(false);
  });
});

// ===========================================================================
// buildOwnFiles — src/structure/runner.ts (private; exercised via
// runStructureAspect). Branches:
//
//   for child in node.children: for raw in child.meta.mapping ?? []:
//       const p = normalizeMappingPath(raw); if (p) childMappingEntries.push(p);
//                          // ?? [] both sides; truthy/falsy p both sides
//   for p of expanded:
//       if (childMappingEntries.length > 0 && isPathInMapping(p, ...)) continue;
//                          // length>0 true/false ; isPathInMapping true/false (carve-out)
//       if (BINARY_EXTENSIONS.has(extname(p))) continue;     // binary skip true/false
//       try readFileSync ... catch { continue }              // unreadable skip
//       result.push / touchedFiles.push                       // included
// ===========================================================================
describe('buildOwnFiles via runStructureAspect — every branch', () => {
  let projectRoot: string;
  let cbCounter = 0;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-bounty2-buildown-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  // The probe aspect emits one graph-level violation per ctx.files entry so the
  // test can read back exactly which files buildOwnFiles produced.
  async function writeListAspect(aspectId: string): Promise<string> {
    cbCounter += 1;
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(
      path.join(aspectDir, 'check.mjs'),
      `// cb=${cbCounter}\nexport function check(ctx) { return ctx.files.map(f => ({ message: f.path })); }`,
    );
    return aspectDir;
  }

  async function listFiles(aspectId: string, nodePath: string, graph: ReturnType<typeof buildTestGraphForStructure>): Promise<string[]> {
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects', aspectId),
      aspectId, unit: { kind: 'node', nodePath }, graph, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    return r.violations.map((v) => v.message).sort();
  }

  it('glob/dir expansion — directory mapping expands to constituent files (included branch)', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const a = 1;');
    writeFileSync(path.join(projectRoot, 'src/b.ts'), 'export const b = 2;');
    await writeListAspect('expand1');
    const g = buildTestGraphForStructure({ nodes: [{ path: 'N', type: 'module', mapping: ['src'] }] });
    const files = await listFiles('expand1', 'N', g);
    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('glob expansion — *-glob mapping entry expands to matching files', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const a = 1;');
    writeFileSync(path.join(projectRoot, 'src/b.js'), 'export const b = 2;');
    await writeListAspect('expand2');
    const g = buildTestGraphForStructure({ nodes: [{ path: 'N', type: 'module', mapping: ['src/*.ts'] }] });
    const files = await listFiles('expand2', 'N', g);
    expect(files).toEqual(['src/a.ts']); // .js excluded by the glob
  });

  it('childMappingEntries collection — node with NO children: childMappingEntries.length===0 (carve-out skipped)', async () => {
    // length>0 FALSE side: even a file whose path would match nothing is included.
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const a = 1;');
    await writeListAspect('nochild');
    const g = buildTestGraphForStructure({ nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }] });
    const files = await listFiles('nochild', 'N', g);
    expect(files).toEqual(['src/a.ts']);
  });

  it('child carve-out — isPathInMapping TRUE: a file owned by a child node is skipped', async () => {
    mkdirSync(path.join(projectRoot, 'src/sub'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const a = 1;');
    writeFileSync(path.join(projectRoot, 'src/sub/child.ts'), 'export const c = 1;');
    await writeListAspect('carve');
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'P', type: 'module', mapping: ['src'] },
        { path: 'P/C', type: 'module', mapping: ['src/sub/child.ts'], parent: 'P' },
      ],
    });
    const files = await listFiles('carve', 'P', g);
    // src/sub/child.ts carved out (isPathInMapping true); src/a.ts kept (false).
    expect(files).toEqual(['src/a.ts']);
  });

  it('child carve-out via a GLOB child mapping — isPathInMapping(glob) TRUE skips, others kept', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const a = 1;');
    writeFileSync(path.join(projectRoot, 'src/b.ts'), 'export const b = 1;');
    writeFileSync(path.join(projectRoot, 'src/c.js'), 'export const c = 1;');
    await writeListAspect('carveglob');
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'P', type: 'module', mapping: ['src'] },
        // child claims all .ts files via a glob -> a.ts and b.ts carved out
        { path: 'P/C', type: 'module', mapping: ['src/*.ts'], parent: 'P' },
      ],
    });
    const files = await listFiles('carveglob', 'P', g);
    expect(files).toEqual(['src/c.js']);
  });

  it('childMappingEntries truthy/falsy filter — child mapping with empty entries is ignored (no carve-out)', async () => {
    // A child whose mapping entries all normalize to '' (whitespace) yields an
    // empty childMappingEntries -> the `if (p)` push is skipped (falsy side) ->
    // childMappingEntries.length===0 -> parent keeps everything.
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const a = 1;');
    await writeListAspect('emptychild');
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'P', type: 'module', mapping: ['src'] },
        { path: 'P/C', type: 'module', mapping: ['   ', './'], parent: 'P' },
      ],
    });
    const files = await listFiles('emptychild', 'P', g);
    expect(files).toEqual(['src/a.ts']);
  });

  it('child with undefined mapping — child.meta.mapping ?? [] takes the [] side', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const a = 1;');
    await writeListAspect('undefchild');
    // Child node created without a mapping field -> meta.mapping is undefined.
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'P', type: 'module', mapping: ['src'] },
        { path: 'P/C', type: 'module', parent: 'P' },
      ],
    });
    const files = await listFiles('undefchild', 'P', g);
    expect(files).toEqual(['src/a.ts']);
  });

  it('binary extension skip — TRUE side: a .png file is excluded; .ts kept', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const a = 1;');
    writeFileSync(path.join(projectRoot, 'src/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeListAspect('bin1');
    const g = buildTestGraphForStructure({ nodes: [{ path: 'N', type: 'module', mapping: ['src'] }] });
    const files = await listFiles('bin1', 'N', g);
    expect(files).toEqual(['src/a.ts']);
  });

  it('binary extension skip — case-insensitive: .PNG (uppercase) is also excluded', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const a = 1;');
    writeFileSync(path.join(projectRoot, 'src/LOGO.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeListAspect('bin2');
    const g = buildTestGraphForStructure({ nodes: [{ path: 'N', type: 'module', mapping: ['src'] }] });
    const files = await listFiles('bin2', 'N', g);
    expect(files).toEqual(['src/a.ts']); // .PNG lowercased -> in BINARY_EXTENSIONS
  });

  it('binary extension skip — FALSE side: a non-binary extension (.txt) is included', async () => {
    writeFileSync(path.join(projectRoot, 'src/note.txt'), 'hello');
    await writeListAspect('bin3');
    const g = buildTestGraphForStructure({ nodes: [{ path: 'N', type: 'module', mapping: ['src'] }] });
    const files = await listFiles('bin3', 'N', g);
    expect(files).toEqual(['src/note.txt']);
  });

  // To reach the `try { readFileSync } catch { continue }` branch inside
  // buildOwnFiles, the path must SURVIVE expandMappingPaths (its stat()
  // succeeds — the file exists and is enumerated as a regular file) yet FAIL
  // readFileSync. A chmod-000 file does exactly that: stat() (used by the
  // directory walk) succeeds, but reading it throws EACCES — except under a
  // privileged runtime (root, some containers) that ignores mode bits
  // entirely, where the branch this test targets is simply unreachable.
  // ENFORCES_FILE_PERMISSIONS is probed once at module load (not inside the
  // test) so that case is an honest, explicit SKIP rather than a passing
  // assertion about a branch this environment never takes.
  it.skipIf(!ENFORCES_FILE_PERMISSIONS)(
    'unreadable skip — a file that stat()s as a file but readFileSync rejects is silently dropped',
    async () => {
      const locked = path.join(projectRoot, 'src/locked.ts');
      writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const a = 1;');
      writeFileSync(locked, 'export const l = 1;');
      chmodSync(locked, 0o000);
      try {
        await writeListAspect('unread');
        const g = buildTestGraphForStructure({
          nodes: [{ path: 'N', type: 'module', mapping: ['src'] }],
        });
        const files = await listFiles('unread', 'N', g);
        // locked.ts hit the readFileSync catch -> skipped; a.ts included.
        expect(files).toEqual(['src/a.ts']);
      } finally {
        // Restore mode so afterEach's recursive rmSync can remove the tree.
        chmodSync(locked, 0o644);
      }
    },
  );

  it('included branch records touchedFiles — touchedFiles mirror ctx.files', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'export const a = 1;');
    writeFileSync(path.join(projectRoot, 'src/b.ts'), 'export const b = 1;');
    await writeListAspect('touched');
    const g = buildTestGraphForStructure({ nodes: [{ path: 'N', type: 'module', mapping: ['src'] }] });
    const r = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/touched'),
      aspectId: 'touched', unit: { kind: 'node', nodePath: 'N' }, graph: g, projectRoot,
    });
    expect(r.succeeded).toBe(true);
    expect([...r.touchedFiles].sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('node with undefined own mapping — node.meta.mapping ?? [] takes the [] side (no files)', async () => {
    await writeListAspect('nomap');
    const g = buildTestGraphForStructure({ nodes: [{ path: 'N', type: 'module' }] });
    const files = await listFiles('nomap', 'N', g);
    expect(files).toEqual([]);
  });
});

// ===========================================================================
// E2E CONFIRMATION — the same buildOwnFiles branches reachable through the
// shipped binary (`yg aspect-test --node`). One spawn exercises three
// branches at once: directory expansion (included), child carve-out
// (isPathInMapping TRUE -> skip), and binary-extension skip.
// Modeled on tests/e2e/cli-architecture-when-validation.test.ts.
// ===========================================================================
describe.skipIf(!distExists)('E2E — buildOwnFiles via yg aspect-test --node', () => {
  function copyFixture(label: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `yg-bounty2-e2e-${label}-`));
    cpSync(FIXTURE, dir, { recursive: true });
    return dir;
  }

  function run(args: string[], cwd: string) {
    const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status,
      all: (result.stdout ?? '') + (result.stderr ?? ''),
    };
  }

  it('directory mapping expands, child file is carved out, binary is skipped', () => {
    const dir = copyFixture('carve');
    try {
      const yg = path.join(dir, '.yggdrasil');

      // Architecture: add a directory-mapped `bundle` type; keep service.
      writeFileSync(
        path.join(yg, 'yg-architecture.yaml'),
        [
          'node_types:',
          '  module:',
          "    description: 'Organizational grouping.'",
          '    log_required: false',
          '  bundle:',
          "    description: 'A directory-mapped bundle of source files.'",
          '    log_required: false',
          '    when:',
          '      path: "src/**"',
          '  service:',
          "    description: 'A service unit under src/services/.'",
          '    log_required: false',
          '    when:',
          '      path: "src/services/**"',
          '    parents: [module, bundle]',
          '    aspects:',
          '      - no-todo-comments',
          '      - requires-named-export',
          '      - has-doc-comment',
          '    relations:',
          '      uses: [service]',
          '      calls: [service]',
          '',
        ].join('\n'),
        'utf-8',
      );

      // A deterministic probe aspect that lists ctx.files (graph-level
      // violations, printed as "<graph>: ...").
      const aspectDir = path.join(yg, 'aspects', 'list-files');
      mkdirSync(aspectDir, { recursive: true });
      writeFileSync(
        path.join(aspectDir, 'yg-aspect.yaml'),
        ['name: ListFiles', 'id: list-files', 'description: Lists ctx.files (probe).', 'status: draft', ''].join('\n'),
        'utf-8',
      );
      writeFileSync(
        path.join(aspectDir, 'check.mjs'),
        "export function check(ctx) { return ctx.files.map(f => ({ message: 'CTXFILE ' + f.path })); }\n",
        'utf-8',
      );

      // Parent bundle node maps the whole src/services directory.
      const bundleDir = path.join(yg, 'model', 'bundle');
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(
        path.join(bundleDir, 'yg-node.yaml'),
        ['name: Bundle', 'description: Bundle mapping the services directory.', 'type: bundle', 'mapping:', '  - src/services', ''].join('\n'),
        'utf-8',
      );

      // Move orders to be a CHILD of bundle so its file is carved out of the
      // parent's ctx.files. Remove the original services subtree.
      rmSync(path.join(yg, 'model', 'services'), { recursive: true, force: true });
      const ordersDir = path.join(bundleDir, 'orders');
      mkdirSync(ordersDir, { recursive: true });
      writeFileSync(
        path.join(ordersDir, 'yg-node.yaml'),
        ['name: OrdersService', 'description: Orders child.', 'type: service', 'mapping:', '  - src/services/orders.ts', ''].join('\n'),
        'utf-8',
      );

      // A binary file inside the mapped directory must be skipped.
      writeFileSync(path.join(dir, 'src', 'services', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));

      const { all, status } = run(['aspect-test', '--aspect', 'list-files', '--node', 'bundle'], dir);

      // payments.ts is present (directory expansion + included branch).
      expect(all).toContain('CTXFILE src/services/payments.ts');
      // orders.ts is carved out (child carve-out: isPathInMapping TRUE -> skip).
      expect(all).not.toContain('CTXFILE src/services/orders.ts');
      // logo.png is skipped (binary-extension branch).
      expect(all).not.toContain('logo.png');
      // The probe emitted at least one violation, so exit code is 1.
      expect(status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
