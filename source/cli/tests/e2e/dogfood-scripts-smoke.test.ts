import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Tests for the DOGFOOD-ONLY repo scripts (never adopter surfaces):
//   - scripts/lock-history-audit.mjs  (the lock laundering-signature CI gate)
//   - scripts/decision-load.mjs       (the decision-load λ proxy meter)
//   - scripts/judge-stability.mjs     (reviewer self-consistency, analysis a)
//   - scripts/cusum.mjs               (refusal-rate CUSUM, analysis b)
//   - scripts/mcnemar.mjs             (paired old-vs-new reviewer test, analysis c)
//   - scripts/displacement.mjs        (Bode "waterbed" sibling analysis, analysis d)
//
// All are plain Node ESM with no deps that run READ-ONLY over git history and/or the
// LOCAL, gitignored telemetry sidecars (.yggdrasil/.yg-events.jsonl and
// .yggdrasil/.drill-results.jsonl), self-locating the repo root with `git rev-parse
// --show-toplevel`. No mocking, no fabricated production data:
//   * the spawn-smoke blocks run each script against THIS repository's real
//     history/telemetry and assert exit 0 + a recognizable header;
//   * the audit-signature block builds a REAL on-disk git repo in a temp dir with
//     hand-crafted lock commits and proves the audit's FAIL (exit 1) and WARN
//     (exit 0) paths — without these, a future `===`→`!==` slip in the detector
//     would keep CI green;
//   * the calibration-instrument blocks build REAL on-disk fixtures (a git repo +
//     seeded telemetry sidecars) and prove each instrument's signal path and its
//     honest-empty path — exactly the per-step smoke each analysis requires.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const AUDIT_SCRIPT = path.join(REPO_ROOT, 'scripts/lock-history-audit.mjs');
const isGitRepo = existsSync(path.join(REPO_ROOT, '.git'));

