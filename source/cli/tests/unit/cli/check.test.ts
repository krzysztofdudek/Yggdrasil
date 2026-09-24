import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, rm, writeFile, readFile, readdir, mkdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { digestBlockBody } from '../../../src/templates/digest.js';
import { YGGDRASIL_START, YGGDRASIL_END } from '../../../src/templates/platform.js';

/** Strip ANSI color codes so block counting / substring matching is stable. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Count rendered finding BLOCKS in stripped stdout: each block opens with a
 *  `error[<label>] <subject>` / `warning[<label>] <subject>` heading at column
 *  0; its at:/why:/fix: lines are indented continuations. */
function countBlocks(stdout: string): number {
  return stripAnsi(stdout)
    .split('\n')
    .filter((l) => /^(error|warning)\[[^\]]+\] /.test(l))
    .length;
}

/** Read every committed lock file under .yggdrasil/ as raw bytes, keyed by name.
 *  The committed triad is the two yg-lock.*.json files that are NOT dot-prefixed
 *  (the .yg-lock.deterministic.json cache is gitignored). Returns a stable map so
 *  a before/after comparison proves byte-identity (and detects a newly-created
 *  lock file as a changed key). */
async function readCommittedLockBytes(cwd: string): Promise<Record<string, string>> {
  const dir = path.join(cwd, '.yggdrasil');
  const entries = await readdir(dir).catch(() => [] as string[]);
  const locks = entries.filter((f) => /^yg-lock\..*\.json$/.test(f)).sort();
  const out: Record<string, string> = {};
  for (const f of locks) {
    out[f] = await readFile(path.join(dir, f), 'latin1');
  }
  return out;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');

async function withFixtureCopy<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ygg-check-'));
  await cp(FIXTURE, root, { recursive: true });
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Write AGENTS.md / CLAUDE.md / .clinerules/yggdrasil.md at `cwd`, all ALIGNED
 * with the running CLI's canonical digest (built from the real templates, not
 * hand-copied text), so the committed-digest staleness gate stays silent for
 * tests whose focus is unrelated to it. Since these fixtures ship no coverage
 * mapping for the three files, also excludes them from the graph's coverage
 * scan (appended to yg-config.yaml) — otherwise they would surface as a
 * SEPARATE unmapped-files error, trading one unrelated issue for another.
 */
async function writeAlignedDigestFiles(cwd: string): Promise<void> {
  const body = digestBlockBody('0.0.0-test'); // the `cli=` token is never compared
  await writeFile(path.join(cwd, 'AGENTS.md'), `${YGGDRASIL_START}\n${body}${YGGDRASIL_END}\n`, 'utf-8');
  await writeFile(path.join(cwd, 'CLAUDE.md'), '@AGENTS.md\n', 'utf-8');
  await mkdir(path.join(cwd, '.clinerules'), { recursive: true });
  await writeFile(path.join(cwd, '.clinerules', 'yggdrasil.md'), body, 'utf-8');
  await appendFile(
    path.join(cwd, '.yggdrasil', 'yg-config.yaml'),
    '\ncoverage:\n  required: ["/"]\n  excluded: ["AGENTS.md", "CLAUDE.md", ".clinerules/"]\n',
    'utf-8',
  );
}

