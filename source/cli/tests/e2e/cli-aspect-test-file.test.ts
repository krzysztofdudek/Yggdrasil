// =============================================================================
// E2E — `yg aspect-test --file <path>`: run an aspect against ONE file
// enforced by its architecture type alone (no owning component), as opposed
// to `--node` (a real component) and `--files` (ad-hoc, no graph attachment).
//
// Real spawned binary against the committed tests/fixtures/type-level-engine
// merged with its two-covered-files variant (src/leaf/{a,b}.ts are
// type-covered by 'leaf', alongside the real 'owned' node of the same type).
//
// HERMETIC: fresh mkdtemp merge per test, mutated in place where a test needs
// its own ad-hoc aspect, rmSync'd in finally.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const BASE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');
const distExists = existsSync(BIN_PATH);
const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function copyMergedFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-aspecttest-file-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  cpSync(path.join(BASE_FIXTURE, 'variants', 'two-covered-files'), dir, { recursive: true });
  return dir;
}

/**
 * Merges the `binary-subject` variant instead of `two-covered-files`: it adds
 * type `pics` (matches `src/pics/**`, attaches the LLM per-file rule
 * `prose-rule`) and a real text subject, `src/pics/readme.md` — a
 * type-covered file whose extension the suppression inventory's noise filter
 * would otherwise treat as documentation prose, never a waiver site.
 */
function copyMergedFixtureWithBinarySubject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-aspecttest-file-binsub-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  cpSync(path.join(BASE_FIXTURE, 'variants', 'binary-subject'), dir, { recursive: true });
  return dir;
}

function addReviewer(dir: string, endpoint: string): void {
  appendFileSync(
    cfgPath(dir),
    `\nreviewer:\n  default: standard\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: "mock-model"\n        endpoint: "${endpoint}"\n`,
  );
}

/** Write a standalone deterministic aspect into the fixture copy — not part
 *  of the shared fixture, so it never needs architecture attachment (aspect-test
 *  --node/--file both run ad-hoc, test-before-attach). */
function writeAdhocDetAspect(dir: string, id: string, checkBody: string): void {
  const adir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(adir, { recursive: true });
  writeFileSync(path.join(adir, 'yg-aspect.yaml'), `name: ${id}\ndescription: ad-hoc test aspect\nreviewer:\n  type: deterministic\nscope:\n  per: file\n`);
  writeFileSync(path.join(adir, 'check.mjs'), checkBody);
}