function runScript(rel: string) {
  return spawnSync('node', [path.join(REPO_ROOT, rel)], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

describe.skipIf(!isGitRepo)('dogfood scripts — spawn smoke', () => {
  it('lock-history-audit.mjs exits 0 with its header and summary on real history', () => {
    const res = runScript('scripts/lock-history-audit.mjs');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('lock-history-audit');
    // The summary line is always emitted; on a clean history it reads "0 laundering
    // signatures ...". A non-zero count would have failed the exit-0 assertion above.
    expect(res.stdout).toContain('laundering signatures');
  });

  it('decision-load.mjs exits 0 with its header and the RZ-16 honesty label', () => {
    const res = runScript('scripts/decision-load.mjs');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('decision-load');
    expect(res.stdout).toContain('[RZ-16]');
  });

  // The four calibration instruments against THIS repo's real telemetry. Whatever
  // telemetry exists (possibly thin/empty) they must exit 0, print their header, and
  // end with the mandatory honesty-label footer — never crash.
  for (const [rel, header, args] of [
    ['scripts/judge-stability.mjs', 'judge-stability', []],
    ['scripts/cusum.mjs', 'cusum', []],
    ['scripts/mcnemar.mjs', 'mcnemar', []],
    ['scripts/displacement.mjs', 'displacement', []],
  ] as const) {
    it(`${rel} exits 0 with its header and honesty footer on real telemetry`, () => {
      const res = spawnSync('node', [path.join(REPO_ROOT, rel), ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        maxBuffer: 256 * 1024 * 1024,
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(header);
      expect(res.stdout).toContain('— honesty labels —');
      expect(res.stdout).toMatch(/unknown ≠ zero/);
    });
  }

  // metamorphic.mjs (analysis e) — the DEFAULT (no-arg) mode is the OFFLINE
  // transform self-check: it parses the pilot corpus with the built grammars and
  // proves the rename/reformat transforms are deterministic + idempotent, making
  // ZERO reviewer calls (the `--run` pilot, which does bill the reviewer, is never
  // exercised in CI). It must exit 0, print its header + the §10 inconsistency
  // framing, and end with the honesty footer.
  it('metamorphic.mjs (default self-check) exits 0 offline with header, §10 framing, and footer', () => {
    const res = spawnSync('node', [path.join(REPO_ROOT, 'scripts/metamorphic.mjs')], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('metamorphic');
    expect(res.stdout).toMatch(/INCONSISTENCY, NOT CORRECTNESS/);
    expect(res.stdout).toContain('NO reviewer calls');
    expect(res.stdout).toContain('— honesty labels —');
    expect(res.stdout).toMatch(/all transforms deterministic, idempotent/);
  });
});

// ---------------------------------------------------------------------------
// Calibration instruments — fixture-backed signal + honest-empty proofs. Each test
// builds a throwaway git repo on disk (so `git rev-parse --show-toplevel` resolves
// there) and seeds the LOCAL telemetry sidecars it reads. The telemetry files are
// left UNTRACKED (never git-added), mirroring their real gitignored nature — so the
// scripts print the "local telemetry since" label rather than refusing it.
// ---------------------------------------------------------------------------

/** git-init a temp repo with a `.yggdrasil/` dir; return the dir path. */
function makeInstrumentRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-instr-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: GIT_ENV });
  mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
  return dir;
}
function writeJsonl(dir: string, name: string, records: unknown[]): void {
  writeFileSync(
    path.join(dir, '.yggdrasil', name),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}
function runInstrument(dir: string, rel: string, args: string[] = []) {
  return spawnSync('node', [path.join(REPO_ROOT, rel), ...args], {
    cwd: dir,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

describe('judge-stability (a) — reviewer self-consistency (fixture telemetry)', () => {
  it('names a k/N self-disagreement split on identical diagnostic input', () => {
    const dir = makeInstrumentRepo();
    try {
      // Three diagnostic (aspect-test) repeat runs on ONE identical input (same
      // aspectId, unitKey, hash): two approved, one refused → a 1/3 split.
      const base = {
        v: 1,
        source: 'diag',
        aspectId: 'ambiguous-rule',
        unitKey: 'file:src/x.ts',
        kind: 'llm',
        hash: 'HHHH',
        tier: 'standard',
      };
      writeJsonl(dir, '.yg-events.jsonl', [
        { ...base, ts: '2026-07-01T00:00:01.000Z', disposition: 'approved' },
        { ...base, ts: '2026-07-01T00:00:02.000Z', disposition: 'approved' },
        { ...base, ts: '2026-07-01T00:00:03.000Z', disposition: 'refused' },
      ]);
      const res = runInstrument(dir, 'scripts/judge-stability.mjs');
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/ambiguous-rule: file:src\/x\.ts split 1\/3/);
      expect(res.stdout).toMatch(/sharpen ambiguous-rule content\.md/);
      expect(res.stdout).toContain('— honesty labels —');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports honest-empty on an empty events file (exit 0, no crash)', () => {
    const dir = makeInstrumentRepo();
    try {
      writeFileSync(path.join(dir, '.yggdrasil', '.yg-events.jsonl'), '');
      const res = runInstrument(dir, 'scripts/judge-stability.mjs');
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/self-consistency telemetry yet/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES the "local telemetry since" label when the sidecar is TRACKED in git', () => {
    // A telemetry sidecar that has been git-added is no longer local/private — it is
    // committed, mixes machines/judge regimes, and can be hand-edited. The honesty
    // footer must REFUSE the "local telemetry since" label for it (isTracked → REFUSE).
    const dir = makeInstrumentRepo();
    try {
      writeJsonl(dir, '.yg-events.jsonl', [
        {
          v: 1,
          source: 'diag',
          aspectId: 'some-rule',
          unitKey: 'file:src/x.ts',
          kind: 'llm',
          hash: 'HHHH',
          tier: 'standard',
          disposition: 'approved',
          ts: '2026-07-01T00:00:01.000Z',
        },
      ]);
      // git-add (stage) the sidecar so `git ls-files --error-unmatch` reports it TRACKED.
      execFileSync('git', ['add', '.yggdrasil/.yg-events.jsonl'], { cwd: dir, env: GIT_ENV });
      const res = runInstrument(dir, 'scripts/judge-stability.mjs');
      expect(res.status).toBe(0);
      // Exact refusal wording the footer emits for a tracked source.
      expect(res.stdout).toContain('local-telemetry label REFUSED');
      expect(res.stdout).toContain('TRACKED in git');
      // The honest label must be REFUSED, never emitted, for the tracked file.
      expect(res.stdout).not.toContain('local telemetry since');
      expect(res.stdout).toContain('— honesty labels —');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cusum (b) — refusal-rate shift detector (fixture telemetry)', () => {
  const flatRun = (aspectId: string, n: number, start: number) =>
    Array.from({ length: n }, (_, i) => ({
      v: 1,
      source: 'fill',
      aspectId,
      unitKey: `file:src/${aspectId}-${i}.ts`,
      kind: 'llm',
      disposition: 'approved',
      hash: `h${i}`,
      ts: `2026-07-01T00:${String(Math.floor((start + i) / 60)).padStart(2, '0')}:${String((start + i) % 60).padStart(2, '0')}.000Z`,
    }));

  it('raises an alarm when an aspect steps into a refusal cluster', () => {
    const dir = makeInstrumentRepo();
    try {
      const events = [
        ...flatRun('flat-rule', 30, 0),
        ...flatRun('stepping-rule', 10, 0), // baseline: all approved
        // then a burst of refusals on the same aspect
        ...Array.from({ length: 8 }, (_, i) => ({
          v: 1,
          source: 'fill',
          aspectId: 'stepping-rule',
          unitKey: `file:src/step-r-${i}.ts`,
          kind: 'llm',
          disposition: 'refused',
          hash: `r${i}`,
          reason: 'seeded',
          ts: `2026-07-02T00:00:${String(i).padStart(2, '0')}.000Z`,
        })),
      ];
      writeJsonl(dir, '.yg-events.jsonl', events);
      const res = runInstrument(dir, 'scripts/cusum.mjs');
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/shifted upward/);
      expect(res.stdout).toContain('stepping-rule');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('raises no alarm on a flat all-approved stream', () => {
    const dir = makeInstrumentRepo();
    try {
      writeJsonl(dir, '.yg-events.jsonl', flatRun('calm-rule', 40, 0));
      const res = runInstrument(dir, 'scripts/cusum.mjs');
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('No aspect crossed the alarm threshold');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mcnemar (c) — paired old-vs-new comparison (fixture telemetry)', () => {
  const drill = (aspect: string, caseId: string, tier: string, got: string, ts: string) => ({
    v: 1,
    ts,
    aspect,
    case: caseId,
    expect: 'refused',
    got,
    src: 'dev',
    corpus: 'dev',
    caseHash: `c-${aspect}-${caseId}`,
    ruleHash: `r-${aspect}`,
    kind: 'llm',
    tier,
  });

  it('reports the b/c discordance across two tiers', () => {
    const dir = makeInstrumentRepo();
    try {
      writeJsonl(dir, '.drill-results.jsonl', [
        // b = old refused, new satisfied (old caught, new missed) — two cases
        drill('a1', 'k1', 'oldm', 'refused', '2026-07-01T00:00:01.000Z'),
        drill('a1', 'k1', 'newm', 'satisfied', '2026-07-01T00:00:02.000Z'),
        drill('a1', 'k2', 'oldm', 'refused', '2026-07-01T00:00:03.000Z'),
        drill('a1', 'k2', 'newm', 'satisfied', '2026-07-01T00:00:04.000Z'),
        // c = old satisfied, new refused — one case
        drill('a2', 'k3', 'oldm', 'satisfied', '2026-07-01T00:00:05.000Z'),
        drill('a2', 'k3', 'newm', 'refused', '2026-07-01T00:00:06.000Z'),
        // concordant pairs (carry no signal)
        drill('a3', 'k4', 'oldm', 'refused', '2026-07-01T00:00:07.000Z'),
        drill('a3', 'k4', 'newm', 'refused', '2026-07-01T00:00:08.000Z'),
      ]);
      const res = runInstrument(dir, 'scripts/mcnemar.mjs', ['--old', 'oldm', '--new', 'newm']);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/2 cases the old reviewer caught and the new missed; 1 the reverse/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports "need two tiers" on single-tier data (exit 0)', () => {
    const dir = makeInstrumentRepo();
    try {
      writeJsonl(dir, '.drill-results.jsonl', [
        drill('a1', 'k1', 'solo', 'refused', '2026-07-01T00:00:01.000Z'),
        drill('a1', 'k2', 'solo', 'satisfied', '2026-07-01T00:00:02.000Z'),
      ]);
      const res = runInstrument(dir, 'scripts/mcnemar.mjs', ['--old', 'solo', '--new', 'other']);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/Need two tiers to compare/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('displacement (d) — Bode waterbed sibling analysis (fixture git + telemetry)', () => {
  it('emits a sibling table for a rule edit with active siblings', () => {
    const dir = makeInstrumentRepo();
    try {
      const git = (args: string[], env = GIT_ENV) => execFileSync('git', args, { cwd: dir, env });
      // A rule-source edit for rule-a, committed at a fixed date (drives the window).
      mkdirSync(path.join(dir, '.yggdrasil/aspects/rule-a'), { recursive: true });
      writeFileSync(path.join(dir, '.yggdrasil/aspects/rule-a/content.md'), '# rule-a\noriginal\n');
      git(['add', '.yggdrasil/aspects/rule-a/content.md']);
      git(['commit', '-q', '-m', 'add rule-a'], {
        ...GIT_ENV,
        GIT_AUTHOR_DATE: '2026-07-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-07-01T00:00:00Z',
      });
      // Fill telemetry (UNTRACKED): rule-a and rule-b both fire on file:src/x.ts →
      // siblings. rule-b has decided trials before AND after the edit, with a refusal
      // after → a computable, non-flat sibling row.
      const mk = (aspectId: string, disp: string, ts: string) => ({
        v: 1,
        source: 'fill',
        aspectId,
        unitKey: 'file:src/x.ts',
        kind: 'llm',
        disposition: disp,
        hash: `${aspectId}-${ts}`,
        ts,
      });
      writeJsonl(dir, '.yg-events.jsonl', [
        mk('rule-a', 'approved', '2026-07-01T00:00:00.000Z'),
        mk('rule-b', 'approved', '2026-06-28T00:00:00.000Z'), // before window
        mk('rule-b', 'approved', '2026-06-29T00:00:00.000Z'), // before window
        mk('rule-b', 'refused', '2026-07-03T00:00:00.000Z'), // after window (refusal)
        mk('rule-b', 'approved', '2026-07-04T00:00:00.000Z'), // after window
      ]);
      const res = runInstrument(dir, 'scripts/displacement.mjs');
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/Rule edit: rule-a/);
      expect(res.stdout).toContain('rule-b');
      expect(res.stdout).toContain('— honesty labels —');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports honest-empty when there are no rule-source edits in range', () => {
    const dir = makeInstrumentRepo();
    try {
      const git = (args: string[]) => execFileSync('git', args, { cwd: dir, env: GIT_ENV });
      // A commit that touches NO aspect rule source → zero rule edits to analyze.
      writeFileSync(path.join(dir, 'README.md'), 'hello\n');
      git(['add', 'README.md']);
      git(['commit', '-q', '-m', 'no aspects here']);
      writeJsonl(dir, '.yg-events.jsonl', [
        {
          v: 1,
          source: 'fill',
          aspectId: 'some-rule',
          unitKey: 'file:src/y.ts',
          kind: 'llm',
          disposition: 'approved',
          hash: 'h1',
          ts: '2026-07-01T00:00:00.000Z',
        },
      ]);
      const res = runInstrument(dir, 'scripts/displacement.mjs');
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/No rule-source edits/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture-backed proof of the audit's two detection paths. Each test builds a
// throwaway git repo on disk (no mocking), writes successive revisions of
// .yggdrasil/yg-lock.nondeterministic.json, and spawns the real script with cwd
// set to that repo so its `git` commands resolve there. Deterministic identity
// and dates are supplied via GIT_* env so nothing depends on ambient git config
// or the wall clock. The temp dir is removed in a finally.
// ---------------------------------------------------------------------------

const LOCK_REL = '.yggdrasil/yg-lock.nondeterministic.json';
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'audit-fixture',
  GIT_AUTHOR_EMAIL: 'audit@fixture.test',
  GIT_COMMITTER_NAME: 'audit-fixture',
  GIT_COMMITTER_EMAIL: 'audit@fixture.test',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

function lock(verdicts: unknown): string {
  return JSON.stringify({ version: 1, verdicts, nodes: {} });
}

/** Build a temp git repo; `commit(verdicts)` writes the lock and commits it. */
function makeAuditRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-lock-audit-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, env: GIT_ENV });
  git(['init', '-q']);
  mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
  let n = 0;
  const commit = (verdicts: unknown) => {
    writeFileSync(path.join(dir, LOCK_REL), lock(verdicts));
    git(['add', '-A']);
    git(['commit', '-q', '-m', `rev ${++n}`]);
  };
  return { dir, commit };
}

function runAudit(cwd: string) {
  return spawnSync('node', [AUDIT_SCRIPT], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

describe('lock-history-audit — detection paths (fixture git repo)', () => {
  it('FAILS (exit 1) on a verdict flip with an UNCHANGED input hash', () => {
    const { dir, commit } = makeAuditRepo();
    try {
      // Same (aspectId, unitKey), identical hash, verdict laundered approved->refused.
      commit({ 'asp-x': { 'file:src/a.ts': { hash: 'HHHH', verdict: 'approved' } } });
      commit({ 'asp-x': { 'file:src/a.ts': { hash: 'HHHH', verdict: 'refused' } } });

      const res = runAudit(dir);
      expect(res.status).toBe(1);
      // Verbatim signature line (sha matched loosely as a hex suffix).
      expect(res.stdout).toMatch(
        /^LAUNDERING SIGNATURE: asp-x \/ file:src\/a\.ts verdict approved->refused with unchanged input hash at [0-9a-f]{7,40}$/m,
      );
      expect(res.stdout).toContain('1 laundering signatures');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT fire when the hash also changed (legitimate re-verification)', () => {
    const { dir, commit } = makeAuditRepo();
    try {
      // Verdict flips BUT the input hash changed too — this is a normal re-verify,
      // not a laundering signature, so the audit must stay green.
      commit({ 'asp-x': { 'file:src/a.ts': { hash: 'HHHH', verdict: 'approved' } } });
      commit({ 'asp-x': { 'file:src/a.ts': { hash: 'ZZZZ', verdict: 'refused' } } });

      const res = runAudit(dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('0 laundering signatures');
      expect(res.stdout).not.toContain('LAUNDERING SIGNATURE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('WARNs (exit 0) when a refused entry DISAPPEARS between commits', () => {
    const { dir, commit } = makeAuditRepo();
    try {
      // A refused entry present in rev 1 is gone in rev 2 (replaced by an unrelated
      // approved entry) — the first half of a delete-and-rerun, surfaced as a warning
      // that never fails the build.
      commit({ 'asp-y': { 'file:src/b.ts': { hash: 'KKKK', verdict: 'refused' } } });
      commit({ 'asp-z': { 'file:src/c.ts': { hash: 'LLLL', verdict: 'approved' } } });

      const res = runAudit(dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('WARN:');
      expect(res.stdout).toContain('asp-y / file:src/b.ts');
      expect(res.stdout).toContain('0 laundering signatures');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