describe('check command', () => {
  describe('exit codes', () => {
    it('exits 1 when the fixture has unverified pairs', async () => {
      // The sample-project fixture ships without a lock file, so all LLM
      // pairs are unverified — check must exit 1.
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.status).toBe(1);
      });
    });

    it('exits 1 when the lock file contains garbled JSON', async () => {
      await withFixtureCopy(async (cwd) => {
        // The runtime reads the 5.1.0 triad, not the legacy single file — garble a
        // committed triad file (the nondeterministic verdict file) to exercise the
        // lock-invalid path.
        await writeFile(
          path.join(cwd, '.yggdrasil', 'yg-lock.nondeterministic.json'),
          '{ not valid json',
          'utf-8',
        );
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.status).toBe(1);
      });
    });
  });

  describe('output content — clean fixture (unverified pairs)', () => {
    it('prints the check header with node and file-coverage counts', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        // Header format: "yg check: PASS|FAIL  <counts>   N nodes · X/Y files covered[ · …]"
        expect(result.stdout).toMatch(/yg check: (PASS|FAIL)/);
        expect(stripAnsi(result.stdout)).toMatch(/^yg check: FAIL {2}4 errors · 1 warning {3}9 nodes · 5\/5 files covered$/m);
      });
    });

    it('labels unverified pairs with the "unverified" issue label', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        // The fixture has no lock → pairs appear as "unverified"
        expect(result.stdout).toContain('unverified');
      });
    });

    it('suggests yg check --approve as the next step', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.stdout).toContain('yg check --approve');
      });
    });

    it('labels a mapping-path-missing issue correctly', async () => {
      // The sample-project has users/missing-service pointing to a file that
      // does not exist on disk — check must surface it as mapping-path-missing.
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.stdout).toContain('mapping-path-missing');
      });
    });
  });

  describe('output content — garbled lock', () => {
    it('labels the issue as lock-invalid and references the lock file', async () => {
      await withFixtureCopy(async (cwd) => {
        await writeFile(
          path.join(cwd, '.yggdrasil', 'yg-lock.nondeterministic.json'),
          '{ not valid json',
          'utf-8',
        );
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.stdout).toContain('lock-invalid');
        // The runtime reads the triad, so the garbled committed file referenced in the
        // error is yg-lock.nondeterministic.json.
        expect(result.stdout).toMatch(/yg-lock\.nondeterministic\.json/);
      });
    });

    it('does not emit "unverified" when the lock is garbled (fail closed)', async () => {
      // When the lock cannot be parsed, all individual pair checks are skipped
      // and only a single lock-invalid error is emitted.
      await withFixtureCopy(async (cwd) => {
        await writeFile(
          path.join(cwd, '.yggdrasil', 'yg-lock.nondeterministic.json'),
          '{ not valid json',
          'utf-8',
        );
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.stdout).not.toContain('unverified');
      });
    });
  });

  describe('--approve flag dispatch', () => {
    it('dispatches to the fill path and prints the `fill  …` progress on stderr (not stdout)', async () => {
      // --approve should invoke runFill (not just runCheck). The fixture has
      // LLM aspects with an unreachable reviewer, so fill prints a "fill  N
      // pairs · …" line before attempting the reviewer calls.
      // Progress goes to STDERR so STDOUT carries only the final check report.
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--approve'], {
          cwd,
          encoding: 'utf-8',
          timeout: 20000,
        });
        expect(result.stderr).toMatch(/^fill {2}3 pairs · 0 script \(free\) · 3 reviewer calls \(consensus included\)$/m);
        expect(result.stdout).not.toMatch(/^fill {2}/m);
      });
    });

    it('still reports the check result after --approve runs', async () => {
      // Even when the reviewer is unreachable, check --approve must print the
      // full check output (header + issues) after the fill attempt finishes.
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--approve'], {
          cwd,
          encoding: 'utf-8',
          timeout: 20000,
        });
        expect(result.stdout).toMatch(/yg check: (PASS|FAIL)/);
      });
    });

    it('exits 1 when the reviewer is unreachable and pairs remain unverified', async () => {
      // The fixture reviewer points at reserved port 1 (127.0.0.1:1), which is
      // guaranteed-closed regardless of any ambient LLM service on the dev
      // machine — fill fails on infrastructure deterministically, check exits 1.
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--approve'], {
          cwd,
          encoding: 'utf-8',
          timeout: 20000,
        });
        expect(result.status).toBe(1);
      });
    });
  });

  describe('--approve --dry-run cost preview', () => {
    it('on a cold lock prints the budget + per-node breakdown and leaves committed lock files byte-identical (exit 0)', async () => {
      // The fixture ships without any lock files. A dry-run runs the structural
      // gate + classification + budget, prints the breakdown, then returns
      // WITHOUT writing — the no-write guarantee is structural (the early-return
      // precedes the serialized writer's construction). Capture committed lock
      // bytes before/after to prove byte-identity (and that no lock file was
      // created).
      await withFixtureCopy(async (cwd) => {
        const before = await readCommittedLockBytes(cwd);

        const result = spawnSync('node', [BIN_PATH, 'check', '--approve', '--dry-run'], {
          cwd,
          encoding: 'utf-8',
          timeout: 20000,
        });

        expect(result.status).toBe(0);
        // Pre-dispatch budget header.
        expect(result.stdout).toContain('fill  dry run — a cost preview; nothing is filled or written');
        expect(result.stdout).toContain('fill  3 pairs · 0 script (free) · 3 reviewer calls');
        // Per-node / per-aspect breakdown: each billed pair labelled with its call count.
        expect(result.stdout).toMatch(/^ {2}requires-audit @ orders\/order-service — 1 reviewer call$/m);
        expect(result.stdout.match(/^ {2}\S+ @ \S+ — \d+ reviewer calls?$/gm)).toHaveLength(3);
        // The honest upper-bound caveat.
        expect(result.stdout).toContain('note: 3 reviewer calls is an upper bound');
        // The preview is the deliverable: no report of the unchanged tree under
        // it (whose FAIL header over an exit-0 preview read as the preview failing).
        expect(result.stdout).not.toMatch(/yg check: (PASS|FAIL)/);

        // STRUCTURAL no-write guarantee: committed lock files are byte-identical
        // and no new committed lock file was created.
        const after = await readCommittedLockBytes(cwd);
        expect(after).toEqual(before);
      });
    });

    it('never exits 1 even with unverified enforced pairs', async () => {
      // The cold fixture has unverified enforced LLM pairs (no lock). A real
      // `check --approve` (reviewer unreachable) exits 1; a preview exits 0 — it
      // never blocks the build, it only reports the prospective cost.
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--approve', '--dry-run'], {
          cwd,
          encoding: 'utf-8',
          timeout: 20000,
        });
        expect(result.status).toBe(0);
      });
    });

    it('--dry-run without --approve is a guided what/why/next usage error (exit 1)', async () => {
      // --dry-run is a MODE of --approve, not a standalone alias for the plain
      // read. On its own it is a usage error steering to the right command.
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--dry-run'], {
          cwd,
          encoding: 'utf-8',
          timeout: 20000,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('--dry-run requires --approve.');
        // Guided message structure: a why and a next steering to the preview.
        expect(result.stderr).toContain('yg check --approve --dry-run');
      });
    });

    it('previews a node that would otherwise need a fresh log entry — reports the requirement but never hard-stops the fill gate (exit 0, no writes)', async () => {
      // Flip the service type to log_required: true. On a cold lock this is a
      // first verification for nodes owning source. A dry-run intentionally
      // bypasses the step-4 fill gate — its early-return precedes that gate — so
      // the preview is never ABORTED by the hard-stop (no `log-entry-required`
      // aggregate, no `need a fresh log entry before --approve`): it computes and
      // prints the budget. The read-only check report it renders at the end still
      // surfaces the requirement (a normal check-level `log-entry-missing` error),
      // exactly as a plain `yg check` would — but the preview exits 0 and writes
      // nothing.
      await withFixtureCopy(async (cwd) => {
        const archPath = path.join(cwd, '.yggdrasil', 'yg-architecture.yaml');
        const arch = await readFile(archPath, 'utf-8');
        await writeFile(archPath, arch.replace(/log_required: false/g, 'log_required: true'), 'utf-8');

        const before = await readCommittedLockBytes(cwd);
        const result = spawnSync('node', [BIN_PATH, 'check', '--approve', '--dry-run'], {
          cwd,
          encoding: 'utf-8',
          timeout: 20000,
        });

        expect(result.status).toBe(0);
        // The preview ran (budget header present)…
        expect(result.stdout).toContain('fill  dry run — a cost preview');
        // …the FILL gate hard-stop did NOT fire (no abort, no aggregate block)…
        expect(result.stdout).not.toContain('log-entry-required');
        expect(result.stdout).not.toContain('need a fresh log entry before --approve');
        // …yet the read-only check report surfaces the requirement (informational),
        // confirming the preview reports state without blocking on it.
        expect(result.stdout).toContain('error[log-entry-missing] 3 nodes changed with no log entry');

        // Still no writes.
        const after = await readCommittedLockBytes(cwd);
        expect(after).toEqual(before);
      });
    });
  });

  describe('--top / --summary read-only triage views', () => {
    // The sample-project (cold lock) yields exactly 4 errors: three
    // unverified pairs + one mapping-path-missing structural error.

    it('--top 1 → exit 1, true 4-errors header, exactly one block, and a next: line', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--top', '1'], { cwd, encoding: 'utf-8' });
        expect(result.status).toBe(1);
        const out = stripAnsi(result.stdout);
        // Header preserves the TRUE total even though only one block prints.
        expect(out).toContain('yg check: FAIL  4 errors · 1 warning');
        expect(out).toContain('view: top 1');
        expect(countBlocks(out)).toBe(1);
        expect(out).toContain('… +2 more blocks  (yg check)');
        expect(out).toMatch(/\nnext: /);
      });
    });

    it('--summary → exit 1, counts only (no why:/fix: blocks), true header', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--summary'], { cwd, encoding: 'utf-8' });
        expect(result.status).toBe(1);
        const out = stripAnsi(result.stdout);
        expect(out).toContain('yg check: FAIL  4 errors · 1 warning');
        // One count line per severity, with the unverified script/reviewer split; no per-issue detail.
        expect(out).toMatch(/^errors {4}mapping-path-missing 1 · unverified 3 \(3 reviewer\)$/m);
        expect(out).toMatch(/^warnings {2}rules-digest-stale 1$/m);
        expect(countBlocks(out)).toBe(0);
        expect(out).not.toContain('why:');
        expect(out).not.toContain('fix:');
        // Per-node rows live under `--summary nodes`: the non-pair
        // mapping-path-missing error sits on its own node's row.
        const byNode = spawnSync('node', [BIN_PATH, 'check', '--summary', 'nodes'], { cwd, encoding: 'utf-8' });
        expect(byNode.status).toBe(1);
        const nodesOut = stripAnsi(byNode.stdout);
        expect(nodesOut).toMatch(/^users\/missing-service\s+mapping-path-missing 1$/m);
        expect(nodesOut).toMatch(/^orders\/order-service\s+unverified 2$/m);
        expect(countBlocks(nodesOut)).toBe(0);
      });
    });

    it('bare --top → exactly ONE block (the first by tier, the one next: draws from), exit 1', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--top'], { cwd, encoding: 'utf-8' });
        expect(result.status).toBe(1);
        const out = stripAnsi(result.stdout);
        // TRUE aggregate header always shown.
        expect(out).toContain('yg check: FAIL  4 errors · 1 warning');
        // Bare --top = --top 1: the single first block renders.
        expect(countBlocks(out)).toBe(1);
        // The rendered block is the one the next: line draws from — blocks
        // order by tier, so the code/graph fix (mapping-path-missing, T1)
        // outranks the pending fill (unverified, T3), which follows as then:.
        expect(out).toContain('error[mapping-path-missing]');
        expect(out).not.toContain('error[unverified]');
        // A bare `yg-node.yaml` in the fix is the finding's own node's file, which
        // the CLI knows: the step names it by its place in the repository.
        expect(out).toMatch(/next: edit \.yggdrasil\/model\/[^ ]+\/yg-node\.yaml {2}\(mapping-path-missing\)/);
        expect(out).toContain('then: yg check --approve  (3 reviewer pairs · paid)');
      });
    });

    it('--top 99 → all 2 blocks shown (4 total errors), no crash, exit 1', async () => {
      await withFixtureCopy(async (cwd) => {
        await writeAlignedDigestFiles(cwd);
        const result = spawnSync('node', [BIN_PATH, 'check', '--top', '99'], { cwd, encoding: 'utf-8' });
        expect(result.status).toBe(1);
        const out = stripAnsi(result.stdout);
        // True aggregate: 4 errors (3 unverified + 1 mapping-path-missing).
        expect(out).toContain('yg check: FAIL  4 errors   ');
        // --top N renders N highest-priority BLOCKS, not N individual issues.
        // The fixture collapses into 2 blocks: mapping-path-missing and unverified.
        expect(countBlocks(out)).toBe(2);
      });
    });

    for (const bad of ['-2', 'abc', '0', '1.5']) {
      it(`--top ${bad} → guided error, exit 1 (no silent full dump)`, async () => {
        await withFixtureCopy(async (cwd) => {
          const result = spawnSync('node', [BIN_PATH, 'check', '--top', bad], { cwd, encoding: 'utf-8' });
          expect(result.status).toBe(1);
          const out = stripAnsi(result.stdout);
          expect(stripAnsi(result.stderr)).toContain('--top expects a positive whole number (1 or more)');
          // The error went to stderr; stdout must NOT have dumped the full check wall.
          expect(countBlocks(out)).toBe(0);
        });
      });
    }

    it('--top 1 --summary → mutual-exclusion guided error, exit 1', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--top', '1', '--summary'], { cwd, encoding: 'utf-8' });
        expect(result.status).toBe(1);
        expect(stripAnsi(result.stderr)).toContain('--top and --summary cannot be combined');
      });
    });

    it('--summary --approve → guided error (read-only triage cannot combine with the writer), exit 1', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--summary', '--approve'], { cwd, encoding: 'utf-8' });
        expect(result.status).toBe(1);
        expect(stripAnsi(result.stderr)).toContain('cannot be combined with --approve');
      });
    });

    it('--no-approve --only-deterministic → guided error (contradictory flags), exit 1', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--no-approve', '--only-deterministic'], { cwd, encoding: 'utf-8' });
        expect(result.status).toBe(1);
        expect(stripAnsi(result.stderr)).toContain('cannot be combined');
      });
    });

    it('--top 1 on a green fixture → PASS, exit 0, no blocks', async () => {
      // Hand-author a trivially-green graph: one organizational node, no
      // aspects, no mapping → zero pairs, zero coverage gaps.
      const root = await mkdtemp(path.join(tmpdir(), 'ygg-check-green-'));
      try {
        const ygg = path.join(root, '.yggdrasil');
        await mkdir(path.join(ygg, 'model', 'core'), { recursive: true });
        await mkdir(path.join(ygg, 'aspects'), { recursive: true });
        await mkdir(path.join(ygg, 'flows'), { recursive: true });
        await writeFile(path.join(ygg, 'yg-config.yaml'),
          'version: "6.0.0"\n' +
          'quality:\n  max_direct_relations: 10\n' +
          'reviewer:\n  default: standard\n  tiers:\n    standard:\n' +
          '      provider: ollama\n      consensus: 1\n' +
          '      config:\n        model: "m"\n        endpoint: "http://127.0.0.1:1"\n', 'utf-8');
        await writeFile(path.join(ygg, 'yg-architecture.yaml'),
          'node_types:\n  module:\n    description: \'Organizational grouping.\'\n', 'utf-8');
        await writeFile(path.join(ygg, 'model', 'core', 'yg-node.yaml'),
          'name: core\ntype: module\ndescription: An organizational node with no mapping.\n', 'utf-8');
        // Keep the committed-digest staleness gate silent too, so this stays a
        // TRUE zero-issue fixture: aligned artifacts, and excluded from the
        // (otherwise whole-repo-required) coverage scan since nothing maps them.
        await writeAlignedDigestFiles(root);

        const result = spawnSync('node', [BIN_PATH, 'check', '--top', '1'], { cwd: root, encoding: 'utf-8' });
        expect(result.status).toBe(0);
        const out = stripAnsi(result.stdout);
        expect(out).toContain('yg check: PASS');
        expect(countBlocks(out)).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('auto_approve config — banner and PASS · auto-filled marker (task 3.4)', () => {
    // A CI runner exports CI=true, which the spawned CLI inherits and which keeps
    // a config-driven `full` read-only. These cases test the local path.
    const savedCi = process.env.CI;
    beforeAll(() => {
      delete process.env.CI;
    });
    afterAll(() => {
      if (savedCi === undefined) delete process.env.CI;
      else process.env.CI = savedCi;
    });

    /**
     * Write a minimal green graph (no aspects, no mapping) with auto_approve set,
     * so bare `yg check` auto-fills and produces a green (PASS) result with the
     * correct header marker and stderr banner.
     */
    async function withAutoApproveFixture<T>(
      autoApprove: string,
      fn: (cwd: string) => Promise<T>,
    ): Promise<T> {
      const root = await mkdtemp(path.join(tmpdir(), 'ygg-auto-approve-'));
      try {
        const ygg = path.join(root, '.yggdrasil');
        await mkdir(path.join(ygg, 'model', 'core'), { recursive: true });
        await mkdir(path.join(ygg, 'aspects'), { recursive: true });
        await mkdir(path.join(ygg, 'flows'), { recursive: true });
        await writeFile(
          path.join(ygg, 'yg-config.yaml'),
          `version: "6.0.0"\n` +
          `auto_approve: "${autoApprove}"\n` +
          `quality:\n  max_direct_relations: 10\n` +
          `reviewer:\n  default: standard\n  tiers:\n    standard:\n` +
          `      provider: ollama\n      consensus: 1\n` +
          `      config:\n        model: "m"\n        endpoint: "http://127.0.0.1:1"\n`,
          'utf-8',
        );
        await writeFile(
          path.join(ygg, 'yg-architecture.yaml'),
          'node_types:\n  module:\n    description: \'Organizational grouping.\'\n',
          'utf-8',
        );
        await writeFile(
          path.join(ygg, 'model', 'core', 'yg-node.yaml'),
          'name: core\ntype: module\ndescription: An organizational node with no mapping.\n',
          'utf-8',
        );
        return await fn(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    it('auto_approve:full bare `yg check` prints banner to stderr and a PASS · auto-filled header', async () => {
      await withAutoApproveFixture('full', async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
          timeout: 10000,
        });
        // Banner on stderr only.
        expect(result.stderr).toContain("auto-approve: full — bare 'yg check' will call the reviewer.");
        // Header on stdout marks the auto-fill. The fixture repo carries no
        // agent-rules install, so the committed-digest gate contributes exactly
        // one warning — and it must surface on the FILL path just as it does on
        // the plain read. (Regression: the fill stage once dropped the gate's
        // injected snapshot, so the same repo printed one fewer warning under a
        // fill than under `yg check`.)
        expect(stripAnsi(result.stdout)).toMatch(/^yg check: PASS {2}1 warning · auto-filled\b/m);
        expect(stripAnsi(result.stdout)).toContain('warning[rules-digest-stale]');
        // Banner must NOT appear in stdout.
        expect(result.stdout).not.toContain("auto-approve: full");
      });
    });

    it('auto_approve:deterministic bare `yg check` does NOT print banner (free/keyless fill)', async () => {
      await withAutoApproveFixture('deterministic', async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
          timeout: 10000,
        });
        // No banner — deterministic fill is free, no reviewer cost.
        expect(result.stderr).not.toContain("auto-approve: full");
        // Header still marks the auto-fill, and the committed-digest gate's
        // warning reaches the deterministic fill path too (see above).
        expect(stripAnsi(result.stdout)).toMatch(/^yg check: PASS {2}1 warning · auto-filled\b/m);
        expect(stripAnsi(result.stdout)).toContain('warning[rules-digest-stale]');
      });
    });

    it('explicit --approve does NOT print banner even when auto_approve:full is configured', async () => {
      await withAutoApproveFixture('full', async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--approve'], {
          cwd,
          encoding: 'utf-8',
          timeout: 10000,
        });
        // No banner — user explicitly asked for --approve, cost is expected.
        expect(result.stderr).not.toContain("auto-approve: full");
        // No auto-filled marker — explicit user action, not config-driven.
        expect(stripAnsi(result.stdout)).not.toContain('auto-filled');
      });
    });
  });
});
