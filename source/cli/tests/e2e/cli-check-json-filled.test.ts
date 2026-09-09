// =============================================================================
// CLI E2E — when a verdict was filled (`yg check --json`'s `filled` field, and
// the matching `sha` on the verdict-events telemetry line).
//
// Every scenario runs against a real temp copy of tests/fixtures/sample-project-
// ports/, built into a real git repository through the shared, isolation-pinned
// runGitFixture helper (never a raw spawned `git`). Deterministic scenarios use
// the fixture's own `audit-required` aspect as-is; LLM scenarios switch that
// same aspect to `reviewer: { type: llm }` in the copy and answer it with the
// in-process mock reviewer — no network, no real key.
//
//    1. deterministic pair, git repo         → filled: null (zero cost)
//    2. LLM pair via mock                    → filled.sha = HEAD sha, filled.ts is ISO
//    3. a later unrelated commit             → filled.sha stays the OLD sha
//    4. a later code change (pair → stale)   → filled keeps the OLD ts/sha
//    5. no git repository at all             → filled.ts present, filled.sha null, no git error on stderr
//    6+7. an old-shaped lock (no filledAt/filledSha) → filled: null, and stays
//         byte-identical through both a plain check and a no-op --approve
//    8. events.committed_llm: true           → the committed stream's one line carries sha, no reason
//    9. two parallel --approve --only-deterministic → lock integrity, not a race on the outcome
//   10. a lock truncated mid-object          → refusal naming the file, exit 1, no leftover .tmp
//   11. a lock entry with an unknown key     → refusal naming the key
//   12. a read-only LOCK FILE (chmod 444)    → today's actual behavior, pinned (see comment)
//   13. core.autocrlf + CRLF on re-checkout  → same hash as LF, filled unchanged
//   14. a repository path with a space and unicode → filled.sha still reads correctly
//   15. a symlinked .yggdrasil               → today's actual behavior, pinned
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, appendFileSync, readdirSync, chmodSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync, type ChatReply, type ChatRequest, type MockReviewer } from './support/mock-reviewer.js';
import { runGitFixture } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-ports');
const distExists = existsSync(BIN_PATH);

const ASPECT = 'audit-required';
const UNIT_PATH = 'services/orders';
const SUBJECT = path.join('src', 'services', 'orders.ts');
const NONDET_LOCK = path.join('.yggdrasil', 'yg-lock.nondeterministic.json');
const DET_LOCK = path.join('.yggdrasil', '.yg-lock.deterministic.json');
const ASPECT_YAML = path.join('.yggdrasil', 'aspects', ASPECT, 'yg-aspect.yaml');
const CONFIG_YAML = path.join('.yggdrasil', 'yg-config.yaml');

