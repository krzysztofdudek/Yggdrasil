// =============================================================================
// CLI E2E — the "uncovered hot spot" nomination in `yg advise` (wave-6, RZ-17).
//
// Pins the public CLI surface (spawn the built bin.js). `yg advise` nominates a
// node whose mapped source CHURNS (changes across recent commits) yet has NO
// enforced rule covering it — the code most in motion with the least protection.
// The churn is measured READ-ONLY from real git history; the nomination carries the
// churn count, a capped file sample, and its provenance as QUOTED DATA, and names a
// human NEXT that requires approval. It is a suggestion, never an automatic rule.
// Every scenario asserts exit 0 (the attention layer never gates — G4).
//
//   1. a git repo whose zero-aspect node churns → the hot-spot nomination fires with
//      its evidence; a node covered by an enforced rule that ALSO churns is absent
//   2. a git repo with NO commits (no readable history) → churn UNKNOWN → SILENT
//   3. not a git repo at all → churn UNKNOWN → SILENT (never fabricated as 0-and-fired)
//   4. a SHALLOW clone (real commits, truncated history) → churn UNKNOWN → SILENT
//      (a truncated 200-commit window would undercount while the provenance overstates)
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

/** The verbatim hot-spot WHAT line for a node id (only the id varies). */
const HOT_WHAT = (id: string) => `Node '${id}' is changing but has no rule covering it.`;

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
 * A loadable graph with two units: `hot` (type bare, NO rules) mapping src/bare, and
 * `safe` (type guarded, carrying an enforced rule) mapping src/guarded. Only `hot`
 * can ever be an uncovered hot spot.
 */
function makeFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-advise-hot-${label}-`));
  w(
    dir,
    '.yggdrasil/yg-architecture.yaml',
    `node_types:\n` +
      `  bare:\n    description: 'a unit with no rules'\n    log_required: false\n    when:\n      path: "src/bare/**"\n` +
      `  guarded:\n    description: 'a unit with a rule'\n    log_required: false\n    aspects:\n      - covered-rule\n    when:\n      path: "src/guarded/**"\n`,
  );
  w(
    dir,
    '.yggdrasil/yg-config.yaml',
    `reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n`,
  );
  // An enforced (default status) LLM rule attached to `guarded`. `yg advise` never
  // runs a reviewer, so content is immaterial — it only needs to be effective and
  // non-draft so `safe` reads as covered.
  w(dir, '.yggdrasil/aspects/covered-rule/yg-aspect.yaml', `name: Covered Rule\ndescription: a rule\nreviewer:\n  type: llm\n`);
  w(dir, '.yggdrasil/aspects/covered-rule/content.md', `# Covered Rule\n\nThe unit must be covered.\n`);
  w(dir, '.yggdrasil/model/hot/yg-node.yaml', `name: Hot\ndescription: churny uncovered unit\ntype: bare\nmapping:\n  - src/bare\n`);
  w(dir, '.yggdrasil/model/safe/yg-node.yaml', `name: Safe\ndescription: churny covered unit\ntype: guarded\nmapping:\n  - src/guarded\n`);
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

describe.skipIf(!distExists)('CLI E2E — yg advise uncovered hot spot', () => {
  it('1. nominates a churning zero-aspect node with evidence; a covered churner is absent (exit 0)', () => {
    const dir = makeFixture('fires');
    try {
      gitInit(dir);
      // Commit A: the graph + both source files. hot +1, safe +1.
      w(dir, 'src/bare/a.ts', 'export const a = 1;\n');
      w(dir, 'src/guarded/b.ts', 'export const b = 1;\n');
      commitAll(dir, 'init');
      // Commits B, C: edit only src/bare/a.ts → hot churn climbs to 3.
      w(dir, 'src/bare/a.ts', 'export const a = 2;\n');
      commitAll(dir, 'b');
      w(dir, 'src/bare/a.ts', 'export const a = 3;\n');
      commitAll(dir, 'c');

      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0); // never gates (G4)

      // The hot spot fires with its verbatim WHAT, count, and quoted-data evidence.
      expect(stdout).toContain(HOT_WHAT('hot'));
      expect(stdout).toContain("3 of the last 200 commits touched this node's files");
      expect(stdout).toContain('the code most in motion has the least protection');
      expect(stdout).toContain('Evidence: src/bare/a.ts (last 200 commits, from git history).');
      // Human NEXT requiring approval — a suggestion, never an automatic rule.
      expect(stdout).toContain('propose an aspect or a coverage node');
      expect(stdout).toContain('requires their approval');

      // A node covered by an enforced rule is NEVER an uncovered hot spot, however
      // much it churns.
      expect(stdout).not.toContain(HOT_WHAT('safe'));

      // It lives under Nominations (a T1 class), below the Attention section.
      expect(stdout.indexOf('Nominations')).toBeLessThan(stdout.indexOf(HOT_WHAT('hot')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2. stays SILENT in a git repo with no commits (no readable history), exit 0', () => {
    const dir = makeFixture('nohistory');
    try {
      gitInit(dir); // initialized, but nothing committed → git log fails → churn unknown
      w(dir, 'src/bare/a.ts', 'export const a = 1;\n');
      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0);
      expect(stdout).not.toContain('is changing but has no rule covering it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3. stays SILENT when the fixture is not a git repo at all, exit 0', () => {
    const dir = makeFixture('nogit');
    try {
      expect(existsSync(path.join(dir, '.git'))).toBe(false);
      w(dir, 'src/bare/a.ts', 'export const a = 1;\n');
      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0);
      // No git ⇒ churn UNKNOWN ⇒ the class is omitted, never fabricated as 0-and-fired.
      expect(stdout).not.toContain('is changing but has no rule covering it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4. stays SILENT on a shallow clone despite real churn (truncated window), exit 0', () => {
    const src = makeFixture('shallow-src');
    const dst = mkdtempSync(path.join(tmpdir(), 'yg-advise-hot-shallow-dst-'));
    try {
      // A source repo whose zero-aspect node genuinely churns (would fire on full history).
      gitInit(src);
      w(src, 'src/bare/a.ts', 'export const a = 1;\n');
      commitAll(src, 'init');
      w(src, 'src/bare/a.ts', 'export const a = 2;\n');
      commitAll(src, 'b');
      w(src, 'src/bare/a.ts', 'export const a = 3;\n');
      commitAll(src, 'c');

      // A genuine shallow clone: file:// protocol + --depth so git truncates history
      // (a plain local path hardlinks and ignores --depth). Allow file:// explicitly.
      const clone = spawnSync(
        'git',
        ['-c', 'protocol.file.allow=always', 'clone', '--depth', '1', `file://${src}`, dst],
        { encoding: 'utf-8' },
      );
      expect(clone.status).toBe(0);
      // Sanity: the clone really is shallow.
      const isShallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: dst,
        encoding: 'utf-8',
      });
      expect((isShallow.stdout ?? '').trim()).toBe('true');

      const { status, stdout } = run(['advise'], dst);
      expect(status).toBe(0);
      // Shallow ⇒ history is truncated ⇒ churn UNKNOWN ⇒ SILENT (never a partial-window
      // count that would undercount churn while the provenance overstates the window).
      expect(stdout).not.toContain('is changing but has no rule covering it');
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });
});