describe.skipIf(!distExists)('CLI E2E — yg aspect-test --file', () => {
  it('refuses --file combined with --node as ambiguous', () => {
    const dir = copyMergedFixture();
    try {
      const { status, stderr } = run(['aspect-test', '--aspect', 'own-file-rule', '--file', 'src/leaf/a.ts', '--node', 'owned'], dir);
      expect(status).toBe(1);
      expect(stderr.toLowerCase()).toMatch(/ambiguous|mutually exclusive|both/);
      expect(stderr).toMatch(/--file/);
      expect(stderr).toMatch(/--node/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses --file on a path that has a component, pointing at --node', () => {
    const dir = copyMergedFixture();
    try {
      // src/owned/o.ts IS mapped by the real 'owned' node — it has a component.
      const { status, stderr } = run(['aspect-test', '--aspect', 'own-file-rule', '--file', 'src/owned/o.ts'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('owned');
      expect(stderr).toMatch(/--node/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Adds a node ('exclnode', type 'exclhost') whose DIRECTORY mapping
   * (src/exclnode) sweeps in a subdirectory (src/exclnode/vendor) that
   * coverage.excluded then removes from the graph — the shape that used to
   * make the ownership pre-check answer "has a component of its own" for a
   * file no component actually enforces, because it calls findOwner (raw
   * text match) rather than the exclusion-aware findOwnerWithinOwnGraph.
   */
  function plantExcludedNode(dir: string): void {
    const arch = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
    writeFileSync(
      arch,
      readFileSync(arch, 'utf-8').replace(
        'node_types:\n',
        'node_types:\n  exclhost:\n    description: "Matches src/exclnode/**, for the coverage.excluded ownership pre-check test."\n    when:\n      path: "src/exclnode/**"\n',
      ),
    );
    mkdirSync(path.join(dir, '.yggdrasil', 'model', 'exclnode'), { recursive: true });
    writeFileSync(
      path.join(dir, '.yggdrasil', 'model', 'exclnode', 'yg-node.yaml'),
      'name: Exclnode\ndescription: x\ntype: exclhost\nmapping:\n  - src/exclnode\n',
    );
    mkdirSync(path.join(dir, 'src', 'exclnode', 'vendor'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'exclnode', 'kept.ts'), 'export const kept = 1;\n');
    writeFileSync(path.join(dir, 'src', 'exclnode', 'vendor', 'lib.ts'), 'export const lib = 1;\n');
    const cfg = cfgPath(dir);
    writeFileSync(cfg, readFileSync(cfg, 'utf-8').replace('excluded: []', 'excluded:\n    - src/exclnode/vendor/'));
  }

  it('refuses --file with the coverage.excluded reason, never "has a component of its own", for a file a mapping textually sweeps in but the graph excludes', () => {
    const dir = copyMergedFixture();
    try {
      plantExcludedNode(dir);
      const { status, stderr } = run(['aspect-test', '--aspect', 'own-file-rule', '--file', 'src/exclnode/vendor/lib.ts'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('is excluded from coverage.');
      expect(stderr).not.toContain('has a component of its own');
      // The false owner name is gone from the refusal message specifically
      // (not merely absent from the whole path string, which unavoidably
      // repeats 'exclnode' as part of the file path itself).
      expect(stderr).not.toMatch(/component of its own: 'exclnode'/);
      expect(stderr).not.toMatch(/--node exclnode/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('control: the node\'s own (non-excluded) file in the SAME mapping still reports "has a component of its own"', () => {
    const dir = copyMergedFixture();
    try {
      plantExcludedNode(dir);
      const { status, stderr } = run(['aspect-test', '--aspect', 'own-file-rule', '--file', 'src/exclnode/kept.ts'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('exclnode');
      expect(stderr).toMatch(/--node/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses --file on an untyped path, naming the classification problem', () => {
    const dir = copyMergedFixture();
    try {
      // src/unclassified/x.ts matches no architecture type in this fixture.
      const { status, stderr } = run(['aspect-test', '--aspect', 'own-file-rule', '--file', 'src/unclassified/x.ts'], dir);
      expect(status).toBe(1);
      expect(stderr.toLowerCase()).toMatch(/no architecture type|not addressable|unmatched/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses --file on an ambiguous path, naming the classification problem', () => {
    const dir = copyMergedFixture();
    try {
      // Add a second type matching the SAME path glob as 'leaf' — src/leaf/a.ts
      // now matches two non-strict types.
      const arch = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
      const content = readFileSync(arch, 'utf-8');
      writeFileSync(
        arch,
        content.replace(
          'node_types:\n',
          'node_types:\n  leaf2:\n    description: "A second type matching the same files as leaf, to force ambiguity."\n    when:\n      path: "src/leaf/**"\n',
        ),
      );
      const { status, stderr } = run(['aspect-test', '--aspect', 'own-file-rule', '--file', 'src/leaf/a.ts'], dir);
      expect(status).toBe(1);
      expect(stderr.toLowerCase()).toContain('ambiguous');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A directory exists (a bare existsSync probe says so) but has no single
  // file's content of its own. Before hardening this probe, a directory
  // passed classification (it never reads content) and reached the
  // deterministic/LLM machinery further down, which is where a mismatch
  // like this belongs to a plain what/why/next answer, not a guess.
  it('refuses --file on a directory, naming it plainly rather than guessing at classification', () => {
    const dir = copyMergedFixture();
    try {
      const { status, stderr } = run(['aspect-test', '--aspect', 'own-file-rule', '--file', 'src/leaf'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain("'src/leaf' is a directory, not a file.");
      expect(stderr).not.toContain('matches no architecture type');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A file this process cannot open (permission denied) used to pass the old
  // existsSync-only probe, classify successfully by path alone (classification
  // never needed to read content here), and then have its unreadable content
  // silently treated as empty by the runner — a FALSE 'satisfied' verdict for
  // a file nobody actually checked, worse than an error. The hardened probe
  // catches this before classification, the same way it catches a directory.
  it('refuses --file on an unreadable file instead of silently reporting it satisfied', () => {
    const dir = copyMergedFixture();
    const secretPath = path.join(dir, 'src', 'leaf', 'secret.ts');
    writeFileSync(secretPath, 'export const secret = 1;\n');
    chmodSync(secretPath, 0o000);
    try {
      const { status, stdout, stderr } = run(['aspect-test', '--aspect', 'own-file-rule', '--file', 'src/leaf/secret.ts'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain("'src/leaf/secret.ts' exists but cannot be read (permission denied).");
      expect(stdout).not.toContain('satisfied');
    } finally {
      chmodSync(secretPath, 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A symlink whose target is gone is already indistinguishable from a plain
  // typo to existsSync (it follows the link, finds nothing there, and
  // reports false) — pinning that this bad-input shape lands in the SAME
  // "does not exist" answer as a typo'd path, with no separate handling
  // required.
  it('refuses --file on a broken symlink the same way as a path that never existed', () => {
    const dir = copyMergedFixture();
    const linkPath = path.join(dir, 'src', 'leaf', 'broken-link.ts');
    symlinkSync('does-not-exist-target.ts', linkPath);
    try {
      const { status, stderr } = run(['aspect-test', '--aspect', 'own-file-rule', '--file', 'src/leaf/broken-link.ts'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain("'src/leaf/broken-link.ts' does not exist.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--file with a deterministic aspect runs the check with the architecture reach, over the real file content', () => {
    const dir = copyMergedFixture();
    try {
      writeAdhocDetAspect(
        dir,
        'ad-hoc-content-check',
        `export function check(ctx) {\n  const content = ctx.subject[0].content;\n  if (content.includes('BAD')) {\n    return [{ file: ctx.subject[0].path, line: 1, message: 'contains BAD' }];\n  }\n  return [];\n}\n`,
      );
      const clean = run(['aspect-test', '--aspect', 'ad-hoc-content-check', '--file', 'src/leaf/a.ts'], dir);
      expect(clean.stdout).toContain('satisfied');
      expect(clean.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--file with a deterministic aspect that reaches outside the architecture-permitted set is refused (never a crash)', () => {
    const dir = copyMergedFixture();
    try {
      writeAdhocDetAspect(
        dir,
        'ad-hoc-overreach',
        `export function check(ctx) {\n  ctx.fs.read('src/definitely/not/anywhere.ts');\n  return [];\n}\n`,
      );
      const { status, stderr } = run(['aspect-test', '--aspect', 'ad-hoc-overreach', '--file', 'src/leaf/a.ts'], dir);
      expect(status).toBe(1);
      expect(stderr).toMatch(/undeclared|not.*permit|architecture/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--file with a deterministic aspect that touches ctx.node is refused, naming both exits', () => {
    const dir = copyMergedFixture();
    try {
      writeAdhocDetAspect(
        dir,
        'ad-hoc-touches-node',
        `export function check(ctx) {\n  const t = ctx.node.type;\n  return [];\n}\n`,
      );
      const { status, stderr } = run(['aspect-test', '--aspect', 'ad-hoc-touches-node', '--file', 'src/leaf/a.ts'], dir);
      expect(status).toBe(1);
      expect(stderr.toLowerCase()).toMatch(/no owning component|unavailable/);
      expect(stderr).toMatch(/give.*component of its own|rewrite/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--file with an LLM aspect and --dry-run prints the nodeless prompt variant, no <node> element', () => {
    const dir = copyMergedFixture();
    try {
      // Tier resolution runs even for --dry-run (it never CALLS the reviewer,
      // but still needs a resolvable tier) — a bogus, never-dialed endpoint is
      // fine since no request is ever made.
      addReviewer(dir, 'http://127.0.0.1:1');
      const { status, stdout } = run(['aspect-test', '--aspect', 'llm-leaf-rule', '--file', 'src/leaf/b.ts', '--dry-run'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('src/leaf/b.ts');
      expect(stdout).not.toContain('<node');
      expect(stdout).not.toContain('node (component)');
      expect(stdout).toContain('Below is a single source file with its content and one aspect (rule set).');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--file with an LLM aspect (live) runs the reviewer over the type-covered file', async () => {
    const dir = copyMergedFixture();
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    try {
      addReviewer(dir, mock.endpoint);
      const out = await runAsync(['aspect-test', '--aspect', 'llm-leaf-rule', '--file', 'src/leaf/b.ts'], dir);
      expect(out.status).toBe(0);
      expect(out.all).toContain('satisfied');
      expect(mock.chatCount()).toBeGreaterThan(0);
      expect(mock.chatRequests[0].prompt).not.toContain('<node');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--files (ad-hoc) keeps its current behavior untouched alongside the new --file flag', () => {
    const dir = copyMergedFixture();
    try {
      const { status, stdout } = run(['aspect-test', '--aspect', 'own-file-rule', '--files', 'src/leaf/a.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('satisfied');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A typo in a --files path is a plain, common mistake — the SAME fact
  // --file already answers cleanly ("'x' does not exist."). Before this fix,
  // --files let the raw ENOENT reach the CLI's generic unclassified-error
  // funnel, which tells the user "This is a bug — please file an issue,"
  // inviting a spurious report for what is just a typo.
  it('--files with a path that does not exist reports it plainly, not as an internal bug', () => {
    const dir = copyMergedFixture();
    try {
      const { status, stdout, stderr } = run(
        ['aspect-test', '--aspect', 'own-file-rule', '--files', 'src/leaf/does-not-exist.ts'],
        dir,
      );
      expect(status).toBe(1);
      const out = stdout + stderr;
      expect(out).toContain("'src/leaf/does-not-exist.ts' does not exist.");
      expect(out).not.toContain('This is a bug');
      expect(out).not.toContain('does not classify');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A directory exists (existsSync alone cannot tell it apart from a real
  // file), so the old probe let it through and the AST runner failed deep
  // inside with a raw EISDIR, landing in the CLI's generic unclassified-error
  // funnel ("This is a bug — please file an issue") for what is just a
  // directory passed where a file was expected — the same class of mistake
  // as the typo above, and it deserves the same plain answer.
  it('--files with a directory reports it plainly, not as an internal bug', () => {
    const dir = copyMergedFixture();
    try {
      const { status, stdout, stderr } = run(
        ['aspect-test', '--aspect', 'own-file-rule', '--files', 'src/leaf'],
        dir,
      );
      expect(status).toBe(1);
      const out = stdout + stderr;
      expect(out).toContain("'src/leaf' is a directory, not a file.");
      expect(out).not.toContain('This is a bug');
      expect(out).not.toContain('EISDIR');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A file that exists and is a regular file, but this process cannot open
  // (permission denied), passed the same old probe and then failed deep
  // inside the runner with a raw EACCES — same unclassified-bug funnel,
  // different errno.
  it('--files with an unreadable file reports it plainly, not as an internal bug', () => {
    const dir = copyMergedFixture();
    const secretPath = path.join(dir, 'src', 'leaf', 'secret.ts');
    writeFileSync(secretPath, 'export const secret = 1;\n');
    chmodSync(secretPath, 0o000);
    try {
      const { status, stdout, stderr } = run(
        ['aspect-test', '--aspect', 'own-file-rule', '--files', 'src/leaf/secret.ts'],
        dir,
      );
      expect(status).toBe(1);
      const out = stdout + stderr;
      expect(out).toContain("'src/leaf/secret.ts' exists but cannot be read (permission denied).");
      expect(out).not.toContain('This is a bug');
      expect(out).not.toContain('EACCES');
    } finally {
      chmodSync(secretPath, 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A symlink whose target is gone is already indistinguishable from a plain
  // typo to existsSync (it follows the link, finds nothing there, and
  // reports false) — pinning that this bad-input shape lands in the SAME
  // "does not exist" answer as the typo above, with no separate handling
  // required.
  it('--files with a broken symlink reports it as missing, not as an internal bug', () => {
    const dir = copyMergedFixture();
    const linkPath = path.join(dir, 'src', 'leaf', 'broken-link.ts');
    symlinkSync('does-not-exist-target.ts', linkPath);
    try {
      const { status, stdout, stderr } = run(
        ['aspect-test', '--aspect', 'own-file-rule', '--files', 'src/leaf/broken-link.ts'],
        dir,
      );
      expect(status).toBe(1);
      const out = stdout + stderr;
      expect(out).toContain("'src/leaf/broken-link.ts' does not exist.");
      expect(out).not.toContain('This is a bug');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// yg-suppress on a file enforced by its architecture type alone (no owning
// component) — a suppression waives a rule for specific lines regardless of
// whether the subject is a real component or a type-covered file; both the
// spans the reviewer prompt receives and the read-only inventory (`yg
// suppressions`) key off the SUBJECT FILE, never a node, so neither needed a
// code change to see a nodeless subject. These two tests are the pin the
// earlier work described but never wrote: suppression is a trust surface,
// and a waiver nobody can audit is worse than no waiver.
// =============================================================================

/**
 * Append a single-line `yg-suppress(<aspectId>)` marker to the end of
 * `absFile` and return the 1-based line it waives (the resolver covers
 * exactly the line immediately below the marker, never the marker's own
 * line). Computed by scanning the WRITTEN file rather than by arithmetic, so
 * the assertion cannot drift if the fixture's own content ever changes.
 */
function appendSuppressMarker(absFile: string, aspectId: string, reason: string): number {
  const body = readFileSync(absFile, 'utf-8');
  writeFileSync(
    absFile,
    `${body}\n// yg-suppress(${aspectId}) ${reason}\nexport const SUPPRESSED_LINE = 1;\n`,
    'utf-8',
  );
  const lines = readFileSync(absFile, 'utf-8').split('\n');
  const markerIdx = lines.findIndex((l) => l.includes(`yg-suppress(${aspectId})`));
  return markerIdx + 2; // 1-based line below the marker
}

describe.skipIf(!distExists)('CLI E2E — yg-suppress on a file enforced by its architecture type alone', () => {
  it('a marker in a type-covered file (no owning component) reaches the assembled --file prompt as a suppressed range, with the honor instruction', () => {
    const dir = copyMergedFixture();
    try {
      // Tier resolution runs even for --dry-run — a bogus, never-dialed
      // endpoint is fine since no reviewer request is ever made (mirrors the
      // plain --dry-run test above).
      addReviewer(dir, 'http://127.0.0.1:1');
      // src/leaf/b.ts is type-covered by 'leaf', no node of its own.
      // llm-leaf-rule is the LLM aspect attached to 'leaf' (per: file).
      const suppressedLine = appendSuppressMarker(
        path.join(dir, 'src', 'leaf', 'b.ts'),
        'llm-leaf-rule',
        'known debt, tracked in the issue tracker',
      );

      const { status, stdout } = run(['aspect-test', '--aspect', 'llm-leaf-rule', '--file', 'src/leaf/b.ts', '--dry-run'], dir);
      expect(status).toBe(0);
      // The resolved span reached the assembled prompt exactly like it would
      // for a component-owned file — same block, same file key, same line.
      expect(stdout).toContain('</suppressed-ranges>');
      expect(stdout).toContain('<file path="src/leaf/b.ts">');
      expect(stdout).toContain(`<range start-line="${suppressedLine}" end-line="${suppressedLine}" />`);
      // The reviewer is instructed to honor exactly those lines (unified text
      // — same instruction a component-owned prompt carries).
      expect(stdout).toContain('Honor exactly these line ranges');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yg suppressions lists a marker in a type-covered file (no owning component), naming the subject file and the rule', () => {
    const dir = copyMergedFixture();
    try {
      appendSuppressMarker(
        path.join(dir, 'src', 'leaf', 'b.ts'),
        'llm-leaf-rule',
        'known debt, tracked in the issue tracker',
      );

      const { status, stdout } = run(['suppressions'], dir);
      expect(status).toBe(0);
      // The scan groups by SUBJECT FILE — never a node — so a file with no
      // owning component is inventoried exactly like one that has one.
      expect(stdout).toContain('src/leaf/b.ts');
      expect(stdout).toContain('single(llm-leaf-rule)');
      expect(stdout).toContain('known debt, tracked in the issue tracker');
      expect(stdout).toContain('Total: 1 marker across 1 file.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// The suppression inventory's noise filter drops prose/doc extensions
// (`.md`, `.mdc`, `.markdown`, `.txt`) UNLESS the file is a live waiver site —
// a mapped node source, or (since type-level coverage exists) a file enforced
// by its architecture type alone. A `.ts` subject never exercises that filter
// (it isn't a noise extension to begin with), so the two tests above cannot
// tell whether the type-covered exemption actually reaches it. This subject
// is a real `.md` file the `pics` type covers directly — the exact shape the
// noise filter is built to drop.
// =============================================================================

describe.skipIf(!distExists)('CLI E2E — yg-suppress on a type-covered file whose extension the inventory treats as noise', () => {
  it('yg suppressions lists a marker in a type-covered .md file, naming the subject file and the rule', () => {
    const dir = copyMergedFixtureWithBinarySubject();
    try {
      const target = path.join(dir, 'src', 'pics', 'readme.md');
      appendFileSync(
        target,
        '\n<!-- yg-suppress(prose-rule) known debt, tracked in the issue tracker -->\n',
      );

      const { status, stdout } = run(['suppressions'], dir);
      expect(status).toBe(0);
      // A live waiver on a type-covered file must be inventoried exactly like
      // one on a mapped node source, regardless of the subject's extension.
      expect(stdout).toContain('src/pics/readme.md');
      expect(stdout).toContain('single(prose-rule)');
      expect(stdout).toContain('known debt, tracked in the issue tracker');
      expect(stdout).toContain('Total: 1 marker across 1 file.');
      expect(stdout).not.toContain('No active suppression markers found.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the marker that yg suppressions now lists is the SAME one the deterministic runner honors — refused flips to verifying the moment it is added', () => {
    const dir = copyMergedFixtureWithBinarySubject();
    // A deterministic per-file rule on the SAME type, so the "before/after"
    // flip can be observed without a reviewer: no-banned-word refuses any
    // line containing the literal token BANNED.
    const adir = path.join(dir, '.yggdrasil', 'aspects', 'no-banned-word');
    mkdirSync(adir, { recursive: true });
    writeFileSync(
      path.join(adir, 'yg-aspect.yaml'),
      'name: no-banned-word\ndescription: refuses a line containing the literal token BANNED\nreviewer:\n  type: deterministic\nscope:\n  per: file\n',
    );
    writeFileSync(
      path.join(adir, 'check.mjs'),
      // Also attaches to src/pics/logo.png (binary — no text subject), so guard
      // on an empty/undefined subject the same way a real aspect author would.
      "export function check(ctx) {\n  const subject = ctx.subject[0];\n  if (!subject) return [];\n  const { path: p, content } = subject;\n  const lines = content.split('\\n');\n  const issues = [];\n  lines.forEach((line, i) => {\n    if (line.includes('BANNED')) issues.push({ file: p, line: i + 1, message: 'contains BANNED' });\n  });\n  return issues;\n}\n",
    );
    const arch = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
    writeFileSync(arch, readFileSync(arch, 'utf-8').replace('    aspects:\n      - prose-rule\n', '    aspects:\n      - prose-rule\n      - no-banned-word\n'));
    try {
      // The graph also carries prose-rule (an LLM aspect), so tier resolution
      // runs even though this test only ever fills --only-deterministic — a
      // bogus, never-dialed endpoint is fine since no reviewer call is made.
      addReviewer(dir, 'http://127.0.0.1:1');
      const target = path.join(dir, 'src', 'pics', 'readme.md');
      appendFileSync(target, '\nBANNED\n');

      // The base fixture carries unrelated pre-existing errors (an
      // architecture parents: cycle, a strict type with no when, an
      // unclassified file) that keep the overall exit status at 1
      // regardless of this rule — so the flip is pinned on the SPECIFIC
      // violation text, not the process exit code.
      const before = run(['check', '--approve', '--only-deterministic'], dir);
      expect(before.status).toBe(1);
      expect(before.stdout).toContain('src/pics/readme.md:3: contains BANNED');
      expect(run(['suppressions'], dir).stdout).toContain('No active suppression markers found.');

      // Insert the marker on the line immediately ABOVE "BANNED" — a single
      // marker waives the line below it, never its own line.
      writeFileSync(
        target,
        readFileSync(target, 'utf-8').replace(
          '\nBANNED\n',
          '\n<!-- yg-suppress(no-banned-word) known debt, tracked in the issue tracker -->\nBANNED\n',
        ),
      );
      const after = run(['check', '--approve', '--only-deterministic'], dir);
      // The refusal is gone — the waiver is honored — even though unrelated
      // pre-existing errors keep the overall run at exit 1.
      expect(after.stdout).not.toContain('contains BANNED');
      expect(after.stdout).not.toContain("src/pics/readme.md  aspect 'no-banned-word'");

      // The waiver that just flipped the gate from refusing to verifying is
      // exactly the one the inventory must now surface — never silent.
      const inventory = run(['suppressions'], dir);
      expect(inventory.stdout).toContain('src/pics/readme.md');
      expect(inventory.stdout).toContain('single(no-banned-word)');
      expect(inventory.stdout).not.toContain('No active suppression markers found.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// A live yg-suppress marker is honored wherever a node's mapping entry resolves
// to a file on disk — not only where an ordinary repo walk happens to look. The
// deterministic runner reads a node's mapping directly (expanding a directory
// or glob, but taking an exact file entry as-is); it never consults the repo
// walk that decides which files need coverage. Two files a repo walk cannot
// see are still real waiver sites this way:
//   - a file under `.yggdrasil/` — the walk prunes that whole directory to
//     keep the graph's own internal state out of the coverage scan, which
//     says nothing about a document a node deliberately maps there;
//   - a file a `.gitignore` excludes — an exact mapping entry is reviewed
//     regardless of ignore status (the `file-mapping-gitignored` check flags
//     the anomaly as a separate concern; it does not stop the file being
//     reviewed).
// The audit inventory must reach exactly the files the runner actually reads,
// or a marker can silence a rule while every audit surface reads clean.
// =============================================================================

/**
 * Extends the real `owned` node's mapping with the two files above, and gives
 * it a fresh deterministic rule (`no-banned-word`) that refuses any line
 * containing the literal token BANNED — the same before/after flip shape the
 * type-covered `.md` test above already uses, so a marker's effect on
 * enforcement and on the inventory can be observed on the SAME two files.
 */
function addHiddenMappedWaiverSites(dir: string): void {
  const nodeYamlPath = path.join(dir, '.yggdrasil', 'model', 'owned', 'yg-node.yaml');
  const original = readFileSync(nodeYamlPath, 'utf-8');
  const updated = original.replace(
    'mapping:\n  - src/owned/o.ts\n',
    'mapping:\n  - src/owned/o.ts\n  - .yggdrasil/meta/notes.md\n  - generated/g.ts\naspects:\n  - no-banned-word\n',
  );
  if (updated === original) {
    throw new Error(`fixture drift: expected mapping block not found in ${nodeYamlPath}`);
  }
  writeFileSync(nodeYamlPath, updated);

  const adir = path.join(dir, '.yggdrasil', 'aspects', 'no-banned-word');
  mkdirSync(adir, { recursive: true });
  writeFileSync(
    path.join(adir, 'yg-aspect.yaml'),
    'name: no-banned-word\ndescription: refuses a line containing the literal token BANNED\nreviewer:\n  type: deterministic\nscope:\n  per: file\n',
  );
  writeFileSync(
    path.join(adir, 'check.mjs'),
    "export function check(ctx) {\n  const subject = ctx.subject[0];\n  if (!subject) return [];\n  const { path: p, content } = subject;\n  const lines = content.split('\\n');\n  const issues = [];\n  lines.forEach((line, i) => {\n    if (line.includes('BANNED')) issues.push({ file: p, line: i + 1, message: 'contains BANNED' });\n  });\n  return issues;\n}\n",
  );

  const metaNotes = path.join(dir, '.yggdrasil', 'meta', 'notes.md');
  mkdirSync(path.dirname(metaNotes), { recursive: true });
  writeFileSync(metaNotes, '# design notes\n\nBANNED\n');

  writeFileSync(path.join(dir, '.gitignore'), 'generated/\n');
  const generatedFile = path.join(dir, 'generated', 'g.ts');
  mkdirSync(path.dirname(generatedFile), { recursive: true });
  writeFileSync(generatedFile, 'export const G = 1;\n// BANNED\n');
}

describe.skipIf(!distExists)('CLI E2E — yg-suppress on a mapped file an ordinary repo walk cannot see', () => {
  it('a marker on a node-mapped file under .yggdrasil/ is honored by the deterministic runner AND inventoried by yg suppressions', () => {
    const dir = copyMergedFixtureWithBinarySubject();
    try {
      // The fixture also carries an LLM aspect (prose-rule); tier resolution
      // runs even for --only-deterministic, so a bogus, never-dialed endpoint
      // is needed (mirrors the flip test above).
      addReviewer(dir, 'http://127.0.0.1:1');
      addHiddenMappedWaiverSites(dir);
      const notesPath = path.join(dir, '.yggdrasil', 'meta', 'notes.md');

      const before = run(['check', '--approve', '--only-deterministic'], dir);
      expect(before.stdout).toContain('.yggdrasil/meta/notes.md:3: contains BANNED');
      expect(run(['suppressions'], dir).stdout).not.toContain('.yggdrasil/meta/notes.md');

      writeFileSync(
        notesPath,
        readFileSync(notesPath, 'utf-8').replace(
          '\nBANNED\n',
          '\n<!-- yg-suppress(no-banned-word) known debt, tracked in the issue tracker -->\nBANNED\n',
        ),
      );

      const after = run(['check', '--approve', '--only-deterministic'], dir);
      expect(after.stdout).not.toContain('.yggdrasil/meta/notes.md:3: contains BANNED');

      const inventory = run(['suppressions'], dir);
      expect(inventory.stdout).toContain('.yggdrasil/meta/notes.md');
      expect(inventory.stdout).toContain('single(no-banned-word)');
      expect(inventory.stdout).not.toContain('No active suppression markers found.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a marker on a node-mapped file a .gitignore excludes is honored by the deterministic runner AND inventoried by yg suppressions', () => {
    const dir = copyMergedFixtureWithBinarySubject();
    try {
      addReviewer(dir, 'http://127.0.0.1:1');
      addHiddenMappedWaiverSites(dir);
      const generatedPath = path.join(dir, 'generated', 'g.ts');

      const before = run(['check', '--approve', '--only-deterministic'], dir);
      expect(before.stdout).toContain('generated/g.ts:2: contains BANNED');
      expect(run(['suppressions'], dir).stdout).not.toContain('generated/g.ts');

      writeFileSync(
        generatedPath,
        readFileSync(generatedPath, 'utf-8').replace(
          '\n// BANNED\n',
          '\n// yg-suppress(no-banned-word) known debt, tracked in the issue tracker\n// BANNED\n',
        ),
      );

      const after = run(['check', '--approve', '--only-deterministic'], dir);
      expect(after.stdout).not.toContain('generated/g.ts:2: contains BANNED');

      const inventory = run(['suppressions'], dir);
      expect(inventory.stdout).toContain('generated/g.ts');
      expect(inventory.stdout).toContain('single(no-banned-word)');
      expect(inventory.stdout).not.toContain('No active suppression markers found.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
