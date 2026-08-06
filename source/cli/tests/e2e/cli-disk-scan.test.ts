import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture } from '../support/git-fixture.js';

// ---------------------------------------------------------------------------
// E2E: disk-based file enumeration for coverage scan.
//
// `yg check` must enumerate files by walking the actual filesystem (respecting
// .gitignore), NOT by querying the git index. A file deleted from disk with
// `rm` (not `git rm`) must NOT appear in the unmapped-files error, because it
// no longer exists on disk.
//
// Two scenarios are pinned:
//   1. No-git: coverage scan works in a plain directory (no git repo needed).
//   2. Disk-deleted: a file removed with `rm` (still in git index) is not
//      reported as unmapped — only files that physically exist on disk are.
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

/** Minimal graph scaffold. mapping covers src/svc/i.ts exactly. */
function scaffoldGraph(dir: string): void {
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'model', 'svc'), { recursive: true });
  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    [
      'node_types:',
      '  service:',
      "    description: 'A service'",
      '    log_required: false',
      '    when:',
      '      path: "**"',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(ygRoot, 'yg-config.yaml'),
    [
      'version: "5.2.0"',
      'coverage:',
      '  required:',
      '    - src/svc/',
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
  );
  writeFileSync(
    path.join(ygRoot, 'model', 'svc', 'yg-node.yaml'),
    'name: Svc\ntype: service\ndescription: demo\nmapping:\n  - src/svc/i.ts\n',
  );
}

describe('E2E: disk-based coverage scan', () => {
  it.skipIf(!distExists)(
    'coverage scan works without a git repo — files on disk are discovered directly',
    () => {
      // No git init — proves disk scan does not require git.
      const dir = mkdtempSync(path.join(tmpdir(), 'yg-disk-nogit-'));
      try {
        scaffoldGraph(dir);
        mkdirSync(path.join(dir, 'src', 'svc'), { recursive: true });
        writeFileSync(path.join(dir, 'src', 'svc', 'i.ts'), '', 'utf-8');
        writeFileSync(path.join(dir, 'src', 'svc', 'unmapped.ts'), '', 'utf-8');

        const { status, out } = run(['check'], dir);

        // unmapped.ts is on disk but has no node mapping → blocking error
        expect(status).toBe(1);
        expect(out).toContain('unmapped (1)');
        expect(out).toContain('src/svc/unmapped.ts');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!distExists)(
    'a file deleted from disk with rm (still in git index) is NOT reported as unmapped',
    () => {
      // git repo: ghost.ts is tracked by git but deleted from disk with rm.
      // Only files that physically exist on disk should appear in the scan.
      const dir = mkdtempSync(path.join(tmpdir(), 'yg-disk-deleted-'));
      try {
        scaffoldGraph(dir);
        mkdirSync(path.join(dir, 'src', 'svc'), { recursive: true });
        writeFileSync(path.join(dir, 'src', 'svc', 'i.ts'), '', 'utf-8');
        writeFileSync(path.join(dir, 'src', 'svc', 'unmapped.ts'), '', 'utf-8');
        writeFileSync(path.join(dir, 'src', 'svc', 'ghost.ts'), '', 'utf-8');

        // Initialize git and track all files (including ghost.ts)
        git(['init', '-q'], dir);
        git(['config', 'user.email', 't@t.t'], dir);
        git(['config', 'user.name', 't'], dir);
        git(['add', '-A'], dir);

        // Delete ghost.ts from disk only — it remains in the git index
        unlinkSync(path.join(dir, 'src', 'svc', 'ghost.ts'));

        const { status, out } = run(['check'], dir);

        // unmapped.ts is on disk → reported as unmapped (error)
        expect(out).toContain('unmapped (1)');
        expect(out).toContain('src/svc/unmapped.ts');

        // ghost.ts is NOT on disk → must NOT be reported, even though git tracks it
        expect(out).not.toContain('ghost.ts');
        expect(status).toBe(1); // unmapped.ts still blocks
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
