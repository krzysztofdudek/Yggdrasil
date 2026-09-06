// =============================================================================
// CLI E2E — `yg check --json` and `yg aspects --json`.
//
// A layer above the agent — a wave close computing a quality index, a dashboard,
// a build step deciding what to schedule — had to parse the text report to learn
// how a build stands. That report is written to be READ, so every wording
// improvement in it was a breaking change for anyone scraping it. These
// scenarios pin the documents that replace the scraping, and pin them AGAINST
// the text report: same counts, same exit code, same run.
//
//   1. --json on a fixture   → one yg-check/1 document, counts equal the header
//   2. exit codes            → identical to the text run, red and green
//   3. per-pair facts        → aspect, unit, status, verdict, reviewer, hash
//   4. stale vs unverified   → judged-then-moved is not never-judged
//   5. composes with --approve --only-deterministic
//   6. refused with the four text-view selectors
//   7. an externally judged pair names its judge as the reviewer
//   8. yg aspects --json     → status, kind, review date, drill counts, reach
//   9. this repository's own graph → parses, and matches its own text report
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
// The repository this CLI is developed in — its own graph is the largest real
// one available, and the ticket's own acceptance is stated against it.
const REPO_ROOT = path.resolve(CLI_ROOT, '..', '..');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-checkjson-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

interface CheckDoc {
  schema: string;
  project: { name: string; nodes: number; aspects: number; flows: number };
  exit: { code: number; status: string; reason: string };
  coverage: { files: number; covered: number; nodeOwned: number | null; typeCovered: number | null; excluded: number | null; requiresNothing: boolean };
  totals: {
    errors: number;
    warnings: number;
    draftSkipped: number;
    verdicts: Record<string, number>;
    verified: { deterministic: number; llm: number };
  };
  pairs: Array<{
    aspect: string;
    unit: { kind: string; path: string };
    node: string | null;
    kind: string;
    status: string;
    verdict: string;
    reviewer: string | null;
    hash: string | null;
    report?: string;
  }>;
  issues: Array<{ code: string; severity: string; aspect?: string; node?: string; unit?: string; what: string; why: string; next: string }>;
  judges: Array<{ name: string; pairs: number }>;
  progressive: unknown;
  suggestedNext: string | null;
}

interface AspectsDoc {
  schema: string;
  aspects: Array<{
    id: string;
    name: string;
    description: string;
    kind: string;
    tier: string | null;
    status: string;
    reviewBy: string | null;
    errs: string | null;
    implies: string[];
    usage: { nodes: number; architecture: number; own: number; implied: number; flow: number; typeCovered: number };
    drills: { violates: number; satisfies: number; total: number };
  }>;
}

/** The header's own numbers, read back out of the text report. */
function headerCounts(text: string): { errors: number; warnings: number; verified: number; det: number; llm: number; nodes: number } {
  const nodes = /(\d+) nodes/.exec(text);
  const verified = /(\d+) verified \((\d+) deterministic, (\d+) LLM\)/.exec(text);
  const errors = /^Errors \((\d+)\)/m.exec(text);
  const warnings = /^Warnings \((\d+)\)/m.exec(text);
  return {
    errors: errors ? Number(errors[1]) : 0,
    warnings: warnings ? Number(warnings[1]) : 0,
    verified: verified ? Number(verified[1]) : 0,
    det: verified ? Number(verified[2]) : 0,
    llm: verified ? Number(verified[3]) : 0,
    nodes: nodes ? Number(nodes[1]) : 0,
  };
}

