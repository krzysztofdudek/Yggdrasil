import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture } from '../support/git-fixture.js';

// ---------------------------------------------------------------------------
// Hermetic E2E for the tracked∩gitignored anomaly check (`tracked-file-gitignored`),
// which replaced `mapped-file-gitignored`.
//
// Both the coverage walk (walkRepoFiles) and mapping expansion are plain disk
// walks that skip anything `.gitignore` excludes — neither consults the git
// index. So a file that is git-TRACKED (`git add -f`, or a `.gitignore` rule
// added after the file was already tracked) but gitignored is invisible to
// every one of those layers: it ships in the repository, yet nothing that
// governs coverage, classification, or enforcement ever sees it. The one
// remaining git consumer in this surface, `listGitTrackedFiles` (real
// `git ls-files`), feeds `scanTrackedButIgnored`, which flags exactly this —
// independent of node mapping, unlike the retired `mapped-file-gitignored`
// (which assumed the coverage scan itself was git-index-fed; it no longer is,
// so that detector could never fire and was removed):
//   - severity 'error' when the file falls under a `coverage.required` root
//   - severity 'warning' otherwise
//   - silently skipped when git is unavailable (no git repo at all)
//
// No network / clock / random: the reviewer tier points at a loopback that is
// never dialed by `yg check` (no LLM call on the check path).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const LOOPBACK = 'http://127.0.0.1:11434';
const distExists = existsSync(BIN_PATH);

function git(args: string[], cwd: string): void {
  const r = runGitFixture(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function run(args: string[], cwd: string): { status: number | null; out: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

/**
 * Scaffold a git repo whose single service node maps the DIRECTORY `src/svc/`.
 * `src/svc/i.ts` is a normal tracked file; `src/svc/secret.ts` matches a
 * .gitignore rule but is force-added, so it is BOTH tracked AND gitignored —
 * invisible to the disk walk regardless of node mapping.
 *
 * @param requiredRoot the `coverage.required` root — 'src/svc/' puts the
 *   anomaly under a required root (error); 'other/' puts it outside every
 *   required root (warning).
 * @param initGit when false, the directory is never `git init`'d at all —
 *   `listGitTrackedFiles` then returns null and the check is silently skipped.
 */
function scaffold(label: string, opts: { requiredRoot: string; initGit?: boolean }): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-trackedignored-e2e-${label}-`));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'model', 'svc'), { recursive: true });
  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    ['node_types:', '  service:', "    description: 'A service'", '    log_required: false', '    when:', '      path: "**"', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(ygRoot, 'yg-config.yaml'),
    [
      'version: "5.2.0"',
      'coverage:',
      '  required:',
      `    - ${opts.requiredRoot}`,
      'reviewer:',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: test',
      `        endpoint: ${LOOPBACK}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(ygRoot, 'model', 'svc', 'yg-node.yaml'),
    'name: Svc\ntype: service\ndescription: demo\nmapping:\n  - src/svc/\n',
    'utf-8',
  );
  mkdirSync(path.join(dir, 'src', 'svc'), { recursive: true });
  // secret.ts matches this .gitignore rule but is force-added below.
  writeFileSync(path.join(dir, '.gitignore'), 'src/svc/secret.ts\n', 'utf-8');
  writeFileSync(path.join(dir, 'src', 'svc', 'i.ts'), '', 'utf-8');
  writeFileSync(path.join(dir, 'src', 'svc', 'secret.ts'), 'export const k = 1;\n', 'utf-8');
  if (opts.initGit !== false) {
    git(['init', '-q'], dir);
    git(['config', 'user.email', 't@t.t'], dir);
    git(['config', 'user.name', 't'], dir);
    git(['add', '-A'], dir); // tracks .gitignore, config, node, i.ts (NOT secret.ts — it's ignored)
    git(['add', '-f', 'src/svc/secret.ts'], dir); // force-track the gitignored file
  }
  return dir;
}

/**
 * Scaffold a git repo with NO `.gitignore` at all, whose service node maps
 * `src/`. Contains a tracked SYMLINK (`src/link.txt` → `src/real.txt`) and a
 * fabricated submodule GITLINK (`vendor/lib`, index mode 160000, checked out
 * as an empty directory) — both git-tracked, both absent from the disk walk,
 * NEITHER gitignored (there is no .gitignore to match against). A detector
 * that inferred "gitignored" from "tracked but walk-absent" alone would flag
 * both; the real check must not, since nothing here is actually gitignored.
 */
function scaffoldSymlinkAndGitlink(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-trackedignored-e2e-symlink-'));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'model', 'svc'), { recursive: true });
  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    ['node_types:', '  service:', "    description: 'A service'", '    log_required: false', '    when:', '      path: "**"', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(ygRoot, 'yg-config.yaml'),
    ['version: "5.2.0"', 'coverage:', '  required:', '    - src/', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(ygRoot, 'model', 'svc', 'yg-node.yaml'),
    'name: Svc\ntype: service\ndescription: demo\nmapping:\n  - src/\n',
    'utf-8',
  );
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'real.txt'), 'target\n', 'utf-8');
  symlinkSync('real.txt', path.join(dir, 'src', 'link.txt'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 't@t.t'], dir);
  git(['config', 'user.name', 't'], dir);
  git(['add', '-A'], dir); // tracks .yggdrasil/**, src/real.txt, and the src/link.txt symlink itself
  const fakeSha = 'a'.repeat(40);
  git(['update-index', '--add', '--cacheinfo', `160000,${fakeSha},vendor/lib`], dir);
  mkdirSync(path.join(dir, 'vendor', 'lib'), { recursive: true }); // checked-out submodule root: a directory
  return dir;
}

