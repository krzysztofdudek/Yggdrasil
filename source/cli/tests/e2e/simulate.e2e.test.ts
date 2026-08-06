// =============================================================================
// CLI E2E — `yg simulate` — deterministic replay of a candidate rule over history.
//
// Pins the public CLI surface (spawn the built bin.js). `yg simulate` answers "if I
// had shipped this deterministic rule, what would it have caught across the history
// it can honestly reach?" — replaying a candidate check.mjs over recent commits, in
// an ISOLATED clone, one fresh subprocess per commit, strictly read-only.
//
// The fixture is a real git repo whose history spans exactly the cases that matter:
//   C1  preinit-no-graph        — predates `yg init` (no .yggdrasil)  → non-comparable
//   C2  graph-with-violation    — graph at schema 5.2.0, source trips the rule → violations
//   C3  schema-downgrade        — graph at schema 5.0.0 (would need migration) → non-comparable
//   C4  clean-fix               — graph at 5.2.0, source fixed          → ran-clean
//
// Asserted here: exit 0 (a report tool, findings never gate); each of the three
// first-class per-commit outcomes; the pre-init commit is non-comparable and the
// output states the real repo was never consulted (clone-boundary proven end to
// end); the verbatim Wald label; an LLM candidate structurally refused (exit 1);
// and — the security crux — the real fixture tree is BYTE-FOR-BYTE unchanged after
// the run (all work happens in a throwaway clone).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

const WALD_LABEL =
  'history is censored by the old regime — a tightening replay is a LOWER bound on true catches, a loosening replay an UPPER bound.';

function run(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
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

/** A candidate deterministic rule with no imports (robust in any clone): it refuses
 *  any subject file containing `console.log`. */
const CANDIDATE_CHECK = `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const content = file.content || '';
    const idx = content.indexOf('console.log');
    if (idx !== -1) {
      let line = 1;
      for (let i = 0; i < idx; i++) if (content.charCodeAt(i) === 10) line++;
      violations.push({ file: file.path, line, message: 'console.log is not allowed in shipped source' });
    }
  }
  return violations;
}
`;

const SRC_BAD = `export function greet() {\n  console.log('hi');\n  return 1;\n}\n`;
const SRC_GOOD = `export function greet() {\n  return 1;\n}\n`;

/** Write the committed graph (config at the given schema, arch, node, candidate). */
function writeGraph(dir: string, schema: string): void {
  w(dir, '.yggdrasil/yg-config.yaml', `version: "${schema}"\n`);
  w(
    dir,
    '.yggdrasil/yg-architecture.yaml',
    `node_types:\n  app:\n    description: 'the app'\n    log_required: false\n    when:\n      path: "src/**"\n`,
  );
  w(dir, '.yggdrasil/model/app/yg-node.yaml', `name: App\ndescription: the app\ntype: app\nmapping:\n  - src/app.ts\n`);
  w(dir, '.yggdrasil/aspects/no-console/yg-aspect.yaml', `name: No Console\ndescription: no console.log in shipped source\nreviewer:\n  type: deterministic\nstatus: enforced\n`);
  w(dir, '.yggdrasil/aspects/no-console/check.mjs', CANDIDATE_CHECK);
}

/** Build the four-commit history described in the header. HEAD = C4 (clean). */
function buildHistoryFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-sim-e2e-'));
  gitInit(dir);
  // C1 — predates `yg init`: source only, NO graph.
  w(dir, 'src/app.ts', SRC_BAD);
  commitAll(dir, 'preinit-no-graph');
  // C2 — graph at 5.2.0, source still trips the rule.
  writeGraph(dir, '5.2.0');
  commitAll(dir, 'graph-with-violation');
  // C3 — graph downgraded to 5.0.0 (would need a migration → out of horizon).
  w(dir, '.yggdrasil/yg-config.yaml', `version: "5.0.0"\n`);
  commitAll(dir, 'schema-downgrade');
  // C4 — graph back at 5.2.0, source fixed.
  w(dir, '.yggdrasil/yg-config.yaml', `version: "5.2.0"\n`);
  w(dir, 'src/app.ts', SRC_GOOD);
  commitAll(dir, 'clean-fix');
  return dir;
}

