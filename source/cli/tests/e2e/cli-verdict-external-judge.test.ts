// =============================================================================
// CLI E2E — the external-judge channel (`yg verdict`).
//
// A prose rule is judged by a reviewer the project configures. In a repository
// with no key, that leaves a graph nobody can turn green. This channel lets a
// judge outside the CLI — a person, or another tool already reading the change —
// take the exact package a provider would have received, decide, and record the
// decision under its own name, bound to the same content hashes any verdict is.
// CI then re-proves it by hashing alone.
//
// Every scenario runs against a real fixture whose configured provider is never
// reachable and is never called: nothing here spends a reviewer call.
//
//   1. package  → one yg-review/1 document: rule, subjects, tier limits, hashes
//   2. record   → a pass lands in the lock, and yg check goes green for it
//   3. names it → yg check says who judged, in text; yg verdict read --json too
//   4. re-prove → touch the file and the verdict falls out of force
//   5. refusal  → recorded with its report, and yg check renders it, judge named
//   6. refusals → deterministic rule, unknown pair, stale hash, reportless refusal
//   7. approve  → recording is not approving; --approve semantics are untouched
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const RULE = 'has-doc-comment';
const UNIT = 'services/orders';
const SUBJECT = path.join('src', 'services', 'orders.ts');
const NONDET_LOCK = path.join('.yggdrasil', 'yg-lock.nondeterministic.json');

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-verdict-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

interface ReviewDoc {
  schema: string;
  aspect: { id: string; name: string; description: string; kind: string; status: string };
  unit: { kind: string; path: string };
  node: string | null;
  state: string;
  rule: { path: string; content: string };
  references: Array<{ path: string; content: string }>;
  companions: Array<{ path: string; content: string }>;
  subjects: Array<{ path: string; content: string }>;
  tier: { name: string; consensus: number; maxPromptChars: number; promptChars: number };
  hashes: { pass: string; refused: string };
  prompt: string;
}

/** The package for the standard pair, parsed. */
function packageFor(dir: string): ReviewDoc {
  const { status, stdout } = run(['verdict', 'package', '--aspect', RULE, '--node', UNIT], dir);
  expect(status).toBe(0);
  return JSON.parse(stdout) as ReviewDoc;
}

