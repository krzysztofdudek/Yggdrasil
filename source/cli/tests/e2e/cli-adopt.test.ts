// =============================================================================
// CLI E2E — `yg adopt <proposal-dir>`, the acceptance transaction.
//
// Pins the public CLI surface (spawn the built bin.js) against REAL proposal
// directories on disk, shaped exactly as a generator writes one: a staging
// directory holding a `.yggdrasil/` tree, a `proposal.json` naming the engine
// and the commit it was taken at, and a `provenance.json` beside each rule
// carrying how many sites that rule already refuses. The rules' ids NEST, the
// way a generator that groups its output by the area it mined writes them.
//
//   1. accept into an empty repository  → graph in place, baselined, logged
//   2. the summary reports what arrived → counts, origin, already-broken, mode
//   3. a repository that already has a graph → refused, names what is there
//   4. --replace                        → accepted, previous graph kept aside
//   5. --dry-run                        → the same report, nothing written
//   6. a proposal that does not load    → refused, nothing moved
//   7. a directory that is not a proposal → refused by name
//   8. straight after an acceptance, `yg check` has nothing left unverified
//      and reports exactly the refusal the summary counted
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const PROPOSAL_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'grain-proposal');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, status: r.status, all: stdout + stderr };
}

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/**
 * A repository whose source is exactly what the committed proposal fixture was
 * written against — two files under `src/`, one of which carries the TODO the
 * proposal's one enforced rule refuses.
 */
