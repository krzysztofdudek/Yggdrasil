// =============================================================================
// CLI E2E — the check gate tells the truth about what blocks it and what to do.
//
// Every scenario here is one an adopter met where the report, the `--json`
// document or the `Next:` line pointed at a command that could not help — or
// where the command itself stopped for a reason that did not apply to it:
//
//   1. keyless project + one judgment rule: the free gate still fills the
//      script rules, a preview still previews, and `Next:` names the missing
//      reviewer instead of an `--approve` that aborts
//   2. an advisory judgment rule with no reviewer never blocks
//   3. an infrastructure failure (reviewer unreachable, check.mjs that cannot
//      run) is named on the report and in `--json`, and `Next:` points at it
//   4. an async check.mjs that throws still reaches the report
//   5. a reason-less yg-suppress marker is warned about before it matters
//   6. a log conflict met mid-merge resolves with the command the check names
//   7. the log gate stops before announcing a fill, and its retry keeps flags
//   8. the closing summary never claims "all valid" after filling something
//   9. contradictory / invalid flags are refused with an accurate message
//  10. log_required quietly not measuring is surfaced
//  11. a broken graph file does not produce misattributed follow-on findings
//  12. an unusable family-candidates file is named, not silently dropped
//  13. unverified pairs are grouped by cause (stale / never / local cache)
//  14. non-pair findings are counted as issues, not pairs
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFixtureTree } from '../support/fixture-copy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

interface Run { stdout: string; stderr: string; status: number | null; all: string }

function run(args: string[], cwd: string): Run {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, status: r.status, all: stdout + stderr };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf-8' });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

interface JsonIssue { code: string; severity: string; cause?: string; next: string; what: string; why: string }
interface JsonDoc { issues: JsonIssue[]; suggestedNext: string | null; exit: { code: number } }

function json(r: Run): JsonDoc {
  return JSON.parse(r.stdout) as JsonDoc;
}

