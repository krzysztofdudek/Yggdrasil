// =============================================================================
// CLI E2E — the "type-covered churn" graduation nomination in `yg advise`.
//
// Pins the public CLI surface (spawn the built bin.js). When the type-level
// coverage tier is on, `yg advise` nominates graduating a file the architecture
// classifies only by TYPE (no owning component) to its own component, when that
// file CHURNS (changes across recent commits) — a type-covered file has no node,
// so no node-level rule can ever attach to it; the type tier alone carries
// whatever enforcement it gets. The churn is measured READ-ONLY from real git
// history, exactly like the existing per-component hot-spot nomination, and this
// class shares the SAME git-history fetch rather than running git a second time.
// Every scenario asserts exit 0 (the attention layer never gates — G4).
//
//   1. a churning type-covered file (no component) nominates graduation, naming
//      the file, its churn count, and its matched type
//   2. two same-type files that import each other upgrade the evidence to a
//      cluster, both files named
//   3. a file under a coverage.excluded root is NEVER attributed churn and NEVER
//      nominated, matching what `yg owner --file` already says about it
//   4. with the type-level tier OFF, the output is BYTE-IDENTICAL whether or not
//      the architecture even declares a type that would have classified these
//      files — proving the tier being off leaves this surface completely
//      untouched, not merely quiet about the new class
//   5. a churning file whose matched type carries NO effective aspect is never
//      nominated — the class only speaks where the type tier truly enforces
//      something, matching what `yg owner --file` already says about it
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

/** The verbatim graduation WHAT line for a file path and its matched type. */
const GRAD_WHAT = (file: string, typeId: string) =>
  `File '${file}' (matched type '${typeId}') is changing but has no node of its own.`;

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/**
 * A loadable graph with TWO non-strict classifying types and NO node at all —
 * every file under either type's `path` glob is, by construction,
 * uncovered-by-node and (when the tier is on) type-covered:
 *
 *   - `svc` (matches `src/svc/**`) carries `covered-rule`, a `per: file` LLM
 *     aspect — `yg advise` never runs a reviewer, so its content is immaterial;
 *     it only needs to be effective and non-draft so `svc` genuinely enforces
 *     something on the files it classifies.
 *   - `unenforced` (matches `src/unenforced/**`) carries NO aspect at all —
 *     scenario 5's fixture for "the type carries nothing here".
 *
 * The type declarations themselves are unconditional (architecture facts do
 * not depend on the tier flag); only `includeCoverageBlock` controls whether
 * `coverage:` (and therefore `type_level`) appears in config at all — the
 * flag-off/no-flag comparison in scenario 4 needs a fixture where the block is
 * entirely absent.
 */
function makeFixture(label: string, opts: { typeLevel: boolean; excluded?: string[] }): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-advise-typechurn-${label}-`));
  // No node in this fixture (deliberately — every file under src/svc/ is uncovered
  // by any node mapping), but the loader still requires the model/ directory to exist.
  mkdirSync(path.join(dir, '.yggdrasil', 'model'), { recursive: true });
  w(
    dir,
    '.yggdrasil/yg-architecture.yaml',
    `node_types:\n` +
      `  svc:\n    description: 'a non-strict classifying type for uncovered service files'\n    log_required: false\n    aspects:\n      - covered-rule\n    when:\n      path: "src/svc/**"\n` +
      `  unenforced:\n    description: 'a non-strict classifying type with no rule at all'\n    log_required: false\n    when:\n      path: "src/unenforced/**"\n`,
  );
  const excludedBlock =
    opts.excluded && opts.excluded.length > 0
      ? `  excluded:\n${opts.excluded.map((e) => `    - ${e}`).join('\n')}\n`
      : '';
  const coverageBlock = opts.typeLevel || excludedBlock
    ? `coverage:\n${excludedBlock}${opts.typeLevel ? '  type_level: true\n' : ''}`
    : '';
  w(
    dir,
    '.yggdrasil/yg-config.yaml',
    `reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n${coverageBlock}`,
  );
  // `yg advise` never runs a reviewer, so content is immaterial — it only needs
  // to be effective, non-draft, and file-scoped so a type-covered file (no
  // owning component) can actually carry it.
  w(dir, '.yggdrasil/aspects/covered-rule/yg-aspect.yaml', `name: Covered Rule\ndescription: a rule\nreviewer:\n  type: llm\nscope:\n  per: file\n`);
  w(dir, '.yggdrasil/aspects/covered-rule/content.md', `# Covered Rule\n\nThe file must be covered.\n`);
  return dir;
}

