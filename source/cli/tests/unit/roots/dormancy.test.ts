import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// tests/unit/roots/dormancy.test.ts — pins the Additive-increment / Dormant-
// without-config invariant: a project whose yg-config.yaml has no `roots:`
// block gets ZERO runtime change from the roots increment. `yg check`'s exit
// code and stdout on a no-roots: fixture must stay byte-identical to what the
// PRE-increment binary produced.
//
// The golden below is a captured, hardcoded snapshot — not re-derived at run
// time (a test cannot re-run the pre-change tree to get it). It was captured
// by building dist/bin.js from the tree at the commit immediately before this
// increment's first change and running `yg check` against a temp copy of the
// committed tests/fixtures/e2e-lifecycle fixture (which carries no `roots:`
// key). Precedent for the technique:
// tests/e2e/cli-aspects-health.test.ts's DEFAULT_ASPECTS_GOLDEN, which pins
// yg aspects output the same way and proves the output is byte-stable across
// runs. The unit-tree home (rather than tests/e2e/) follows the precedent at
// tests/unit/bounty2/gitignore.test.ts, which already spawns dist/bin.js from
// this same tree.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const PRE_ROOTS_CHECK_GOLDEN_STDOUT =
  'yg check: FAIL  3 nodes · 2/2 files · 4 aspects · 1 flows · 1 draft\n' +
  '\n' +
  'Errors (4):\n' +
  '\n' +
  '  unverified (not yet reviewed)  4 pairs  2 nodes\n' +
  '            The lock holds no entry for this pair, or its inputs changed since the verdict was recorded (source edit, aspect edit, or a fill that did not complete). A verdict is valid only while its inputs hash to the stored value.\n' +
  '            Fix: yg check --approve\n' +
  '            - services/orders  aspect \'has-doc-comment\'\n' +
  '            - services/orders  aspect \'no-todo-comments\'\n' +
  '            - services/payments  aspect \'has-doc-comment\'\n' +
  '            - services/payments  aspect \'no-todo-comments\'\n' +
  '\n' +
  'Warnings (3) in 2 groups:\n' +
  '\n' +
  '  unverified (not yet reviewed)  2 pairs  2 nodes\n' +
  '            The lock holds no entry for this pair, or its inputs changed since the verdict was recorded (source edit, aspect edit, or a fill that did not complete). A verdict is valid only while its inputs hash to the stored value.\n' +
  '            Fix: yg check --approve\n' +
  '            - services/orders  aspect \'requires-named-export\'\n' +
  '            - services/payments  aspect \'requires-named-export\'\n' +
  '\n' +
  '  rules-digest-stale\n' +
  '            Committed agent-rules digest is out of sync: AGENTS.md digest block is missing; .clinerules/yggdrasil.md is missing; CLAUDE.md @AGENTS.md import is missing.\n' +
  '            Why: Agents read the committed digest before running yg prime; a stale, hand-edited, or missing digest means agents may follow outdated rules or none at all.\n' +
  '            Fix: yg init --upgrade\n' +
  '\n' +
  'Next: yg check --approve\n';

const PRE_ROOTS_CHECK_GOLDEN_EXIT_CODE = 1;

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-roots-dormancy-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)('roots dormancy — yg check is byte-identical on a project with no roots: block', () => {
  it('exit code and stdout match the pre-roots-increment golden exactly', () => {
    const dir = copyFixture();
    try {
      const result = run(['check'], dir);
      expect(result.status).toBe(PRE_ROOTS_CHECK_GOLDEN_EXIT_CODE);
      expect(result.stdout).toBe(PRE_ROOTS_CHECK_GOLDEN_STDOUT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the fixture itself carries no roots: key (guards the golden against a fixture edit silently changing what this pins)', () => {
    const dir = copyFixture();
    try {
      const cfg = path.join(dir, '.yggdrasil', 'yg-config.yaml');
      const content = readFileSync(cfg, 'utf-8');
      expect(content).not.toMatch(/^roots:/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