describe('E2E: the tracked∩gitignored anomaly check (disk-walk visibility vs. the git index)', () => {
  it.skipIf(!distExists)(
    'a force-tracked, gitignored file under a coverage.required root is a blocking tracked-file-gitignored error',
    () => {
      const dir = scaffold('required', { requiredRoot: 'src/svc/' });
      try {
        const { status, out } = run(['check'], dir);
        expect(out).toContain('tracked-file-gitignored');
        expect(out).toContain('secret.ts');
        expect(out).not.toContain('mapped-file-gitignored'); // retired — never emitted again
        expect(status).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!distExists)(
    'the same file is a non-blocking warning when it falls outside every coverage.required root',
    () => {
      const dir = scaffold('warn', { requiredRoot: 'other/' });
      try {
        const { status, out } = run(['check'], dir);
        expect(out).toContain('tracked-file-gitignored');
        expect(out).toContain('secret.ts');
        expect(out).not.toContain('mapped-file-gitignored');
        // i.ts falls under no required root either (only 'other/' is required),
        // so it is merely an uncovered-advisory warning too — no blocking error.
        expect(status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!distExists)(
    'CRITICAL regression: a tracked symlink and a submodule gitlink in a repo with NO .gitignore produce ZERO findings',
    () => {
      // Both are git-tracked and absent from the disk walk, exactly like a
      // gitignored file — but there is no .gitignore in this repo at all, so
      // neither is actually gitignored. A detector inferring "gitignored" from
      // walk-absence alone would flag both (the symlink's WHAT would falsely
      // claim ".gitignore", and the gitlink's NEXT — `git rm --cached` — would
      // be destructive advice for a submodule reference). The real check must
      // stay silent on both.
      const dir = scaffoldSymlinkAndGitlink();
      try {
        const { out } = run(['check'], dir);
        expect(out).not.toContain('tracked-file-gitignored');
        expect(out).not.toContain('mapped-file-gitignored');
        expect(out).not.toContain('link.txt');
        expect(out).not.toContain('vendor/lib');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!distExists)(
    'the anomaly check is silently skipped when the project is not a git repository at all',
    () => {
      const dir = scaffold('nogit', { requiredRoot: 'src/svc/', initGit: false });
      try {
        const { out } = run(['check'], dir);
        // No git ⇒ listGitTrackedFiles returns null ⇒ scanTrackedButIgnored is
        // skipped outright — the file is simply invisible (same as before this
        // check existed), not reported as either an error or a warning.
        expect(out).not.toContain('tracked-file-gitignored');
        expect(out).not.toContain('mapped-file-gitignored');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