function makeRepo(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-adopt-${label}-`));
  w(dir, 'src/alpha.ts', 'export const alpha = 1;\n');
  w(dir, 'src/beta.ts', '// TODO: left broken on purpose.\nexport const beta = 2;\n');
  return dir;
}

/** Copy the committed proposal fixture into the repository, as a generator would leave it. */
function stageProposal(repo: string): string {
  const target = path.join(repo, '.yggdrasil-proposal');
  cpDir(PROPOSAL_FIXTURE, target);
  return target;
}

function cpDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) cpDir(src, dst);
    else writeFileSync(dst, readFileSync(src));
  }
}

describe.skipIf(!distExists)('CLI E2E — yg adopt', () => {
  it('1: accepts a proposal into a repository with no graph, and baselines it', () => {
    const repo = makeRepo('accept');
    try {
      stageProposal(repo);
      const { status, stdout } = run(['adopt', '.yggdrasil-proposal'], repo);
      expect(status).toBe(0);
      expect(stdout).toContain('yg adopt: accepted');
      // The graph is really there, and the staging directory is untouched.
      expect(existsSync(path.join(repo, '.yggdrasil', 'yg-architecture.yaml'))).toBe(true);
      expect(existsSync(path.join(repo, '.yggdrasil-proposal', '.yggdrasil'))).toBe(true);
      // The free verdicts were recorded — the cache exists and is not empty.
      const cache = path.join(repo, '.yggdrasil', '.yg-lock.deterministic.json');
      expect(existsSync(cache)).toBe(true);
      expect(readFileSync(cache, 'utf-8').length).toBeGreaterThan(2);
      // The acceptance is recorded in the graph itself.
      const log = readFileSync(path.join(repo, '.yggdrasil', 'model', 'src', 'log.md'), 'utf-8');
      expect(log).toContain('accepted as a whole');
      expect(log).toContain('mined from');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('2: the summary reports the counts, the origin, the pre-existing sites and the blocking mode', () => {
    const repo = makeRepo('summary');
    try {
      stageProposal(repo);
      const { stdout } = run(['adopt', '.yggdrasil-proposal'], repo);
      expect(stdout).toContain('1 component');
      expect(stdout).toContain('2 rules (1 enforced, 1 advisory, 0 draft)');
      expect(stdout).toContain('grain-proposal/1');
      expect(stdout).toContain('mined from this repository by Grain');
      // From the per-rule provenance the fixture ships — and it is the truth:
      // the enforced rule really does refuse src/beta.ts as it stands.
      expect(stdout).toContain('1 site the new rules refuse in the code that is already here');
      // The rule id nests, exactly as a generator that groups its output by area
      // writes it. The per-rule count has to be found at the rule's own directory.
      expect(stdout).toContain('grain/src/no-todo-comments  1');
      expect(stdout).toContain("measured against 'main'");
      expect(stdout).toContain('Baseline');
      expect(stdout).toContain('Next: yg check');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('3: refuses a repository that already has a graph, naming what is there', () => {
    const repo = makeRepo('exists');
    try {
      stageProposal(repo);
      expect(run(['adopt', '.yggdrasil-proposal'], repo).status).toBe(0);
      const second = run(['adopt', '.yggdrasil-proposal'], repo);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('already has a graph');
      expect(second.stderr).toContain('1 component');
      expect(second.stderr).toContain('--replace');
      expect(second.stdout).toBe('');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('4: --replace accepts over an existing graph and keeps the previous one aside', () => {
    const repo = makeRepo('replace');
    try {
      stageProposal(repo);
      expect(run(['adopt', '.yggdrasil-proposal'], repo).status).toBe(0);
      const again = run(['adopt', '.yggdrasil-proposal', '--replace'], repo);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('Previous graph');
      const kept = readdirSync(repo).filter((e) => e.startsWith('.yggdrasil.replaced-'));
      expect(kept).toHaveLength(1);
      expect(existsSync(path.join(repo, kept[0], 'yg-architecture.yaml'))).toBe(true);
      expect(existsSync(path.join(repo, '.yggdrasil', 'yg-architecture.yaml'))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('5: --dry-run reports the same facts and writes nothing at all', () => {
    const repo = makeRepo('dryrun');
    try {
      stageProposal(repo);
      const before = readdirSync(repo).sort();
      const { status, stdout } = run(['adopt', '.yggdrasil-proposal', '--dry-run'], repo);
      expect(status).toBe(0);
      expect(stdout).toContain('yg adopt: would accept');
      expect(stdout).toContain('1 site the new rules refuse');
      expect(stdout).toContain("measured against 'main'");
      expect(stdout).toContain('Nothing was written.');
      expect(existsSync(path.join(repo, '.yggdrasil'))).toBe(false);
      expect(readdirSync(repo).sort()).toEqual(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('6: a proposal that does not hold together is refused and nothing is moved', () => {
    const repo = makeRepo('broken');
    try {
      const staged = stageProposal(repo);
      // Attach a rule that does not exist — a blocking, graph-only problem.
      w(
        staged,
        path.join('.yggdrasil', 'model', 'src', 'yg-node.yaml'),
        readFileSync(path.join(staged, '.yggdrasil', 'model', 'src', 'yg-node.yaml'), 'utf-8').replace(
          'aspects: []',
          'aspects:\n  - no-such-rule',
        ),
      );
      const { status, stderr } = run(['adopt', '.yggdrasil-proposal'], repo);
      expect(status).toBe(1);
      expect(stderr).toContain('does not hold together');
      expect(stderr).toContain('aspect-undefined');
      expect(existsSync(path.join(repo, '.yggdrasil'))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('7: a directory that holds no proposal is refused by name', () => {
    const repo = makeRepo('nothing');
    try {
      const { status, stderr } = run(['adopt', 'src'], repo);
      expect(status).toBe(1);
      expect(stderr).toContain('does not hold a proposed graph');
      expect(existsSync(path.join(repo, '.yggdrasil'))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('8: straight after an acceptance nothing is unverified, and the counted refusal is the one reported', () => {
    const repo = makeRepo('check');
    try {
      stageProposal(repo);
      expect(run(['adopt', '.yggdrasil-proposal'], repo).status).toBe(0);
      const check = run(['check'], repo);
      // Every free verdict was recorded by the acceptance, so nothing is left
      // unverified for the plain read to report.
      expect(check.stdout).not.toContain('unverified (not yet reviewed)');
      expect(check.stdout).toContain('yg check:');
      // The enforced rule's standing refusal is the very thing the acceptance
      // summary counted, so it must be here rather than a surprise.
      expect(check.stdout).toContain('grain/src/no-todo-comments');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