describe.skipIf(!distExists)('CLI E2E — yg check --json', () => {
  it('1+2+3: one yg-check/1 document whose counts, exit code and per-pair facts match the text run', () => {
    const dir = copyFixture('parity');
    try {
      const text = run(['check'], dir);
      const json = run(['check', '--json'], dir);
      expect(json.status).toBe(text.status);
      // stdout carries the document ALONE — a stray prose line would throw here.
      const doc = JSON.parse(json.stdout) as CheckDoc;
      expect(doc.schema).toBe('yg-check/1');

      const header = headerCounts(text.stdout);
      expect(doc.project.nodes).toBe(header.nodes);
      expect(doc.totals.errors).toBe(header.errors);
      expect(doc.totals.warnings).toBe(header.warnings);
      expect(doc.totals.verified).toEqual({ deterministic: header.det, llm: header.llm });
      expect(doc.exit.code).toBe(text.status);
      expect(doc.exit.status).toBe(text.status === 0 ? 'pass' : 'fail');
      expect(doc.exit.reason).toContain(String(header.errors));

      // The verdict tally accounts for every expected pair, with no word left out.
      const tallied = Object.values(doc.totals.verdicts).reduce((a, b) => a + b, 0);
      expect(tallied).toBe(doc.pairs.length);
      expect(Object.keys(doc.totals.verdicts).sort()).toEqual([
        'approved', 'companion-error', 'prompt-too-large', 'refused', 'stale', 'unverified',
      ]);

      // Per pair: which rule, which subject, what status decides blocking, what
      // the lock says, who answers, and what it is bound to.
      const pair = doc.pairs.find((p) => p.aspect === 'has-doc-comment' && p.node === 'services/orders');
      expect(pair).toBeDefined();
      expect(pair!.unit).toEqual({ kind: 'node', path: 'services/orders' });
      expect(pair!.kind).toBe('llm');
      expect(pair!.status).toBe('enforced');
      expect(pair!.verdict).toBe('unverified');
      expect(pair!.hash).toBeNull();
      // Nothing has answered yet, but the tier that WOULD is already named.
      expect(pair!.reviewer).toBe('standard');

      const det = doc.pairs.find((p) => p.kind === 'deterministic');
      expect(det?.reviewer).toBe('deterministic');

      // Findings arrive as structured messages, never as a rendered block.
      expect(doc.issues.length).toBeGreaterThan(0);
      for (const issue of doc.issues) {
        expect(issue.what.length).toBeGreaterThan(0);
        expect(issue.why.length).toBeGreaterThan(0);
        expect(issue.next.length).toBeGreaterThan(0);
      }
      expect(doc.issues.filter((i) => i.severity === 'error')).toHaveLength(doc.totals.errors);

      // Nothing measured against a branch here, so there is no floor to claim.
      expect(doc.progressive).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4+5: it composes with the free fill, and tells a judged-then-moved pair from a never-judged one', () => {
    const dir = copyFixture('stale');
    try {
      const filled = run(['check', '--approve', '--only-deterministic', '--json'], dir);
      const doc = JSON.parse(filled.stdout) as CheckDoc;
      expect(doc.schema).toBe('yg-check/1');
      // The fill happened: deterministic pairs now hold verdicts bound to a hash.
      const settled = doc.pairs.filter((p) => p.kind === 'deterministic' && p.verdict === 'approved');
      expect(settled.length).toBeGreaterThan(0);
      for (const p of settled) expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(doc.totals.verdicts.stale).toBe(0);

      // Move the code a recorded verdict judged. The gate treats stale and
      // never-seen alike; the document does not.
      appendFileSync(path.join(dir, 'src', 'services', 'orders.ts'), '\n// a later edit\n');
      const after = JSON.parse(run(['check', '--json'], dir).stdout) as CheckDoc;
      expect(after.totals.verdicts.stale).toBeGreaterThan(0);
      const staleOne = after.pairs.find((p) => p.verdict === 'stale');
      // Judged once: the recorded hash is still there, it just no longer matches.
      expect(staleOne!.hash).toMatch(/^[0-9a-f]{64}$/);
      const neverSeen = after.pairs.find((p) => p.verdict === 'unverified');
      expect(neverSeen!.hash).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: the four text-view selectors are refused with --json, each saying why', () => {
    const dir = copyFixture('views');
    try {
      for (const flag of [['--summary'], ['--top', '2'], ['--details'], ['--aspect', 'has-doc-comment']]) {
        const result = run(['check', '--json', ...flag], dir);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(`${flag[0]} cannot be combined with --json.`);
        expect(result.stderr).toContain('always carries the whole run');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: a verdict recorded outside the configured reviewer names its judge, in the pair and in the run', () => {
    const dir = copyFixture('judge');
    try {
      const pkg = JSON.parse(
        run(['verdict', 'package', '--aspect', 'has-doc-comment', '--node', 'services/orders'], dir).stdout,
      ) as { hashes: { pass: string } };
      run(
        ['verdict', 'record', '--aspect', 'has-doc-comment', '--node', 'services/orders',
         '--by', 'grain-verifier', '--verdict', 'pass', '--hash', pkg.hashes.pass],
        dir,
      );

      const doc = JSON.parse(run(['check', '--json'], dir).stdout) as CheckDoc;
      const judged = doc.pairs.find((p) => p.aspect === 'has-doc-comment' && p.node === 'services/orders');
      expect(judged!.verdict).toBe('approved');
      expect(judged!.reviewer).toBe('grain-verifier');
      expect(judged!.hash).toBe(pkg.hashes.pass);
      expect(doc.judges).toEqual([{ name: 'grain-verifier', pairs: 1 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!distExists)('CLI E2E — yg aspects --json', () => {
  it('8: the rule inventory carries status, kind, review date, reach and drill-corpus size', () => {
    const dir = copyFixture('aspects');
    try {
      const result = run(['aspects', '--json'], dir);
      expect(result.status).toBe(0);
      const doc = JSON.parse(result.stdout) as AspectsDoc;
      expect(doc.schema).toBe('yg-aspects/1');
      expect(doc.aspects.map((a) => a.id)).toEqual([...doc.aspects.map((a) => a.id)].sort());

      const llm = doc.aspects.find((a) => a.id === 'has-doc-comment')!;
      expect(llm.kind).toBe('llm');
      expect(llm.status).toBe('enforced');
      expect(llm.usage.nodes).toBeGreaterThan(0);

      const det = doc.aspects.find((a) => a.id === 'requires-named-export')!;
      expect(det.kind).toBe('deterministic');
      expect(det.tier).toBeNull();

      const draft = doc.aspects.find((a) => a.id === 'wip-rule')!;
      expect(draft.status).toBe('draft');

      // Every rule reports a corpus count, even when the corpus is empty — a
      // rule with no cases is a fact, not a missing field.
      for (const a of doc.aspects) {
        expect(a.drills.total).toBe(a.drills.violates + a.drills.satisfies);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('8b: --health is refused with --json rather than folded into the same schema', () => {
    const dir = copyFixture('health');
    try {
      const result = run(['aspects', '--json', '--health'], dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--health cannot be combined with --json.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!distExists)("CLI E2E — the documents on this repository's own graph", () => {
  it('9: yg check --json parses and matches its own text report, and yg aspects --json lists every rule', () => {
    const text = run(['check'], REPO_ROOT);
    const json = run(['check', '--json'], REPO_ROOT);
    expect(json.status).toBe(text.status);
    const doc = JSON.parse(json.stdout) as CheckDoc;

    const header = headerCounts(text.stdout);
    expect(doc.project.nodes).toBe(header.nodes);
    expect(doc.totals.verified).toEqual({ deterministic: header.det, llm: header.llm });
    expect(doc.totals.errors).toBe(header.errors);
    expect(doc.totals.warnings).toBe(header.warnings);
    expect(doc.totals.verdicts.approved).toBe(header.det + header.llm);
    expect(doc.pairs.length).toBeGreaterThan(1000);
    // Every pair names a rule that exists, and a subject.
    for (const p of doc.pairs.slice(0, 200)) {
      expect(p.aspect.length).toBeGreaterThan(0);
      expect(p.unit.path.length).toBeGreaterThan(0);
      expect(['llm', 'deterministic']).toContain(p.kind);
    }

    const aspects = JSON.parse(run(['aspects', '--json'], REPO_ROOT).stdout) as AspectsDoc;
    expect(aspects.schema).toBe('yg-aspects/1');
    expect(aspects.aspects.length).toBe(doc.project.aspects);
    // This repository's own port contract rule ships a corpus; a real one, not zero.
    const withCorpus = aspects.aspects.filter((a) => a.drills.total > 0);
    expect(withCorpus.length).toBeGreaterThan(0);
  });
});