/** A stable digest of every working-tree file (excluding .git) → proves byte-for-byte. */
function snapshotTree(root: string): string {
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childRel);
      else files.push(childRel);
    }
  };
  walk('');
  const h = createHash('sha256');
  for (const f of files.sort()) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(path.join(root, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

/** The report line whose subject contains `needle`. */
function lineFor(stdout: string, needle: string): string {
  const line = stdout.split('\n').find((l) => l.includes(needle));
  expect(line, `expected a report line mentioning '${needle}'`).toBeDefined();
  return line as string;
}

describe.skipIf(!distExists)('CLI E2E — yg simulate', () => {
  it('replays the candidate over history, classifies each commit, exits 0, and leaves the real tree byte-for-byte unchanged', () => {
    const dir = buildHistoryFixture();
    try {
      const before = snapshotTree(dir);

      const { status, stdout } = run(['simulate', 'no-console', '--node', 'app', '--max-commits', '10'], dir);

      // A report tool: findings never gate.
      expect(status).toBe(0);

      // The three first-class per-commit outcomes, each on its own commit.
      expect(lineFor(stdout, 'preinit-no-graph')).toContain('non-comparable');
      expect(lineFor(stdout, 'graph-with-violation')).toContain('violations');
      expect(lineFor(stdout, 'schema-downgrade')).toContain('non-comparable');
      expect(lineFor(stdout, 'clean-fix')).toContain('ran-clean');

      // Clone-boundary proven end to end: the pre-init commit is non-comparable
      // BECAUSE it has no graph of its own — and the output says so, explicitly
      // stating the real repo is never consulted (no silent fallback to the real graph).
      expect(stdout).toContain('the real repo is never consulted');

      // The schema-mismatch commit is out of horizon, not silently migrated.
      expect(stdout).toContain('would need a migration');

      // Summary counts: 1 ran-clean, 1 violations, 2 non-comparable.
      expect(stdout).toContain('ran-clean 1');
      expect(stdout).toContain('violations 1');
      expect(stdout).toContain('non-comparable 2');

      // The mandatory Wald caveat, verbatim.
      expect(stdout).toContain(WALD_LABEL);

      // THE crux: the real fixture tree is untouched — all work happened in a clone.
      expect(snapshotTree(dir)).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('structurally refuses an LLM candidate (exit 1) and points at yg drill', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-sim-e2e-llm-'));
    try {
      // A loadable graph (the command loads the real project's graph first), plus an
      // LLM candidate to be refused.
      w(dir, '.yggdrasil/yg-config.yaml', `version: "5.2.0"\n`);
      w(
        dir,
        '.yggdrasil/yg-architecture.yaml',
        `node_types:\n  app:\n    description: 'the app'\n    log_required: false\n    when:\n      path: "src/**"\n`,
      );
      w(dir, '.yggdrasil/model/app/yg-node.yaml', `name: App\ndescription: the app\ntype: app\nmapping:\n  - src/app.ts\n`);
      w(dir, 'src/app.ts', `export const a = 1;\n`);
      w(dir, '.yggdrasil/aspects/llm-rule/yg-aspect.yaml', `name: LLM Rule\ndescription: a reviewed rule\nreviewer:\n  type: llm\n`);
      w(dir, '.yggdrasil/aspects/llm-rule/content.md', `# LLM Rule\n\nThe code must read well.\n`);

      const { status, stderr } = run(['simulate', 'llm-rule', '--node', 'app'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('cannot replay');
      // WHY: an LLM verdict is point-in-time testimony, not reproducible.
      expect(stderr.toLowerCase()).toContain('reproducible');
      // NEXT: the falsifiability tool for LLM rules.
      expect(stderr).toContain('yg drill');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies each commit correctly even when the parent env forces color (color-env pin)', () => {
    // With FORCE_COLOR set in the parent, a naive inner run would emit an ANSI-coloured
    // verdict stamp the classifier could not match, degrading EVERY commit to
    // non-comparable. The inner aspect-test run pins colour OFF, so classification holds.
    const dir = buildHistoryFixture();
    try {
      const { status, stdout } = run(['simulate', 'no-console', '--node', 'app', '--max-commits', '10'], dir, {
        FORCE_COLOR: '3',
      });
      expect(status).toBe(0);
      // Not degraded: the violation and clean commits are still classified as such.
      expect(lineFor(stdout, 'graph-with-violation')).toContain('violations');
      expect(lineFor(stdout, 'clean-fix')).toContain('ran-clean');
      expect(stdout).toContain('violations 1');
      expect(stdout).toContain('ran-clean 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports cleanly when the candidate is a real deterministic rule and exits 0 (no findings gate)', () => {
    // A second, simpler pass over the same fixture with a candidate that never
    // trips (renamed source has no console.log at HEAD): confirms the exit-0
    // report path independent of any refusal.
    const dir = buildHistoryFixture();
    try {
      const { status, stdout } = run(['simulate', 'no-console', '--node', 'app', '--max-commits', '2'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain(WALD_LABEL);
      // Only the two most recent commits (clean-fix, schema-downgrade) are in view.
      expect(stdout).toContain('clean-fix');
      expect(stdout).toContain('schema-downgrade');
      expect(stdout).not.toContain('preinit-no-graph');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects both --node and --file, and rejects neither', () => {
    const dir = buildHistoryFixture();
    try {
      const both = run(['simulate', 'no-console', '--node', 'app', '--file', 'src/app.ts'], dir);
      expect(both.status).toBe(1);
      expect(both.stderr).toContain('Both --node and --file');

      const neither = run(['simulate', 'no-console'], dir);
      expect(neither.status).toBe(1);
      expect(neither.stderr).toContain('Neither --node nor --file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// --file (E2): a file enforced by its architecture type alone (no owning
// component) — replayed over its HISTORICAL content, classified against the
// CURRENT architecture + coverage settings (overlaid into the clone alongside
// the candidate, on top of the schema-equality guard which already holds).
//
//   F1  no-leaf-yet   — graph at 5.2.0 (matches HEAD's schema), but
//                       src/leaf/a.ts does not exist yet  → non-comparable
//   F2  leaf-violation — src/leaf/a.ts added, trips the rule → violations
//   F3  schema-downgrade — graph at 5.0.0 (would need migration) → non-comparable (unchanged reason)
//   F4  leaf-clean    — graph back at 5.2.0, src/leaf/a.ts fixed → ran-clean
//
// HEAD (F4) is what runSimulation reads as "today's" architecture/coverage —
// it declares the 'leaf' type and coverage.type_level: true, which the
// overlay projects backward onto every comparable commit's clone.
// =============================================================================

/** Write the committed graph for the --file fixture: a 'leaf' type (path-only
 *  when:, no node ever maps it) plus coverage.type_level: true. */
function writeFileTargetGraph(dir: string, schema: string): void {
  w(
    dir,
    '.yggdrasil/yg-config.yaml',
    `version: "${schema}"\ncoverage:\n  required:\n    - src/\n  excluded: []\n  type_level: true\n`,
  );
  w(
    dir,
    '.yggdrasil/yg-architecture.yaml',
    `node_types:\n  leaf:\n    description: 'a type-covered leaf file, no component'\n    when:\n      path: "src/leaf/**"\n`,
  );
  w(dir, '.yggdrasil/aspects/no-console/yg-aspect.yaml', `name: No Console\ndescription: no console.log in shipped source\nreviewer:\n  type: deterministic\nstatus: enforced\n`);
  w(dir, '.yggdrasil/aspects/no-console/check.mjs', CANDIDATE_CHECK);
  // graph-loader.ts requires .yggdrasil/model/ to exist as a directory even
  // with zero declared nodes (this fixture is deliberately nodeless — every
  // subject is a type-covered file); git does not track empty directories.
  w(dir, '.yggdrasil/model/.gitkeep', '');
}

/** Build the four-commit --file history described above. HEAD = F4 (clean). */
function buildFileTargetHistoryFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-sim-e2e-file-'));
  gitInit(dir);
  // F1 — graph exists (schema matches HEAD's) but the type-covered file itself
  // does not exist yet.
  writeFileTargetGraph(dir, '5.2.0');
  w(dir, 'src/other.ts', 'export const other = 1;\n');
  commitAll(dir, 'no-leaf-yet');
  // F2 — the file exists now and trips the rule.
  w(dir, 'src/leaf/a.ts', SRC_BAD);
  commitAll(dir, 'leaf-violation');
  // F3 — schema downgraded (out of horizon).
  w(dir, '.yggdrasil/yg-config.yaml', `version: "5.0.0"\ncoverage:\n  required:\n    - src/\n  excluded: []\n  type_level: true\n`);
  commitAll(dir, 'schema-downgrade');
  // F4 — schema back to 5.2.0, file fixed.
  writeFileTargetGraph(dir, '5.2.0');
  w(dir, 'src/leaf/a.ts', SRC_GOOD);
  commitAll(dir, 'leaf-clean');
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — yg simulate --file (a file with no owning component)', () => {
  it('replays a type-covered file over its historical content under the CURRENT architecture, classifying each commit correctly', () => {
    const dir = buildFileTargetHistoryFixture();
    try {
      const before = snapshotTree(dir);

      const { status, stdout } = run(['simulate', 'no-console', '--file', 'src/leaf/a.ts', '--max-commits', '10'], dir);
      expect(status).toBe(0);

      // F1: the file did not exist yet at this commit -> non-comparable.
      expect(lineFor(stdout, 'no-leaf-yet')).toContain('non-comparable');
      // F2: the file exists and trips the candidate rule.
      expect(lineFor(stdout, 'leaf-violation')).toContain('violations');
      // F3: schema mismatch — the EXISTING non-comparable reason, unchanged.
      expect(lineFor(stdout, 'schema-downgrade')).toContain('non-comparable');
      expect(stdout).toContain('would need a migration');
      // F4: clean.
      expect(lineFor(stdout, 'leaf-clean')).toContain('ran-clean');

      // The header names the FILE, not "node", and states plainly that the
      // rule/attachment come from today while the code is historical.
      expect(stdout).toContain("over file 'src/leaf/a.ts'");
      expect(stdout.toLowerCase()).toMatch(/today/);
      expect(stdout.toLowerCase()).toContain('history');

      expect(stdout).toContain(WALD_LABEL);

      // Security crux, same as --node: the real tree is untouched.
      expect(snapshotTree(dir)).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes --file the same way every --file-accepting command does (resolveFileArg against the graph root)', () => {
    // Regression pin: --file must resolve via resolveFileArg(repoRoot, ...) —
    // the same rule every other --file-accepting command follows — rather
    // than forwarding the raw typed string as-is. A leading './' survives
    // unresolved if simulate.ts skips this step (its own upfront traversal
    // guard rejects '..' and absolute paths outright, but does not touch a
    // harmless './' prefix); resolveFileArg's resolve/relativize round trip
    // collapses it. The report line — rendered directly from the resolved
    // target — proves which one actually happened.
    const dir = buildFileTargetHistoryFixture();
    try {
      const { status, stdout } = run(['simulate', 'no-console', '--file', './src/leaf/a.ts', '--max-commits', '10'], dir);
      expect(status).toBe(0);
      expect(lineFor(stdout, 'leaf-violation')).toContain('violations');
      expect(lineFor(stdout, 'leaf-clean')).toContain('ran-clean');
      expect(stdout).toContain("over file 'src/leaf/a.ts'");
      expect(stdout).not.toContain('./src/leaf/a.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