/** The lifecycle fixture in a fresh git repository; `keyless` strips the reviewer: section. */
function project(label: string, opts: { keyless?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-gate-clarity-${label}-`));
  copyFixtureTree(FIXTURE, dir);
  if (opts.keyless === true) {
    const cfg = path.join(dir, '.yggdrasil', 'yg-config.yaml');
    writeFileSync(cfg, readFileSync(cfg, 'utf-8').replace(/reviewer:\n(?: {2,}.*\n)*/, ''), 'utf-8');
  }
  git(['init', '-q', '.'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'init'], dir);
  return dir;
}

function edit(dir: string, rel: string, fn: (s: string) => string): void {
  const p = path.join(dir, rel);
  writeFileSync(p, fn(readFileSync(p, 'utf-8')), 'utf-8');
}

/** Drop the judgment rule so a scenario runs on script rules alone. */
function dropJudgmentRule(dir: string): void {
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });
  edit(dir, '.yggdrasil/yg-architecture.yaml', (s) => s.split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'));
}

function makeServiceLogRequired(dir: string): void {
  edit(dir, '.yggdrasil/yg-architecture.yaml', (s) =>
    s.replace(/(service:\n {4}description: [^\n]*\n {4})log_required: false/, '$1log_required: true'));
}

const DET_LOCK = (dir: string): string => path.join(dir, '.yggdrasil', '.yg-lock.deterministic.json');

describe.skipIf(!distExists)('CLI E2E — check gate clarity', () => {
  describe('1. keyless project with a judgment rule', () => {
    it('--approve --only-deterministic fills the script rules instead of aborting the run', () => {
      const dir = project('keyless-det', { keyless: true });
      try {
        const r = run(['check', '--approve', '--only-deterministic'], dir);
        expect(r.all).not.toContain('aborted');
        expect(r.all).toContain('no reviewer is configured');
        // The deterministic pairs were filled — the local cache exists.
        expect(existsSync(DET_LOCK(dir))).toBe(true);
        // Still red: the enforced judgment rule has no judge.
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('config-reviewer-missing');
        expect(r.stdout).toContain('unverified (no reviewer configured)');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('--approve --dry-run previews and exits 0, naming the missing reviewer', () => {
      const dir = project('keyless-dry', { keyless: true });
      try {
        const r = run(['check', '--approve', '--dry-run'], dir);
        expect(r.status).toBe(0);
        expect(r.all).not.toContain('aborted');
        expect(r.stdout).toContain('No reviewer is configured');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a full --approve still stops, and its retry and fix name non-interactive commands', () => {
      const dir = project('keyless-full', { keyless: true });
      try {
        const r = run(['check', '--approve'], dir);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('aborted');
        expect(r.stderr).toContain('yg init --provider <name>');
        expect(r.stderr).not.toContain("pick 'Configure reviewer'");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('plain check points Next at the reviewer, not at an --approve that would abort', () => {
      const dir = project('keyless-next', { keyless: true });
      try {
        const doc = json(run(['check', '--json'], dir));
        expect(doc.suggestedNext).toMatch(/^yg init --provider <name>/);
        const llm = doc.issues.filter((i) => i.code === 'unverified' && i.cause === 'reviewer-missing');
        expect(llm.length).toBeGreaterThan(0);
        expect(llm[0].next).toMatch(/^yg init --provider <name>/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('2. an advisory judgment rule with no reviewer', () => {
    it('is a warning, not a blocking error', () => {
      const dir = project('keyless-advisory', { keyless: true });
      try {
        edit(dir, '.yggdrasil/aspects/has-doc-comment/yg-aspect.yaml', (s) => s.replace('status: enforced', 'status: advisory'));
        expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);
        const r = run(['check', '--json'], dir);
        expect(r.status).toBe(0);
        const missing = json(r).issues.find((i) => i.code === 'config-reviewer-missing');
        expect(missing?.severity).toBe('warning');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('3. an infrastructure failure is on the report, not only on stderr', () => {
    it('names reviewer-unreachable and check-failed-to-run, and Next points at a fix', () => {
      const dir = project('infra');
      try {
        edit(dir, '.yggdrasil/yg-config.yaml', (s) => s.replace(/endpoint:.*/, 'endpoint: "http://127.0.0.1:9"'));
        edit(dir, '.yggdrasil/aspects/no-todo-comments/check.mjs', (s) => s.replace('export function check', 'export default function check'));
        const r = run(['check', '--approve', '--json'], dir);
        expect(r.status).toBe(1);
        const doc = json(r);
        const causes = new Set(doc.issues.filter((i) => i.code === 'unverified').map((i) => i.cause));
        expect(causes.has('reviewer-unreachable')).toBe(true);
        expect(causes.has('check-failed-to-run')).toBe(true);
        expect(doc.suggestedNext).not.toBe('yg check --approve');
        // The text report carries the same.
        const text = run(['check', '--approve'], dir);
        expect(text.stdout).toContain('unverified (reviewer unreachable this run)');
        expect(text.stdout).toContain('unverified (check.mjs failed to run)');
        expect(text.stdout).not.toMatch(/Next: yg check --approve\s*$/m);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('4. an async check.mjs that throws', () => {
    it('still reaches the report instead of killing the run with a bare Error', () => {
      const dir = project('async');
      try {
        writeFileSync(
          path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs'),
          'export async function check(ctx) { for (const f of ctx.files) { await f.read(); } return []; }\n',
          'utf-8',
        );
        const r = run(['check', '--approve', '--only-deterministic'], dir);
        expect(r.stderr).not.toContain('Error: f.read is not a function');
        expect(r.stdout).toContain('yg check: FAIL');
        expect(r.stdout).toContain('unverified (check.mjs failed to run)');
        expect(r.stdout).toContain('Fix: Refactor check to be synchronous.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('5. a yg-suppress marker with no reason', () => {
    it('is warned about by yg suppressions and yg check before any violation lands', () => {
      const dir = project('reasonless');
      try {
        appendFileSync(path.join(dir, 'src', 'services', 'orders.ts'), '// yg-suppress(no-todo-comments)\nexport const x = 1;\n');
        const sup = JSON.parse(run(['suppressions', '--json'], dir).stdout) as { warnings: Array<{ code: string }> };
        expect(sup.warnings.some((w) => w.code === 'missing-reason')).toBe(true);
        const doc = json(run(['check', '--json'], dir));
        const w = doc.issues.find((i) => i.code === 'suppress-marker-missing-reason');
        expect(w?.severity).toBe('warning');
        expect(w?.what).toContain('src/services/orders.ts');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('once a violation lands in its range, the report names the marker as the cause', () => {
      const dir = project('reasonless-hit');
      try {
        appendFileSync(path.join(dir, 'src', 'services', 'payments.ts'), '// yg-suppress(no-todo-comments)\n// TODO later\n');
        const doc = json(run(['check', '--approve', '--only-deterministic', '--json'], dir));
        expect(doc.issues.some((i) => i.code === 'unverified' && i.cause === 'suppress-marker-invalid')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('6. a log conflict met mid-merge', () => {
    it('resolves with the command the check names, writing the union of both sides', () => {
      const dir = project('merge');
      try {
        dropJudgmentRule(dir);
        makeServiceLogRequired(dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'initial'], dir);
        run(['check', '--approve'], dir);
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'base'], dir);
        const main = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
        git(['checkout', '-qb', 'feat-a'], dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'branch a'], dir);
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'a'], dir);
        git(['checkout', '-q', main], dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'main'], dir);
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'b'], dir);
        git(['merge', 'feat-a'], dir);
        const logPath = path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'log.md');
        expect(readFileSync(logPath, 'utf-8')).toMatch(/^<{7}/m);

        const doc = json(run(['check', '--json'], dir));
        expect(doc.suggestedNext).toBe('yg log merge-resolve --node services/payments');

        const r = run(['log', 'merge-resolve', '--node', 'services/payments'], dir);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('wrote the union of both sides');
        const merged = readFileSync(logPath, 'utf-8');
        expect(merged).not.toMatch(/^[<>]{7}/m);
        expect(merged).toContain('branch a');
        expect(merged).toContain('main');
        expect(merged.indexOf('branch a')).toBeLessThan(merged.indexOf('\nmain'));
        expect(run(['check', '--json'], dir).stdout).not.toContain('log-conflict');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('6b. a log conflict met mid-merge on a branch whose tip is itself a merge', () => {
    it('resolves against the merge in progress, not the merge commit at HEAD', () => {
      const dir = project('merge-on-merge');
      try {
        dropJudgmentRule(dir);
        makeServiceLogRequired(dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'initial'], dir);
        run(['check', '--approve'], dir);
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'base'], dir);
        const main = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
        git(['checkout', '-qb', 'feat-a'], dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'branch a'], dir);
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'a'], dir);
        git(['checkout', '-q', main], dir);
        git(['checkout', '-qb', 'feat-c'], dir);
        writeFileSync(path.join(dir, 'NOTES.txt'), 'side\n');
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'c'], dir);
        git(['checkout', '-q', main], dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'main'], dir);
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'b'], dir);
        git(['merge', '--no-ff', '-q', '-m', 'merge c', 'feat-c'], dir);
        git(['merge', 'feat-a'], dir);
        const logPath = path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'log.md');
        expect(readFileSync(logPath, 'utf-8')).toMatch(/^<{7}/m);

        const r = run(['log', 'merge-resolve', '--node', 'services/payments'], dir);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('wrote the union of both sides');
        const merged = readFileSync(logPath, 'utf-8');
        expect(merged).not.toMatch(/^[<>]{7}/m);
        expect(merged).toContain('branch a');
        expect(merged).toContain('main');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('7. the log gate', () => {
    it('stops before the fill header, and its retry repeats --only-deterministic', () => {
      const dir = project('loggate');
      try {
        makeServiceLogRequired(dir);
        const r = run(['check', '--approve', '--only-deterministic'], dir);
        expect(r.status).toBe(1);
        expect(r.stderr).not.toContain('Filling ');
        expect(r.stderr).toContain('then re-run: yg check --approve --only-deterministic');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('8. the closing summary', () => {
    it('does not claim every pair is valid after a deterministic refusal', () => {
      const dir = project('summary');
      try {
        appendFileSync(path.join(dir, 'src', 'services', 'orders.ts'), '// TODO refuse\n');
        const r = run(['check', '--approve', '--only-deterministic'], dir);
        expect(r.stderr).not.toContain('all expected pairs hold valid verdicts');
        expect(r.stderr).toMatch(/0 reviewer calls made — .*\d+ deterministic pairs? filled \(\d+ approved, [1-9]\d* refused\)/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('9. the flag contract', () => {
    it('refuses --approve together with --no-approve, in either order', () => {
      const dir = project('flags');
      try {
        for (const args of [['--approve', '--no-approve'], ['--no-approve', '--approve']]) {
          const r = run(['check', ...args], dir);
          expect(r.status).toBe(1);
          expect(r.stderr).toContain('--approve cannot be combined with --no-approve.');
          expect(existsSync(DET_LOCK(dir))).toBe(false);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('says --top wants a positive number, and names the no-write read under auto_approve', () => {
      const dir = project('flags2');
      try {
        expect(run(['check', '--top', '0'], dir).stderr).toContain('--top expects a positive whole number (1 or more); got "0".');
        appendFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'auto_approve: deterministic\n');
        const r = run(['check', '--no-approve', '--dry-run'], dir);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('yg check --no-approve (plain read)');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('help says --only-deterministic implies --approve', () => {
      const r = run(['check', '--help'], CLI_ROOT);
      expect(r.stdout.replace(/\s+/g, ' ')).toContain('implies --approve');
    });
  });

  describe('10. log_required that is not measuring changes', () => {
    it('warns when only --only-deterministic runs record, and not after a full --approve', () => {
      const dir = project('cycle');
      try {
        dropJudgmentRule(dir);
        makeServiceLogRequired(dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'a'], dir);
        run(['log', 'add', '--node', 'services/orders', '--reason', 'a'], dir);
        run(['check', '--approve', '--only-deterministic'], dir);
        appendFileSync(path.join(dir, 'src', 'services', 'payments.ts'), '// later edit\n');
        const r = run(['check', '--approve', '--only-deterministic', '--json'], dir);
        const open = json(r).issues.filter((i) => i.code === 'log-cycle-open');
        expect(open.length).toBeGreaterThan(0);
        expect(open[0].severity).toBe('warning');
        run(['check', '--approve'], dir);
        expect(run(['check', '--json'], dir).stdout).not.toContain('log-cycle-open');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('11. a broken graph file', () => {
    it('does not call an in-use aspect orphaned while a node file failed to load', () => {
      const dir = project('broken-node');
      try {
        edit(dir, '.yggdrasil/model/services/orders/yg-node.yaml', (s) => s.replace('mapping:', 'mapping: 5\nx:'));
        const doc = json(run(['check', '--json'], dir));
        expect(doc.issues.some((i) => i.code === 'yaml-invalid')).toBe(true);
        expect(doc.issues.some((i) => i.code === 'orphaned-aspect')).toBe(false);
        const yamlInvalid = doc.issues.find((i) => i.code === 'yaml-invalid');
        expect(yamlInvalid?.next).toContain('yg schemas read node');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not call a schema error YAML syntax, nor print the no-when banner for an unread architecture', () => {
      const dir = project('broken-arch');
      try {
        edit(dir, '.yggdrasil/yg-architecture.yaml', (s) => s.replace('log_required: false', 'log_requried: false'));
        appendFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'coverage:\n  type_level: true\n');
        const r = run(['check'], dir);
        expect(r.stdout).toContain('architecture-invalid');
        expect(r.stdout).not.toContain('Fix the YAML syntax');
        expect(r.stdout).toContain('yg schemas read architecture');
        expect(r.stdout).not.toContain("no type in yg-architecture.yaml declares 'when:'");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('12. yg advise', () => {
    it('names a family-candidates file it could not use, and cites no absent incidents.md', () => {
      const dir = project('advise');
      try {
        writeFileSync(path.join(dir, '.yggdrasil', '.family-candidates.grain.json'), '{"v":2,"ts":"2026-09-01T00:00:00Z","families":[]}', 'utf-8');
        writeFileSync(path.join(dir, '.yggdrasil', '.family-candidates.other.json'), '{"v":1,', 'utf-8');
        const r = run(['advise'], dir);
        expect(r.stdout).toContain('.family-candidates.grain.json were not read — its format version is 2');
        expect(r.stdout).toContain('.family-candidates.other.json were not read — it is not valid JSON');
        expect(r.stdout).not.toContain('see .yggdrasil/incidents.md');
        expect(r.stdout).toContain('yg incident add');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('13. unverified pairs, grouped by cause', () => {
    it('separates a local deterministic result not yet run from a stale verdict', () => {
      const dir = project('causes');
      try {
        dropJudgmentRule(dir);
        // Fresh checkout: no local deterministic results at all.
        const fresh = json(run(['check', '--json'], dir));
        const freshCauses = fresh.issues.filter((i) => i.code === 'unverified').map((i) => i.cause);
        expect(freshCauses.every((c) => c === 'deterministic-not-run')).toBe(true);
        expect(fresh.suggestedNext).toBe('yg check --approve --only-deterministic');
        expect(run(['check'], dir).stdout).toContain('unverified (deterministic check not run on this checkout — free)');
        // Filled, then the code moves: the verdict is stale, not "not yet reviewed".
        run(['check', '--approve', '--only-deterministic'], dir);
        appendFileSync(path.join(dir, 'src', 'services', 'orders.ts'), '// moved\n');
        const text = run(['check'], dir).stdout;
        expect(text).toContain('unverified (stale — inputs changed since the verdict)');
        expect(json(run(['check', '--json'], dir)).issues.some((i) => i.cause === 'stale')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('14. non-pair findings', () => {
    it('are counted as issues, not pairs', () => {
      const dir = project('nouns');
      try {
        edit(dir, '.yggdrasil/model/services/orders/yg-node.yaml', (s) => s.replace('mapping:', 'mapping: 5\nx:'));
        const text = run(['check'], dir).stdout;
        expect(text).toMatch(/yaml-invalid {2}1 issue {2}/);
        expect(text).not.toMatch(/yaml-invalid {2}1 pairs/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