interface FilledPair {
  aspect: string;
  unit: { kind: string; path: string };
  kind: string;
  verdict: string;
  filled: { ts: string; sha: string | null } | null;
}
interface FilledCheckDoc {
  pairs: FilledPair[];
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function checkJson(dir: string): FilledCheckDoc {
  const r = run(['check', '--json'], dir);
  return JSON.parse(r.stdout) as FilledCheckDoc;
}

function findPair(doc: FilledCheckDoc, aspect: string, unitPath: string): FilledPair {
  const p = doc.pairs.find((x) => x.aspect === aspect && x.unit.path === unitPath);
  if (!p) throw new Error(`pair not found: ${aspect} / ${unitPath} among ${JSON.stringify(doc.pairs)}`);
  return p;
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-filled-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Switch the fixture's one aspect from `deterministic` to `llm` in the copy.
 * An LLM aspect must not ship check.mjs (the deterministic reviewer's own
 * input) and must ship content.md instead (the rule text the reviewer reads).
 */
function switchToLlm(dir: string): void {
  const p = path.join(dir, ASPECT_YAML);
  const before = readFileSync(p, 'utf-8');
  const after = before.replace('type: deterministic', 'type: llm');
  if (after === before) throw new Error('switchToLlm: pattern not found — fixture drifted');
  writeFileSync(p, after, 'utf-8');
  const aspectDir = path.dirname(p);
  rmSync(path.join(aspectDir, 'check.mjs'), { force: true });
  writeFileSync(
    path.join(aspectDir, 'content.md'),
    'Consumers of the charge port must record an audit trail for every charge.\n',
    'utf-8',
  );
}

/** Point the reviewer tier's endpoint at the mock. */
function pointReviewer(dir: string, endpoint: string): void {
  const p = path.join(dir, CONFIG_YAML);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}

/** Append `events: { committed_llm: true }` to the copy's config. */
function enableCommittedLlm(dir: string): void {
  const p = path.join(dir, CONFIG_YAML);
  writeFileSync(p, `${readFileSync(p, 'utf-8')}\nevents:\n  committed_llm: true\n`, 'utf-8');
}

/** Build a real git repo (init, add, commit) pinned to `dir` via the isolation-safe helper. */
function gitInitCommit(dir: string): void {
  expect(runGitFixture(dir, ['init', '-q', '-b', 'main']).status).toBe(0);
  expect(runGitFixture(dir, ['add', '-A']).status).toBe(0);
  expect(runGitFixture(dir, ['commit', '-qm', 'base']).status).toBe(0);
}

function headSha(dir: string): string {
  const r = runGitFixture(dir, ['rev-parse', 'HEAD']);
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

const ALWAYS_OK: (r: ChatRequest, i: number) => ChatReply = () => ({ satisfied: true, reason: 'mock-approve' });

/**
 * Fresh copy of the fixture, aspect switched to LLM, mock reviewer answering
 * every call, git repo with one commit, and one real `check --approve` run
 * against it. Returns the directory, the live mock (caller closes it), the
 * commit sha at approval time, and the `filled` value the approve produced.
 */
async function approvedLlmFixture(
  label: string,
  opts: { committedLlm?: boolean } = {},
): Promise<{ dir: string; mock: MockReviewer; sha: string; filledAfterApprove: FilledPair['filled'] }> {
  const dir = copyFixture(label);
  switchToLlm(dir);
  const mock = await startMockReviewer({ respond: ALWAYS_OK });
  pointReviewer(dir, mock.endpoint);
  if (opts.committedLlm) enableCommittedLlm(dir);
  gitInitCommit(dir);

  const approved = await runAsync(['check', '--approve'], dir);
  if (approved.status !== 0) throw new Error(`setup approve failed (status ${approved.status}): ${approved.all}`);

  const sha = headSha(dir);
  const filledAfterApprove = findPair(checkJson(dir), ASPECT, UNIT_PATH).filled;
  return { dir, mock, sha, filledAfterApprove };
}

describe.skipIf(!distExists)('CLI E2E — when a verdict was filled', () => {
  it('1: a deterministic pair, in a real git repo, reports filled: null (zero cost, nothing to attribute)', () => {
    const dir = copyFixture('det-null');
    try {
      gitInitCommit(dir);
      expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);
      const doc = checkJson(dir);
      const p = findPair(doc, ASPECT, UNIT_PATH);
      expect(p.kind).toBe('deterministic');
      expect(p.filled).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: an LLM pair filled via the mock reviewer reports filled.sha = HEAD, and filled.ts parses as ISO', async () => {
    const { dir, mock, sha } = await approvedLlmFixture('llm-sha');
    try {
      const p = findPair(checkJson(dir), ASPECT, UNIT_PATH);
      expect(p.verdict).toBe('approved');
      expect(p.filled?.sha).toBe(sha);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(p.filled?.ts).toBeTruthy();
      expect(Number.isNaN(Date.parse(p.filled!.ts))).toBe(false);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('3: a later commit with no code change still reports the OLD sha (filled describes the fill moment, not the read moment)', async () => {
    const { dir, mock, sha } = await approvedLlmFixture('later-commit');
    try {
      // An empty commit moves HEAD without touching a single tracked byte.
      expect(runGitFixture(dir, ['commit', '--allow-empty', '-qm', 'unrelated']).status).toBe(0);
      expect(headSha(dir)).not.toBe(sha);

      const p = findPair(checkJson(dir), ASPECT, UNIT_PATH);
      expect(p.filled?.sha).toBe(sha);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: a code change that makes the pair stale still carries the OLD filled ts/sha, with verdict stale', async () => {
    const { dir, mock, filledAfterApprove } = await approvedLlmFixture('goes-stale');
    try {
      appendFileSync(path.join(dir, SUBJECT), '\n// a later edit\n');
      const p = findPair(checkJson(dir), ASPECT, UNIT_PATH);
      expect(p.verdict).toBe('stale');
      expect(p.filled).toEqual(filledAfterApprove);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: a directory with no git repository still fills filled.ts; filled.sha is null, and stderr carries no git error', async () => {
    const dir = copyFixture('no-git');
    switchToLlm(dir);
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      // Deliberately no gitInitCommit — this directory is not a repository.
      const approved = await runAsync(['check', '--approve', '--json'], dir);
      expect(approved.status).toBe(0);
      expect(approved.stderr).not.toContain('fatal:');
      expect(approved.stderr.toLowerCase()).not.toContain('not a git repository');

      const doc = JSON.parse(approved.stdout) as FilledCheckDoc;
      const p = findPair(doc, ASPECT, UNIT_PATH);
      expect(typeof p.filled?.ts).toBe('string');
      expect(p.filled?.sha).toBeNull();
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6+7: an old-shaped lock entry (no filledAt/filledSha) reads as filled: null, and stays byte-identical through a plain check and a no-op --approve', async () => {
    const { dir, mock } = await approvedLlmFixture('old-shaped');
    try {
      const lockPath = path.join(dir, NONDET_LOCK);
      const withFields = readFileSync(lockPath, 'utf-8');
      expect(withFields).toMatch(/"filledAt":"[^"]*","filledSha":"[^"]*",/);
      // Surgical removal (not a re-serialize) — the remaining bytes are exactly
      // what this CLI's own allow-list serializer produces for an entry that
      // never carried the two fields, since it is conditional per-field.
      const oldShaped = withFields.replace(/"filledAt":"[^"]*","filledSha":"[^"]*",/, '');
      writeFileSync(lockPath, oldShaped, 'utf-8');
      const beforeBytes = readFileSync(lockPath);

      // Scenario 6 — a plain read never writes, and reports filled: null for
      // an entry that predates the field.
      const plain = run(['check', '--json'], dir);
      expect(plain.status).toBe(0);
      expect(findPair(JSON.parse(plain.stdout) as FilledCheckDoc, ASPECT, UNIT_PATH).filled).toBeNull();
      expect(readFileSync(lockPath).equals(beforeBytes)).toBe(true);

      // Scenario 7 — the pair is still VALID (filledAt/filledSha are not hash
      // ingredients), so --approve finds nothing unverified and rewrites nothing.
      const approved = await runAsync(['check', '--approve'], dir);
      expect(approved.status).toBe(0);
      expect(readFileSync(lockPath).equals(beforeBytes)).toBe(true);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('8: with events.committed_llm on, the committed stream carries one single-line entry with sha and no reason', async () => {
    const { dir, mock } = await approvedLlmFixture('committed-events', { committedLlm: true });
    try {
      const raw = readFileSync(path.join(dir, '.yggdrasil', 'yg-events.llm.jsonl'), 'utf-8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('\n');
      const parsed = JSON.parse(lines[0]) as { sha?: string; reason?: string };
      expect(typeof parsed.sha).toBe('string');
      expect(parsed.sha).toMatch(/^[0-9a-f]{40}$/);
      expect('reason' in parsed).toBe(false);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('9: two parallel --approve --only-deterministic runs leave a lock that parses and validates (integrity, not a race on the outcome)', async () => {
    const dir = copyFixture('parallel-approve');
    try {
      gitInitCommit(dir);
      const [a, b] = await Promise.all([
        runAsync(['check', '--approve', '--only-deterministic'], dir),
        runAsync(['check', '--approve', '--only-deterministic'], dir),
      ]);
      expect([0, 1]).toContain(a.status);
      expect([0, 1]).toContain(b.status);

      // Integrity, not outcome: whatever happened, the det lock is
      // syntactically valid JSON afterward, and a follow-up check is green.
      const detLockPath = path.join(dir, DET_LOCK);
      expect(() => JSON.parse(readFileSync(detLockPath, 'utf-8'))).not.toThrow();
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('10: a lock truncated mid-object is refused, naming the file, exit 1, and leaves no leftover .tmp', async () => {
    const { dir, mock } = await approvedLlmFixture('truncated');
    try {
      const lockPath = path.join(dir, NONDET_LOCK);
      const original = readFileSync(lockPath, 'utf-8');
      writeFileSync(lockPath, original.slice(0, Math.floor(original.length / 2)), 'utf-8');

      const r = run(['check'], dir);
      expect(r.status).toBe(1);
      expect(r.all).toContain('yg-lock.nondeterministic.json');

      const leftoverTmp = readdirSync(path.join(dir, '.yggdrasil')).filter((f) => f.endsWith('.tmp'));
      expect(leftoverTmp).toEqual([]);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11: a lock entry with an unknown key ("filledWhen") is refused as an unexpected key, naming it', async () => {
    const { dir, mock } = await approvedLlmFixture('unknown-key');
    try {
      const lockPath = path.join(dir, NONDET_LOCK);
      const withFields = readFileSync(lockPath, 'utf-8');
      const injected = withFields.replace('{"filledAt"', '{"filledWhen":"x","filledAt"');
      expect(injected).not.toBe(withFields);
      writeFileSync(lockPath, injected, 'utf-8');

      const r = run(['check'], dir);
      expect(r.status).toBe(1);
      expect(r.all).toContain('unexpected key');
      expect(r.all).toContain('filledWhen');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Today's ACTUAL behavior, pinned as-is — not a designed guarantee. A plain
  // POSIX rename onto an existing target does not consult that target's own
  // permission bits (only the containing directory's write permission), so
  // this CLI's atomic-write-then-rename lock writer silently succeeds and
  // resets the mode bits, rather than refusing. (A chmod on the CONTAINING
  // DIRECTORY instead does make the write fail, but as an unclassified crash —
  // "This is a bug — please file an issue" — not a graceful refusal; that is a
  // real gap in the pre-existing lock writer, unrelated to filledAt/filledSha,
  // and is reported separately rather than fixed under this ticket.)
  it.skipIf(process.platform === 'win32')('12: a read-only LOCK FILE (chmod 444) does not block --approve — the rename-based writer ignores the target\'s own permission bits', async () => {
    const dir = copyFixture('readonly-lock');
    try {
      gitInitCommit(dir);
      expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);
      appendFileSync(path.join(dir, SUBJECT), '\n// invalidate the det verdict\n');
      const lockPath = path.join(dir, DET_LOCK);
      chmodSync(lockPath, 0o444);

      const r = run(['check', '--approve', '--only-deterministic'], dir);
      expect(r.status).toBe(0);
      const p = findPair(checkJson(dir), ASPECT, UNIT_PATH);
      expect(p.verdict).toBe('approved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('13: core.autocrlf + a CRLF re-checkout hashes the same as LF, so --approve fills nothing and filled does not change', async () => {
    const { dir, mock, filledAfterApprove } = await approvedLlmFixture('autocrlf');
    try {
      expect(runGitFixture(dir, ['config', 'core.autocrlf', 'true']).status).toBe(0);
      // Force a full re-materialization: removing the file first means checkout
      // cannot treat it as already-clean and skip the smudge filter, so autocrlf
      // actually rewrites it with CRLF endings.
      rmSync(path.join(dir, SUBJECT));
      expect(runGitFixture(dir, ['checkout', '--', SUBJECT]).status).toBe(0);
      const bytes = readFileSync(path.join(dir, SUBJECT));
      expect(bytes.includes(0x0d)).toBe(true); // contains a CR byte — genuinely CRLF now

      const approved = await runAsync(['check', '--approve'], dir);
      expect(approved.status).toBe(0);
      expect(approved.all).toContain('Filling 0 unverified pairs');

      const p = findPair(checkJson(dir), ASPECT, UNIT_PATH);
      expect(p.filled).toEqual(filledAfterApprove);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('14: a repository path with a space and unicode still reads filled.sha correctly', async () => {
    const dir = copyFixture('ünïcode with spaces');
    switchToLlm(dir);
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      gitInitCommit(dir);
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      const sha = headSha(dir);
      const p = findPair(checkJson(dir), ASPECT, UNIT_PATH);
      expect(p.filled?.sha).toBe(sha);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Today's ACTUAL behavior, pinned as-is — not a designed guarantee (per this
  // suite's own scenario 15 spec: whatever it is, with a comment). A symlinked
  // .yggdrasil works completely transparently: Node's fs calls follow it like
  // any other directory, so the fill and the read side both behave exactly as
  // they do over a real directory.
  it('15: a symlinked .yggdrasil — today\'s behavior pinned as-is (works transparently)', () => {
    const dir = copyFixture('symlink-outer');
    const realYggdrasil = path.join(path.dirname(dir), `${path.basename(dir)}-real-yggdrasil`);
    try {
      renameSync(path.join(dir, '.yggdrasil'), realYggdrasil);
      symlinkSync(realYggdrasil, path.join(dir, '.yggdrasil'), 'dir');

      gitInitCommit(dir);
      const r = run(['check', '--approve', '--only-deterministic', '--json'], dir);
      expect(r.status).toBe(0);
      const p = findPair(JSON.parse(r.stdout) as FilledCheckDoc, ASPECT, UNIT_PATH);
      expect(p.verdict).toBe('approved');
      expect(p.filled).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(realYggdrasil, { recursive: true, force: true });
    }
  });
});