function git(args: string[], dir: string): void {
  spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

function gitInit(dir: string): void {
  git(['init', '-q'], dir);
  git(['config', 'user.email', 't@t.t'], dir);
  git(['config', 'user.name', 't'], dir);
}

function commitAll(dir: string, message: string): void {
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', message], dir);
}

describe.skipIf(!distExists)('CLI E2E — yg advise type-covered-churn graduation nomination', () => {
  it('1. nominates graduation for a churning type-covered file, naming the file, its churn count, and its matched type (exit 0)', () => {
    const dir = makeFixture('single', { typeLevel: true });
    try {
      gitInit(dir);
      w(dir, 'src/svc/handler.ts', 'export const v = 1;\n');
      commitAll(dir, 'init');
      w(dir, 'src/svc/handler.ts', 'export const v = 2;\n');
      commitAll(dir, 'b');
      w(dir, 'src/svc/handler.ts', 'export const v = 3;\n');
      commitAll(dir, 'c');

      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0); // never gates (G4)

      expect(stdout).toContain(GRAD_WHAT('src/svc/handler.ts', 'svc'));
      expect(stdout).toContain('3');
      expect(stdout).toMatch(/create an explicit node/i);
      // A suggestion, never an automatic action — requires the user's sign-off.
      expect(stdout).toMatch(/requires their approval|requires.*approval/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2. a cluster of two same-type files importing each other upgrades the evidence, both files named', () => {
    const dir = makeFixture('cluster', { typeLevel: true });
    try {
      gitInit(dir);
      w(dir, 'src/svc/a.ts', "import { b } from './b.js';\nexport const a = 1 + b;\n");
      w(dir, 'src/svc/b.ts', 'export const b = 2;\n');
      commitAll(dir, 'init');
      w(dir, 'src/svc/a.ts', "import { b } from './b.js';\nexport const a = 2 + b;\n");
      commitAll(dir, 'touch a');
      w(dir, 'src/svc/b.ts', 'export const b = 3;\n');
      commitAll(dir, 'touch b');

      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0);

      expect(stdout).toContain(GRAD_WHAT('src/svc/a.ts', 'svc'));
      expect(stdout).toContain(GRAD_WHAT('src/svc/b.ts', 'svc'));
      expect(stdout).toMatch(/cluster/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3. never attributes an excluded file's churn to the class, and its evidence agrees with `yg owner --file` (exit 0)", () => {
    const dir = makeFixture('excluded', { typeLevel: true, excluded: ['src/svc/vendor'] });
    try {
      gitInit(dir);
      // Commit A: the real (non-excluded) file plus an excluded generated file
      // under the SAME type-classified directory.
      w(dir, 'src/svc/kept.ts', 'export const kept = 1;\n');
      w(dir, 'src/svc/vendor/generated.ts', 'export const g = 1;\n');
      commitAll(dir, 'init');
      // A second edit to the real file — churn 2, beyond its creating commit.
      w(dir, 'src/svc/kept.ts', 'export const kept = 2;\n');
      commitAll(dir, 'kept edit');
      // Six more commits touching ONLY the excluded generated file.
      for (let i = 2; i <= 7; i++) {
        w(dir, 'src/svc/vendor/generated.ts', `export const g = ${i};\n`);
        commitAll(dir, `gen ${i}`);
      }

      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0);

      // The real file nominates with churn 2 — the six excluded-only commits never count.
      expect(stdout).toContain(GRAD_WHAT('src/svc/kept.ts', 'svc'));
      expect(stdout).toContain('2 of the last 200 commits');
      expect(stdout).not.toContain('7 commit');
      expect(stdout).not.toContain('vendor/generated.ts');
      // No nomination at all for the excluded file itself.
      expect(stdout).not.toContain(GRAD_WHAT('src/svc/vendor/generated.ts', 'svc'));

      // Agreement: the same path every other ownership surface calls excluded.
      const owner = run(['owner', '--file', 'src/svc/vendor/generated.ts'], dir);
      expect(owner.status).toBe(0);
      expect(owner.stdout).toContain('excluded from graph coverage by design');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5. a churning file whose matched type carries NO effective aspect is never nominated (exit 0)', () => {
    const dir = makeFixture('unenforced', { typeLevel: true });
    try {
      gitInit(dir);
      w(dir, 'src/unenforced/plain.ts', 'export const v = 1;\n');
      commitAll(dir, 'init');
      w(dir, 'src/unenforced/plain.ts', 'export const v = 2;\n');
      commitAll(dir, 'b');
      w(dir, 'src/unenforced/plain.ts', 'export const v = 3;\n');
      commitAll(dir, 'c');

      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0); // never gates (G4)

      // Matches what yg owner --file already says about the same file: the type
      // covers it, but nothing from it enforces on it.
      const owner = run(['owner', '--file', 'src/unenforced/plain.ts'], dir);
      expect(owner.status).toBe(0);
      expect(owner.stdout).toContain('nothing from it enforces on this file');
      expect(stdout).not.toContain(GRAD_WHAT('src/unenforced/plain.ts', 'unenforced'));
      expect(stdout).not.toContain('has no node of its own');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4. with the tier OFF, output is BYTE-IDENTICAL whether or not a classifying type exists for these files (flag-off leaves this surface untouched)', () => {
    // Same file tree, same commit sequence, same architecture (the `svc` type
    // declaration is unconditional — only the coverage.type_level FLAG differs,
    // and here it is simply never set at all in either fixture). If turning the
    // tier off were merely "quiet about the new class" rather than a true no-op,
    // some OTHER difference (a count, a churn line, an ordering) could still leak
    // through; comparing two runs that differ ONLY in whether a matching type is
    // even declared is the strongest available proof that nothing does.
    const withType = makeFixture('offA', { typeLevel: false });
    const withoutType = mkdtempSync(path.join(tmpdir(), 'yg-advise-typechurn-offB-'));
    try {
      // withoutType: identical config, but NO node_types entry at all — nothing
      // in the architecture could ever classify src/svc/**, tier flag absent either way.
      mkdirSync(path.join(withoutType, '.yggdrasil', 'model'), { recursive: true });
      w(withoutType, '.yggdrasil/yg-architecture.yaml', 'node_types:\n  placeholder:\n    description: unused\n    log_required: false\n');
      w(
        withoutType,
        '.yggdrasil/yg-config.yaml',
        'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n',
      );

      for (const dir of [withType, withoutType]) {
        gitInit(dir);
        w(dir, 'src/svc/handler.ts', 'export const v = 1;\n');
        commitAll(dir, 'init');
        w(dir, 'src/svc/handler.ts', 'export const v = 2;\n');
        commitAll(dir, 'b');
        w(dir, 'src/svc/handler.ts', 'export const v = 3;\n');
        commitAll(dir, 'c');
      }

      const a = run(['advise'], withType);
      const b = run(['advise'], withoutType);
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      expect(a.stdout).not.toContain('has no node of its own');
      expect(a.stdout).toBe(b.stdout);
    } finally {
      rmSync(withType, { recursive: true, force: true });
      rmSync(withoutType, { recursive: true, force: true });
    }
  });
});
