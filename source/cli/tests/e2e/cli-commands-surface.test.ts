import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Harness reused verbatim from cli-deterministic-fill-lifecycle.test.ts:
// run(args, cwd) spawnSync wrapper, BIN_PATH resolution, describe.skipIf,
// copyFixture. Fully hermetic — each test builds its own temp dir and removes
// it in a finally; no committed fixtures are mutated, no network, no clock.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-surface-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** An empty temp dir with NO .yggdrasil/ — for the no-graph error path. */
function emptyDir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `yg-surface-empty-${label}-`));
}

// ---------------------------------------------------------------------------
// CLI command surface: flag mutual-exclusion rejections, resource-not-found
// paths, required-subcommand / required-argument errors, numeric-option
// validation, empty-query rejection, and the no-.yggdrasil error path — for
// every command/flag combination not already pinned by another e2e suite.
// All deterministic: zero LLM calls (these are guard/parse paths that abort
// before any reviewer dispatch).
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — command surface: mutex, not-found, required-subcommand, option validation', () => {
  // === A. Flag mutual-exclusion rejections not pinned elsewhere ===

  it('A1: context with BOTH --node and --file is rejected (exit 1, "Conflicting options")', () => {
    // cli-query only pins the NEITHER case ("--node ... or --file ... is
    // required"); the BOTH case (mutually exclusive) is pinned only here.
    const dir = copyFixture('a1');
    try {
      const { status, stderr } = run(
        ['context', '--node', 'services/orders', '--file', 'src/services/orders.ts'],
        dir,
      );
      expect(status).toBe(1);
      expect(stderr).toContain('Conflicting options.');
      expect(stderr).toContain("'--node' and '--file' are mutually exclusive.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A2/A3 REMOVED — the `yg approve` command (and its --dry-run / --node /
  // --aspect / --flow targeting and "No target specified" guards) is entirely
  // gone in the verdict-lock model: verification now happens through the
  // repo-wide `yg check --approve` fill, which has no scoping flags and no
  // dry-run. The removed-surface contract is pinned by A2 below.

  it('A2: the removed `yg approve` command is rejected as an unknown command (exit 1)', () => {
    // `yg approve` no longer exists — fill is repo-wide via `yg check --approve`.
    // Commander rejects the bare subcommand with "unknown command" on stderr.
    const dir = copyFixture('a2');
    try {
      const { status, stderr } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain("unknown command 'approve'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A3: `yg check --help` lists the --approve fill flag that replaced `yg approve`', () => {
    // The replacement surface: fill is a flag on check, not its own command.
    const dir = copyFixture('a3');
    try {
      const { status, stdout } = run(['check', '--help'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('--approve');
      expect(stdout).toContain('Fill every unverified pair');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === B. Resource-not-found paths & removed-command surface ===

  // B1/B2/B3 REMOVED — `approve --aspect <unknown>`, `approve --flow <unknown>`,
  // and the `approve --aspect <draft-default>` no-op batch all targeted the
  // removed `yg approve` batch-targeting modes. Fill has no per-aspect / per-flow
  // scoping, so these resource-not-found-under-approve paths no longer exist.

  it('B1: the removed `yg deterministic-test` command is rejected as an unknown command (exit 1)', () => {
    // `yg deterministic-test` was renamed to `yg aspect-test`; the old name is gone.
    const dir = copyFixture('b1');
    try {
      const { status, stderr } = run(
        ['deterministic-test', '--aspect', 'no-todo-comments', '--node', 'services/orders'],
        dir,
      );
      expect(status).toBe(1);
      expect(stderr).toContain("unknown command 'deterministic-test'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B2: `yg aspect-test --help` is present — the replacement for deterministic-test', () => {
    const dir = copyFixture('b2');
    try {
      const { status, stdout } = run(['aspect-test', '--help'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Usage: yg aspect-test');
      expect(stdout).toContain('--aspect');
      expect(stdout).toContain('--node');
      expect(stdout).toContain('--files');
      expect(stdout).toContain('--check-determinism');
      expect(stdout).toContain('--dry-run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B4: aspect-test --node <unknown> reports node-not-found (exit 1)', () => {
    // aspect-not-found, both-flags, neither-flags are pinned by other suites; the
    // unknown-node branch of --node mode is pinned only here.
    const dir = copyFixture('b4');
    try {
      const { status, all } = run(
        ['aspect-test', '--aspect', 'no-todo-comments', '--node', 'services/ghost'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('error[node-not-found]');
      expect(all).toContain("'services/ghost'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === C. Required-subcommand / required-argument / unknown-subcommand ===

  it('C1: log with an UNKNOWN subcommand is rejected (exit 1, "unknown command")', () => {
    // cli-lifecycle pins the NO-subcommand usage path; an unknown subcommand is
    // a different commander branch, pinned only here.
    const dir = copyFixture('c1');
    try {
      const { status, all } = run(['log', 'frobnicate'], dir);
      expect(status).toBe(1);
      expect(all).toContain("unknown command 'frobnicate'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C2: knowledge with an UNKNOWN subcommand is rejected (exit 1, "unknown command")', () => {
    // cli-query pins the NO-subcommand usage path; unknown subcommand only here.
    const dir = copyFixture('c2');
    try {
      const { status, all } = run(['knowledge', 'frobnicate'], dir);
      expect(status).toBe(1);
      expect(all).toContain("unknown command 'frobnicate'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C3: knowledge read with NO topic name is rejected (exit 1, missing required argument)', () => {
    const dir = copyFixture('c3');
    try {
      const { status, all } = run(['knowledge', 'read'], dir);
      expect(status).toBe(1);
      expect(all).toContain("missing required argument 'name'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C4: schemas with an UNKNOWN subcommand is rejected (exit 1, "unknown command")', () => {
    // Mirrors C2 for the new `yg schemas` surface — unknown subcommand branch.
    const dir = copyFixture('c4');
    try {
      const { status, all } = run(['schemas', 'frobnicate'], dir);
      expect(status).toBe(1);
      expect(all).toContain("unknown command 'frobnicate'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C5: schemas read with NO schema name is rejected (exit 1, missing required argument)', () => {
    const dir = copyFixture('c5');
    try {
      const { status, all } = run(['schemas', 'read'], dir);
      expect(status).toBe(1);
      expect(all).toContain("missing required argument 'name'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === D. Numeric / query option validation ===

  it('D1: tree --depth with a NEGATIVE value is rejected (exit 1, non-negative integer)', () => {
    // cli-deterministic-fill-lifecycle E13 pins the non-numeric case; the negative
    // (parses to a number, but < 0) branch is pinned only here.
    const dir = copyFixture('d1');
    try {
      const { status, all } = run(['tree', '--depth', '-1'], dir);
      expect(status).toBe(1);
      expect(all).toContain('--depth must be a non-negative integer.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D2: find with a WHITESPACE-only query is rejected (exit 1, "Query is required")', () => {
    // cli-query pins the no-arg case; a present-but-blank query trims to empty
    // and hits the same guard — pinned only here.
    const dir = copyFixture('d2');
    try {
      const { status, all } = run(['find', '   '], dir);
      expect(status).toBe(1);
      expect(all).toContain('Query is required');
      expect(all).toContain('yg find needs at least one keyword to search.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D3: find with an EMPTY-STRING query is rejected (exit 1, "Query is required")', () => {
    // Distinct from whitespace: an explicit '' argument is supplied (not absent),
    // so the empty-after-trim guard — not commander's missing-argument — fires.
    const dir = copyFixture('d3');
    try {
      const { status, all } = run(['find', ''], dir);
      expect(status).toBe(1);
      expect(all).toContain('Query is required');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === E. No-.yggdrasil error path for commands that lack one elsewhere ===

  it('E1: check --approve (the fill that replaced approve) in a no-.yggdrasil/ dir aborts with the init hint (exit 1)', () => {
    const dir = emptyDir('e1');
    try {
      const { status, stderr } = run(['check', '--approve'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('No .yggdrasil/ directory found');
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E2: impact in a directory with no .yggdrasil/ aborts with the init hint (exit 1)', () => {
    const dir = emptyDir('e2');
    try {
      const { status, stderr } = run(['impact', '--node', 'x'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('No .yggdrasil/ directory found');
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E3: aspect-test (the rename of deterministic-test) in a no-.yggdrasil/ dir aborts with the init hint (exit 1)', () => {
    const dir = emptyDir('e3');
    try {
      const { status, stderr } = run(['aspect-test', '--aspect', 'x', '--node', 'y'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('No .yggdrasil/ directory found');
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E4: log add in a directory with no .yggdrasil/ aborts with the init hint (exit 1)', () => {
    const dir = emptyDir('e4');
    try {
      const { status, stderr } = run(['log', 'add', '--node', 'x', '--reason', 'y'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('No .yggdrasil/ directory found');
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E5: knowledge read needs NO graph — it prints the topic even with no .yggdrasil/ (exit 0)', () => {
    // The embedded knowledge base is graph-independent: `yg knowledge read`
    // resolves entirely from compiled-in content and never loads a graph, so it
    // succeeds in a bare directory. This pins that intentional contract.
    const dir = emptyDir('e5');
    try {
      const { status, stdout } = run(['knowledge', 'read', 'flows'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Flow');
      expect(stdout.length).toBeGreaterThan(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E6: schemas read needs NO graph — it prints the schema even with no .yggdrasil/ (exit 0)', () => {
    // The embedded schema reference is graph-independent, exactly like
    // `yg knowledge read` (E5): it resolves from compiled-in content and never
    // loads a graph, so it succeeds in a bare directory.
    const dir = emptyDir('e6');
    try {
      const { status, stdout } = run(['schemas', 'read', 'node'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('# yg-node.yaml');
      expect(stdout.length).toBeGreaterThan(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