describe.skipIf(!distExists)('CLI E2E — yg verdict, the external-judge channel', () => {
  it('1: package prints one yg-review/1 document with the rule, the code, the tier limits and both hashes', () => {
    const dir = copyFixture('package');
    try {
      const doc = packageFor(dir);
      expect(doc.schema).toBe('yg-review/1');
      expect(doc.aspect).toMatchObject({ id: RULE, kind: 'llm', status: 'enforced' });
      expect(doc.unit).toEqual({ kind: 'node', path: UNIT });
      expect(doc.node).toBe(UNIT);
      expect(doc.state).toBe('unverified');

      // The rule's own text, and the code it is about.
      expect(doc.rule.path).toBe(`.yggdrasil/aspects/${RULE}/content.md`);
      expect(doc.rule.content).toContain('Every source file must begin with a comment.');
      expect(doc.subjects.map((s) => s.path)).toEqual(['src/services/orders.ts']);
      expect(doc.subjects[0].content).toBe(readFileSync(path.join(dir, SUBJECT), 'utf-8'));

      // The tier's CONSTRAINTS, and nothing else about it — a package is handed
      // to someone outside the repository, so no provider, model or credential
      // may ride along.
      expect(doc.tier.name).toBe('standard');
      expect(doc.tier.consensus).toBeGreaterThan(0);
      expect(doc.tier.promptChars).toBeLessThanOrEqual(doc.tier.maxPromptChars);
      expect(JSON.stringify(doc.tier)).not.toContain('ollama');
      expect(JSON.stringify(doc.tier)).not.toContain('endpoint');

      // One hash per verdict token — the judge hands back the one it decided on.
      expect(doc.hashes.pass).toMatch(/^[0-9a-f]{64}$/);
      expect(doc.hashes.refused).toMatch(/^[0-9a-f]{64}$/);
      expect(doc.hashes.pass).not.toBe(doc.hashes.refused);

      // The prompt is the package a configured provider would have received.
      expect(doc.prompt).toContain(`<aspect id="${RULE}"`);
      expect(doc.prompt).toContain('src/services/orders.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2+3+4: a recorded pass turns the pair green, names its judge, and falls out of force when the code moves', () => {
    const dir = copyFixture('pass');
    try {
      const before = run(['check'], dir);
      expect(before.all).toContain(`- ${UNIT}  aspect '${RULE}'`);

      const doc = packageFor(dir);
      const recorded = run(
        ['verdict', 'record', '--aspect', RULE, '--node', UNIT, '--by', 'grain-verifier', '--verdict', 'pass', '--hash', doc.hashes.pass],
        dir,
      );
      expect(recorded.status).toBe(0);
      expect(recorded.stdout).toContain("judged by 'grain-verifier'");

      // (2) The pair is now verified — with no provider ever called.
      const after = run(['check'], dir);
      expect(after.all).not.toContain(`- ${UNIT}  aspect '${RULE}'`);
      // (3) ...and the run says whose judgement it rests on.
      expect(after.all).toContain('recorded by a judge outside the configured reviewer: grain-verifier (1)');

      // The verdict sits in the COMMITTED lock, shaped like any other, with its
      // provenance beside it.
      const lock = JSON.parse(readFileSync(path.join(dir, NONDET_LOCK), 'utf-8')) as {
        verdicts: Record<string, Record<string, { verdict: string; hash: string; judge?: { name: string; provider: string } }>>;
      };
      const entry = lock.verdicts[RULE][`node:${UNIT}`];
      expect(entry.verdict).toBe('approved');
      expect(entry.hash).toBe(doc.hashes.pass);
      expect(entry.judge).toEqual({ name: 'grain-verifier', provider: 'external' });

      // (3) The machine-readable inventory answers the same question.
      const inventory = JSON.parse(run(['verdict', 'read', '--json'], dir).stdout) as {
        schema: string;
        verdicts: Array<{ aspect: string; unit: { kind: string; path: string }; verdict: string; judge: string; inForce: boolean }>;
      };
      expect(inventory.schema).toBe('yg-verdicts/1');
      expect(inventory.verdicts).toEqual([
        { aspect: RULE, unit: { kind: 'node', path: UNIT }, verdict: 'pass', judge: 'grain-verifier', hash: doc.hashes.pass, inForce: true },
      ]);

      // (4) CI re-proves it by hash: move the code and the judgement stops applying.
      appendFileSync(path.join(dir, SUBJECT), '\n// a later edit\n');
      const moved = run(['check'], dir);
      expect(moved.all).toContain(`- ${UNIT}  aspect '${RULE}'`);
      expect(moved.all).not.toContain('grain-verifier');
      const staleInventory = JSON.parse(run(['verdict', 'read', '--json'], dir).stdout) as {
        verdicts: Array<{ inForce: boolean }>;
      };
      expect(staleInventory.verdicts[0].inForce).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: a refusal is recorded with its report, rendered by yg check, and credited to its judge', () => {
    const dir = copyFixture('refusal');
    try {
      const doc = packageFor(dir);
      const recorded = run(
        ['verdict', 'record', '--aspect', RULE, '--node', UNIT, '--by', 'alice',
         '--verdict', 'refused', '--report', 'src/services/orders.ts:1 opens with code, not a comment.',
         '--hash', doc.hashes.refused],
        dir,
      );
      expect(recorded.status).toBe(0);

      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      // The judge is named on the member line of the grouped view — the one
      // place a per-pair fact survives grouping — beside the reason.
      expect(after.all).toContain(`- ${UNIT}  Judged by 'alice' (external).`);
      expect(after.all).toContain('opens with code, not a comment.');
      // ...and in the ungrouped view, on the same block.
      expect(run(['check', '--details'], dir).all).toContain(`Aspect '${RULE}' is refused on node:${UNIT}.`);
      expect(after.all).toContain('recorded by a judge outside the configured reviewer: alice (1)');

      const listing = run(['verdict', 'read'], dir);
      expect(listing.stdout).toContain("refused — judged by 'alice'");
      expect(listing.stdout).toContain('report: src/services/orders.ts:1 opens with code, not a comment.');
      expect(run(['verdict', 'read', '--by', 'someone-else'], dir).stdout).toContain('No verdict in this graph was recorded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: every refusal path says what, why and what to do next', () => {
    const dir = copyFixture('refusals');
    try {
      // A rule that runs as code is machine-only.
      const det = run(['verdict', 'package', '--aspect', 'requires-named-export', '--node', UNIT], dir);
      expect(det.status).toBe(1);
      expect(det.stderr).toContain('runs as a local check');
      expect(det.stderr).toContain('yg check --approve --only-deterministic');

      // A unit the rule does not have.
      const unknown = run(['verdict', 'package', '--aspect', RULE, '--node', 'services/ghost'], dir);
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain('has no unit node:services/ghost');
      expect(unknown.stderr).toContain(`node:${UNIT}`);

      // A hash that no longer matches the tree.
      const doc = packageFor(dir);
      appendFileSync(path.join(dir, SUBJECT), '\n// moved on\n');
      const stale = run(
        ['verdict', 'record', '--aspect', RULE, '--node', UNIT, '--by', 'alice', '--verdict', 'pass', '--hash', doc.hashes.pass],
        dir,
      );
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('is not the hash of what is on disk now');
      expect(stale.stderr).toContain('yg verdict package');

      // A refusal with nothing for the author to act on.
      const fresh = packageFor(dir);
      const reportless = run(
        ['verdict', 'record', '--aspect', RULE, '--node', UNIT, '--by', 'alice', '--verdict', 'refused', '--hash', fresh.hashes.refused],
        dir,
      );
      expect(reportless.status).toBe(1);
      expect(reportless.stderr).toContain('no violation report');
      expect(reportless.stderr).toContain('--report');

      // A judgement that is not one of the two words.
      const nonsense = run(
        ['verdict', 'record', '--aspect', RULE, '--node', UNIT, '--by', 'alice', '--verdict', 'maybe', '--hash', fresh.hashes.pass],
        dir,
      );
      expect(nonsense.status).toBe(1);
      expect(nonsense.stderr).toContain("'maybe' is not a verdict.");

      // Nothing above wrote anything.
      expect(run(['verdict', 'read'], dir).stdout).toContain('No verdict in this graph was recorded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: a pair that already holds a verdict is not pending, and recording never became approving', () => {
    const dir = copyFixture('pending');
    try {
      const doc = packageFor(dir);
      run(['verdict', 'record', '--aspect', RULE, '--node', UNIT, '--by', 'alice', '--verdict', 'pass', '--hash', doc.hashes.pass], dir);

      // Judging it again would replace a judgement that still applies.
      const again = run(['verdict', 'package', '--aspect', RULE, '--node', UNIT], dir);
      expect(again.status).toBe(1);
      expect(again.stderr).toContain('already holds a verdict for exactly these inputs');

      // Recording filled exactly one pending pair; everything else the project
      // owes is still owed, and the free deterministic run still answers for its
      // own half exactly as before.
      const det = run(['check', '--approve', '--only-deterministic'], dir);
      expect(det.all).toContain('recorded by a judge outside the configured reviewer: alice (1)');
      // The reviewed rule on the OTHER component is still owed: recording
      // answered for one pair, and the free run answers for no reviewed pair at
      // all — exactly as before this channel existed.
      expect(det.all).toContain(`- services/payments  aspect '${RULE}'`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
