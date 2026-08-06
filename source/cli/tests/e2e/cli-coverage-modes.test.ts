import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture } from '../support/git-fixture.js';

// ---------------------------------------------------------------------------
// Hermetic E2E for scoped coverage (coverage.required / coverage.excluded).
//
// Unlike the other check E2E suites, these spawn the REAL built binary against
// a GIT-INITIALIZED temp fixture, because the unmapped-files / uncovered scan
// only runs when `git ls-files` returns tracked files. Each test asserts the
// PROCESS EXIT CODE and the rendered tier blocks — the contract that the
// runCheck-level integration tests cannot reach (the CLI wrapper + real exit).
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
 * Scaffold a git repo with a scoped-coverage config and one aspect-less service
 * node, then `git add` everything so `git ls-files` feeds the coverage scan.
 *   - required: src/svc/  | excluded: vendor/
 *   - src/svc/i.ts is mapped (covered); lib/u.ts → middle (warning);
 *     vendor/v.ts → excluded (silent); apps/ has its own nested .yggdrasil (skipped).
 * `mapping` controls the node's mapping; `extraSvcFile` adds an unmapped sibling
 * under the required root to force a required-tier error.
 */
function scaffold(label: string, opts: { mapping: string; extraSvcFile?: boolean }): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-cov-e2e-${label}-`));
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
      '    - src/svc/',
      '  excluded:',
      '    - vendor/',
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
    `name: Svc\ntype: service\ndescription: demo\nmapping:\n  - ${opts.mapping}\n`,
    'utf-8',
  );
  mkdirSync(path.join(dir, 'src', 'svc'), { recursive: true });
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  mkdirSync(path.join(dir, 'vendor'), { recursive: true });
  mkdirSync(path.join(dir, 'apps', 'web'), { recursive: true });
  mkdirSync(path.join(dir, 'apps', '.yggdrasil'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'svc', 'i.ts'), '', 'utf-8');
  if (opts.extraSvcFile) writeFileSync(path.join(dir, 'src', 'svc', 'extra.ts'), '', 'utf-8');
  writeFileSync(path.join(dir, 'lib', 'u.ts'), '', 'utf-8');
  writeFileSync(path.join(dir, 'vendor', 'v.ts'), '', 'utf-8');
  writeFileSync(path.join(dir, 'apps', 'web', 'main.ts'), '', 'utf-8');
  writeFileSync(path.join(dir, 'apps', '.yggdrasil', 'yg-config.yaml'), 'version: "5.2.0"\n', 'utf-8');
  git(['init', '-q'], dir);
  git(['config', 'user.email', 't@t.t'], dir);
  git(['config', 'user.name', 't'], dir);
  git(['add', '-A'], dir);
  return dir;
}

describe('E2E: scoped coverage via the real CLI binary', () => {
  it.skipIf(!distExists)(
    'advisory-only run exits 0 (PASS), renders the uncovered warning, keeps excluded silent and nested skipped',
    () => {
      // mapping `src/svc/` covers src/svc/i.ts → no required-tier error; lib/u.ts → middle warning.
      const dir = scaffold('advisory', { mapping: 'src/svc/' });
      try {
        // Seed the mapped node's relation verdict (empty registry → approved); a plain check would
        // otherwise be exit 1 on the unverified relation verdict every mapped node now carries.
        expect(run(['check', '--approve'], dir).status).toBe(0);
        const { status, out } = run(['check'], dir);
        expect(status).toBe(0); // advisory-only must NOT block
        expect(out).toContain('PASS');
        expect(out).toContain('uncovered (1)'); // middle-tier warning block rendered
        expect(out).toContain('lib/u.ts');
        expect(out).not.toContain('vendor/v.ts'); // excluded → silent
        expect(out).not.toContain('apps/web/main.ts'); // nested .yggdrasil subtree → skipped
        expect(out).not.toContain('unmapped ('); // no required-tier error
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!distExists)(
    'a file unmapped under a required root is a blocking error: exits 1 (FAIL) and renders unmapped (N)',
    () => {
      // narrow mapping to the exact file so src/svc/extra.ts is unmapped UNDER required → error.
      const dir = scaffold('required-error', { mapping: 'src/svc/i.ts', extraSvcFile: true });
      try {
        const { status, out } = run(['check'], dir);
        expect(status).toBe(1); // required-tier error blocks
        expect(out).toContain('FAIL');
        expect(out).toContain('unmapped (1)'); // required-tier error block rendered
        expect(out).toContain('src/svc/extra.ts');
        expect(out).toContain('uncovered (1)'); // lib/u.ts still a non-blocking warning
        expect(out).not.toContain('vendor/v.ts'); // excluded → silent
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
