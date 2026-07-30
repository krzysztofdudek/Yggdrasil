import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture } from '../support/git-fixture.js';
import { detLockPath } from './support/read-lock.js';
import { FIXTURE_TWO_COVERED_FILES } from '../fixtures/type-level-engine/variants/index.js';

// ---------------------------------------------------------------------------
// CLI E2E — `yg aspects --health` (C3 slice 1).
//
// The health view is a read-only per-aspect projection over the graph, the
// lock, and a live suppress-marker scan. Columns, in order:
//   aspect | kind | status | nodes | pairs | refused | suppresses | errs
//
// Binding honesty invariants exercised here:
//   - `refused` counts ONLY lock entries whose hash STILL validates. A pair with
//     no valid verdict (absent deterministic cache, or an LLM pair never filled)
//     reads the WORD `unverified`, NEVER `0` ("unverified ≠ zero").
//   - suppress markers come from a LIVE scan; a wildcard marker is summarized on
//     its own line, never attributed to a single aspect.
//   - the default `yg aspects` output (no flag) is byte-for-byte unchanged.
//
// Hermetic — no LLM, no network: the fixture's LLM aspect is left UNfilled (so it
// reads `unverified`), and the deterministic verdicts drive every refuse/pass.
// Each test builds its own temp copy of the committed e2e-lifecycle fixture.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// Exact bytes of `yg aspects` (no flag) on the e2e-lifecycle fixture, captured
// from the pre-`--health` binary. The default path must stay byte-identical.
const DEFAULT_ASPECTS_GOLDEN =
  'has-doc-comment [enforced] — Every source file must begin with a documentation comment describing the file\'s purpose.\n' +
  '  Reviewer: llm — tier: (default)\n' +
  '  Used by: 2 nodes (architecture: 2)\n' +
  '\n' +
  'no-todo-comments [enforced] — Source files must not contain TODO comments — track work in the issue tracker, not the code.\n' +
  '  Reviewer: deterministic\n' +
  '  Used by: 2 nodes (architecture: 2)\n' +
  '\n' +
  'requires-named-export [advisory] — Each source file should expose at least one named export so it can be consumed as a module.\n' +
  '  Reviewer: deterministic\n' +
  '  Used by: 2 nodes (architecture: 2)\n' +
  '\n' +
  'wip-rule [draft] — Work-in-progress rule that is not ready for judgment yet — kept draft so the reviewer skips it.\n' +
  '  Reviewer: deterministic\n' +
  '  Used by: 1 node (direct: 1)\n';

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-aspects-health-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');
const aspectYaml = (dir: string, id: string) =>
  path.join(dir, '.yggdrasil', 'aspects', id, 'yg-aspect.yaml');

/** Return the health-table data row for `aspectId`, split into its cells. */
function healthRow(output: string, aspectId: string): string[] {
  const line = output
    .split('\n')
    .find((l) => l.trim().split(/\s+/)[0] === aspectId);
  if (line === undefined) throw new Error(`no health row for aspect '${aspectId}' in:\n${output}`);
  return line.trim().split(/\s{2,}/);
}

// Column indices for the fixed order:
//   aspect | kind | status | nodes | pairs | refused | suppresses | errs | age | catch | exposure | signal | fp | wrong-rule | files
const COL = {
  aspect: 0, kind: 1, status: 2, nodes: 3, pairs: 4, refused: 5, suppresses: 6, errs: 7, age: 8,
  catch: 9, exposure: 10, signal: 11, fp: 12, wrongRule: 13, files: 14,
};

/** Append well-formed synthetic telemetry lines to a gitignored sidecar under `.yggdrasil/`. */
function writeSidecar(dir: string, filename: string, lines: object[]): void {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(path.join(dir, '.yggdrasil', filename), body, 'utf-8');
}

/**
 * Stage a REAL in-repo drill case on disk under an aspect's drills/ directory. The
 * health view now consults drill telemetry ONLY for cases that still live in the
 * aspect's current corpus, so a drill line that drives a covenant reading must name
 * a case that actually exists — this puts one there (a `.ts` file whose
 * extension-stripped, corpus-relative label equals `caseLabel`).
 */
function stageDrillCase(dir: string, aspectId: string, caseLabel: string): void {
  const abs = path.join(dir, '.yggdrasil', 'aspects', aspectId, 'drills', `${caseLabel}.ts`);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n', 'utf-8');
}

/** N approved fill events on one unit with distinct hashes (N distinct triples). */
function approvedFills(aspectId: string, unitKey: string, n: number, kind: 'llm' | 'deterministic'): object[] {
  const out: object[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ v: 1, ts: '2026-07-01T00:00:00.000Z', source: 'fill', aspectId, unitKey, kind, disposition: 'approved', hash: `h-${aspectId}-${i}` });
  }
  return out;
}

describe.skipIf(!distExists)('CLI E2E — yg aspects --health (C3 slice 1)', () => {
  it('default `yg aspects` output is byte-identical (no --health regression)', () => {
    const dir = copyFixture('default-guard');
    try {
      const first = run(['aspects'], dir);
      expect(first.status).toBe(0);
      expect(first.stdout).toBe(DEFAULT_ASPECTS_GOLDEN);

      // Determinism: a second run is identical too.
      const second = run(['aspects'], dir);
      expect(second.stdout).toBe(DEFAULT_ASPECTS_GOLDEN);

      // --health produces a DIFFERENT (table) rendering.
      const health = run(['aspects', '--health'], dir);
      expect(health.stdout).not.toBe(DEFAULT_ASPECTS_GOLDEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders per-aspect health: hash-valid refusals, unverified (not zero), suppress markers, errs', () => {
    const dir = copyFixture('health');
    try {
      // Give the deterministic aspects an error-direction label so the errs column
      // has content to render (errs is metadata — never folded into a verdict hash).
      appendFileSync(aspectYaml(dir, 'no-todo-comments'), '\nerrs: over\n');
      appendFileSync(aspectYaml(dir, 'requires-named-export'), '\nerrs: exact\n');

      // One deterministic refusal: a TODO on the orders service violates the
      // enforced no-todo-comments rule.
      appendFileSync(ordersFile(dir), '\n// TODO: refactor this later\n');

      // One live suppress marker targeting requires-named-export (payments keeps
      // its named exports, so nothing is actually waived — the marker is only here
      // to be counted).
      appendFileSync(
        paymentsFile(dir),
        '\n// yg-suppress(requires-named-export) known debt, tracked externally\n',
      );

      // Fill the deterministic pairs into the gitignored cache (keyless, no LLM).
      run(['check', '--approve', '--only-deterministic'], dir);
      const detPath = detLockPath(path.join(dir, '.yggdrasil'));
      expect(existsSync(detPath)).toBe(true);

      // Simulate an ABSENT deterministic cache for requires-named-export: drop its
      // entries so those pairs have no valid verdict → they must read `unverified`.
      const det = JSON.parse(readFileSync(detPath, 'utf-8')) as {
        version: number;
        verdicts: Record<string, unknown>;
        nodes: Record<string, unknown>;
      };
      delete det.verdicts['requires-named-export'];
      writeFileSync(detPath, JSON.stringify(det), 'utf-8');

      const health = run(['aspects', '--health'], dir);
      expect(health.status).toBe(0); // informational, never blocks
      const out = health.stdout;

      // Header carries the mandated column order.
      const header = out.split('\n').find((l) => l.includes('aspect') && l.includes('refused'));
      expect(header).toBeDefined();
      const headerCols = header!.trim().split(/\s{2,}/);
      expect(headerCols).toEqual([
        'aspect', 'kind', 'status', 'nodes', 'pairs', 'refused', 'suppresses', 'errs', 'age',
        'catch', 'exposure', 'signal', 'fp', 'wrong-rule', 'files',
      ]);

      // no-todo-comments: one hash-valid refusal (orders), one approved (payments).
      const noTodo = healthRow(out, 'no-todo-comments');
      expect(noTodo[COL.kind]).toBe('deterministic');
      expect(noTodo[COL.status]).toBe('enforced');
      expect(noTodo[COL.nodes]).toBe('2');
      expect(noTodo[COL.pairs]).toBe('2');
      expect(noTodo[COL.refused]).toBe('1');
      expect(noTodo[COL.suppresses]).toBe('0');
      expect(noTodo[COL.errs]).toBe('over');
      // The temp copy is not a git repo ⇒ rule creation history is unavailable, so
      // the age reads the WORD `unknown`, never a fabricated `0`.
      expect(noTodo[COL.age]).toBe('unknown');
      expect(noTodo[COL.age]).not.toBe('0');

      // requires-named-export: deterministic cache absent ⇒ unverified, NEVER 0.
      const reqExport = healthRow(out, 'requires-named-export');
      expect(reqExport[COL.refused]).toBe('unverified');
      expect(reqExport[COL.refused]).not.toBe('0');
      expect(reqExport[COL.suppresses]).toBe('1');
      expect(reqExport[COL.errs]).toBe('exact');

      // has-doc-comment: LLM pair never filled ⇒ unverified, NEVER 0.
      const hasDoc = healthRow(out, 'has-doc-comment');
      expect(hasDoc[COL.kind]).toBe('llm');
      expect(hasDoc[COL.refused]).toBe('unverified');
      expect(hasDoc[COL.refused]).not.toBe('0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders catch/exposure counts, the decorative? covenant line, and plain-words uncertainty (C3 slice 3)', () => {
    const dir = copyFixture('signals');
    try {
      // has-doc-comment (llm): 25 approved, 0 refused → decorative?; a PASSING drill
      // proves it still catches, so the covenant reads "may be deterring", not useless.
      // no-todo-comments (det): 5 refused + 5 approved → active with real counts.
      // requires-named-export (det): 3 approved → thin data → wide uncertainty.
      const refusedFills = Array.from({ length: 5 }, (_, i) => ({
        v: 1, ts: '2026-07-01T00:00:00.000Z', source: 'fill', aspectId: 'no-todo-comments',
        unitKey: 'node:services/orders', kind: 'deterministic', disposition: 'refused', hash: `r-${i}`,
      }));
      writeSidecar(dir, '.yg-events.jsonl', [
        ...approvedFills('has-doc-comment', 'node:services/orders', 25, 'llm'),
        ...refusedFills,
        ...approvedFills('no-todo-comments', 'node:services/payments', 5, 'deterministic'),
        ...approvedFills('requires-named-export', 'node:services/orders', 3, 'deterministic'),
      ]);
      // The proves-catch drill only counts while its case is REAL in the current
      // corpus (orphaned telemetry is dropped), so stage the case on disk.
      stageDrillCase(dir, 'has-doc-comment', 'violates-x/needs-doc');
      writeSidecar(dir, '.drill-results.jsonl', [
        {
          v: 1, ts: '2026-07-01T00:00:00.000Z', aspect: 'has-doc-comment',
          case: 'violates-x/needs-doc', expect: 'refused', got: 'refused',
          src: 'dev', corpus: 'dev', caseHash: 'c'.repeat(64), ruleHash: 'r'.repeat(64), kind: 'llm',
        },
      ]);

      const health = run(['aspects', '--health'], dir);
      expect(health.status).toBe(0); // informational, never blocks
      const out = health.stdout;

      // has-doc-comment: never caught across 25 exposures → decorative?
      const hasDoc = healthRow(out, 'has-doc-comment');
      expect(hasDoc[COL.catch]).toBe('0');
      expect(hasDoc[COL.exposure]).toBe('25');
      expect(hasDoc[COL.signal]).toBe('decorative?');
      // Anti-Goodhart covenant, verbatim: a passing drill means it may be deterring.
      expect(out).toContain('enforceable but never violated — may be deterring violations');

      // no-todo-comments: a frequently-refused rule reads active with its counts.
      const noTodo = healthRow(out, 'no-todo-comments');
      expect(noTodo[COL.catch]).toBe('5');
      expect(noTodo[COL.exposure]).toBe('10');
      expect(noTodo[COL.signal]).toBe('active');

      // requires-named-export: thin data → the range is stated in plain words.
      const reqExport = healthRow(out, 'requires-named-export');
      expect(reqExport[COL.exposure]).toBe('3');
      expect(out).toContain('uncertainty range is wide (few observations)');

      // Method names never leak into operator-facing text.
      expect(out).not.toContain('beta-binomial');
      expect(out).not.toContain('Wilson');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops an orphaned drill signal: a holdout MISS never flips the covenant to "weakening"', () => {
    const dir = copyFixture('signals-orphan');
    try {
      // has-doc-comment: 25 approved, 0 refused → decorative?. A MISS is on record,
      // but it is a HOLDOUT (external --dir) measurement — not an in-repo corpus case
      // — so the health view must ignore it: the covenant reads "unconfirmed", never
      // "the rule may be weakening". (No drills/ case is staged, so even were it a dev
      // line it would be an orphan.)
      writeSidecar(dir, '.yg-events.jsonl', [
        ...approvedFills('has-doc-comment', 'node:services/orders', 25, 'llm'),
      ]);
      writeSidecar(dir, '.drill-results.jsonl', [
        {
          v: 1, ts: '2026-07-01T00:00:00.000Z', aspect: 'has-doc-comment',
          case: 'violates-x/needs-doc', expect: 'refused', got: 'satisfied',
          src: 'holdout', corpus: 'probe', caseHash: 'c'.repeat(64), ruleHash: 'r'.repeat(64), kind: 'llm',
        },
      ]);

      const health = run(['aspects', '--health'], dir);
      expect(health.status).toBe(0);
      const out = health.stdout;
      // Still decorative? (the catch/exposure record is unchanged)…
      expect(healthRow(out, 'has-doc-comment')[COL.signal]).toBe('decorative?');
      // …but the orphaned holdout MISS is ignored: no "weakening", only "unconfirmed".
      expect(out).not.toContain('the rule may be weakening');
      expect(out).toContain(
        'no regression drill confirms it can still catch, so whether it deters or is decorative is unconfirmed',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Rule-age column (C3 slice 2): a committed rule source shows a coarse duration;
  // the default `yg aspects` listing must stay byte-identical even when git history
  // IS present, proving the age lookup lives only behind `--health`.
  const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;

  it.skipIf(!gitAvailable)(
    'a committed rule shows a coarse age; the default listing stays byte-identical in a git repo',
    () => {
      const dir = copyFixture('age-git');
      try {
        // Stand up a real repo and commit the whole graph with a backdated instant,
        // so every rule source has a first-add far in the past (a stable years bucket
        // regardless of when the suite runs).
        const gitEnv = {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
          GIT_AUTHOR_DATE: '2015-01-01T00:00:00',
          GIT_COMMITTER_DATE: '2015-01-01T00:00:00',
        };
        const git = (args: string[]) => runGitFixture(dir, args, { extraEnv: gitEnv });
        git(['init', '-q']);
        git(['add', '-A']);
        git(['commit', '-q', '-m', 'seed']);

        const health = run(['aspects', '--health'], dir);
        expect(health.status).toBe(0);

        // Header still ends with the new age column, after errs.
        const header = health.stdout.split('\n').find((l) => l.includes('aspect') && l.includes('age'));
        expect(header!.trim().split(/\s{2,}/)).toEqual([
          'aspect', 'kind', 'status', 'nodes', 'pairs', 'refused', 'suppresses', 'errs', 'age',
          'catch', 'exposure', 'signal', 'fp', 'wrong-rule', 'files',
        ]);

        // A deterministic rule (ships check.mjs) committed in 2015 reads a coarse,
        // years-scale age — a real value, never `unknown`.
        const noTodo = healthRow(health.stdout, 'no-todo-comments');
        expect(noTodo[COL.age]).not.toBe('unknown');
        expect(noTodo[COL.age]).toMatch(/^\d+y$/);

        // An LLM rule (ships content.md) is aged the same way from its content file.
        const hasDoc = healthRow(health.stdout, 'has-doc-comment');
        expect(hasDoc[COL.age]).toMatch(/^\d+y$/);

        // The default `yg aspects` output is byte-identical to the pre-`--health`
        // golden EVEN with git history present — the age lookup never touches it.
        const plain = run(['aspects'], dir);
        expect(plain.stdout).toBe(DEFAULT_ASPECTS_GOLDEN);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // ── fp column (C3 slice 4): refusals a human later waived or overturned ──────
  //
  // `fp` joins the union verdict-event stream (past refusals) against a LIVE
  // suppress scan: a refused (aspect, unit) whose block is now covered by a
  // suppress marker for that aspect is a false-block signal. Two criteria:
  //   (a) SUPPRESSED — a refusal covered by a live marker (the human waived it).
  //   (b) OVERTURNED — a refusal that later flipped to approved with the marker
  //       now covering it (overturned by a suppress-range change, not a rule fix).
  // A refusal that stayed refused with NO covering marker is NOT fp. The cell is
  // a COUNT with a thin-data honesty label — never a bare rate — and it never
  // reaches the exit code (exit 0, read-only).

  /** One refused fill event on a unit (a "block"). */
  function refusedFill(aspectId: string, unitKey: string, hash: string, ts: string): object {
    return { v: 1, ts, source: 'fill', aspectId, unitKey, kind: 'deterministic', disposition: 'refused', hash };
  }
  /** One approved fill event on a unit (an overturn, when it post-dates a refusal). */
  function approvedFill(aspectId: string, unitKey: string, hash: string, ts: string): object {
    return { v: 1, ts, source: 'fill', aspectId, unitKey, kind: 'deterministic', disposition: 'approved', hash };
  }

  it('(a) a refusal later covered by a suppress marker is counted in fp; (c) one that stays refused with no marker is not', () => {
    const dir = copyFixture('fp-suppressed');
    try {
      // no-todo-comments: a past block on orders, now covered by a LIVE suppress
      // marker for the SAME aspect in that node's file → criterion (a) → fp.
      // requires-named-export: a past block on payments with NO marker → not fp.
      writeSidecar(dir, '.yg-events.jsonl', [
        refusedFill('no-todo-comments', 'node:services/orders', 'r-todo-1', '2026-07-01T00:00:00.000Z'),
        refusedFill('requires-named-export', 'node:services/payments', 'r-exp-1', '2026-07-01T00:00:00.000Z'),
      ]);
      appendFileSync(
        ordersFile(dir),
        '\n// yg-suppress(no-todo-comments) known debt, tracked externally\n',
      );

      const health = run(['aspects', '--health'], dir);
      expect(health.status).toBe(0); // informational, never blocks
      const out = health.stdout;

      // Header carries the fp column, followed by wrong-rule and files.
      const header = out.split('\n').find((l) => l.includes('aspect') && l.includes('fp'));
      expect(header!.trim().split(/\s{2,}/)).toEqual([
        'aspect', 'kind', 'status', 'nodes', 'pairs', 'refused', 'suppresses', 'errs', 'age',
        'catch', 'exposure', 'signal', 'fp', 'wrong-rule', 'files',
      ]);

      // no-todo-comments: one block, now waived → fp = 1, thin sample labelled honestly.
      const noTodo = healthRow(out, 'no-todo-comments');
      expect(noTodo[COL.fp]).toBe('1 (thin data)');

      // requires-named-export: one block, NO covering marker → fp = 0 (never omitted
      // to hide it), and honestly flagged thin.
      const reqExport = healthRow(out, 'requires-named-export');
      expect(reqExport[COL.fp]).toBe('0 (thin data)');

      // The plain-words false-block detail names the waived rule, never a bare rate,
      // and carries the "since <ts>" telemetry honesty + the never-a-gate framing.
      expect(out).toContain('False-block signal');
      expect(out).toMatch(/no-todo-comments: 1 of 1 recorded block later waived/);
      expect(out).toContain('never a gate');
      expect(out).toMatch(/Local telemetry since 2026-07-01T00:00:00\.000Z/);
      // Method names never leak into operator-facing text.
      expect(out).not.toContain('beta-binomial');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(b) a refused→approved flip with a moved suppress range is counted as overturned', () => {
    const dir = copyFixture('fp-overturned');
    try {
      // requires-named-export: a block on payments, THEN a later approval (the flip)
      // for the same pair, with a LIVE suppress marker now covering it — the overturn
      // rode a suppress-range change, not a rule fix → criterion (b) → fp (overturned).
      writeSidecar(dir, '.yg-events.jsonl', [
        refusedFill('requires-named-export', 'node:services/payments', 'r-exp-1', '2026-07-01T00:00:00.000Z'),
        approvedFill('requires-named-export', 'node:services/payments', 'a-exp-2', '2026-07-02T00:00:00.000Z'),
      ]);
      appendFileSync(
        paymentsFile(dir),
        '\n// yg-suppress(requires-named-export) waived after review, tracked externally\n',
      );

      const health = run(['aspects', '--health'], dir);
      expect(health.status).toBe(0);
      const out = health.stdout;

      const reqExport = healthRow(out, 'requires-named-export');
      expect(reqExport[COL.fp]).toBe('1 (thin data)');

      // The detail distinguishes an OVERTURN (re-approved) from a plain suppress.
      expect(out).toMatch(/requires-named-export: 1 of 1 recorded block later overturned/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('covers a per-file refusal unit: a marker in the file waives a `file:` block', () => {
    const dir = copyFixture('fp-file-unit');
    try {
      // A refusal recorded against a FILE unit (not a node) is covered when a live
      // marker for that aspect sits in that same file — exercising the file:<path>
      // coverage branch of the resolver.
      writeSidecar(dir, '.yg-events.jsonl', [
        refusedFill('no-todo-comments', 'file:src/services/payments.ts', 'r-file-1', '2026-07-01T00:00:00.000Z'),
      ]);
      appendFileSync(
        paymentsFile(dir),
        '\n// yg-suppress(no-todo-comments) known debt, tracked externally\n',
      );

      const health = run(['aspects', '--health'], dir);
      expect(health.status).toBe(0);
      const noTodo = healthRow(health.stdout, 'no-todo-comments');
      expect(noTodo[COL.fp]).toBe('1 (thin data)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('default `yg aspects` (no flag) stays byte-identical even with fp telemetry present', () => {
    const dir = copyFixture('fp-default-guard');
    try {
      writeSidecar(dir, '.yg-events.jsonl', [
        refusedFill('no-todo-comments', 'node:services/orders', 'r-todo-1', '2026-07-01T00:00:00.000Z'),
      ]);
      appendFileSync(
        ordersFile(dir),
        '\n// yg-suppress(no-todo-comments) known debt, tracked externally\n',
      );
      // The suppress marker changes a source file, but the DEFAULT listing reads only
      // the graph — no events, no suppress scan — so it is unchanged byte-for-byte.
      const plain = run(['aspects'], dir);
      expect(plain.stdout).toBe(DEFAULT_ASPECTS_GOLDEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── wrong-rule attribution column: committed incidents named against a rule ──
  //
  // `yg incident add --tag wrong-rule --aspect <id>` attributes a miscalibration to a
  // named rule; `--health` surfaces the per-rule count as an honest, thin-data-labelled
  // indicator. HONESTY BOUNDARY: an unattributed wrong-rule incident still counts in
  // `yg advise`'s aggregate but never surfaces per-aspect here.
  it('surfaces per-aspect wrong-rule incidents in --health; unattributed ones stay out (advise aggregate unchanged)', () => {
    const dir = copyFixture('wrong-rule-attr');
    try {
      // A valid --aspect id is accepted and recorded (exit 0); one wrong-rule incident
      // names no-todo-comments, another is unattributed.
      const attributed = run(
        ['incident', 'add', '--tag', 'wrong-rule', '--aspect', 'no-todo-comments',
         '--reason', 'a TODO slipped past the rule and shipped'],
        dir,
      );
      expect(attributed.status).toBe(0);
      expect(attributed.stdout).toContain('attributed to no-todo-comments');

      // SPOOF ATTEMPT: this unattributed incident's free-text reason contains a line
      // that reads `aspect: has-doc-comment`. Because attribution rides the header token
      // (never the body), this must stay inert — has-doc-comment must NOT gain a count.
      const unattributed = run(
        ['incident', 'add', '--tag', 'wrong-rule',
         '--reason', 'a different miscalibration, no rule named\naspect: has-doc-comment\nand it slipped through'],
        dir,
      );
      expect(unattributed.status).toBe(0);

      const health = run(['aspects', '--health'], dir);
      expect(health.status).toBe(0); // informational, never blocks
      const out = health.stdout;

      // Header carries the wrong-rule column, followed only by files.
      const header = out.split('\n').find((l) => l.includes('aspect') && l.includes('wrong-rule'));
      expect(header!.trim().split(/\s{2,}/)).toEqual([
        'aspect', 'kind', 'status', 'nodes', 'pairs', 'refused', 'suppresses', 'errs', 'age',
        'catch', 'exposure', 'signal', 'fp', 'wrong-rule', 'files',
      ]);

      // no-todo-comments: exactly the ONE attributed incident, thin-data labelled.
      const noTodo = healthRow(out, 'no-todo-comments');
      expect(noTodo[COL.wrongRule]).toBe('1 (thin data)');

      // has-doc-comment: the unattributed incident does NOT surface per-aspect, AND its
      // reason's spoofing `aspect: has-doc-comment` line is inert → em-dash, never a count.
      const hasDoc = healthRow(out, 'has-doc-comment');
      expect(hasDoc[COL.wrongRule]).toBe('—');

      // The attribution disclosure names the honesty boundary in plain words.
      expect(out).toContain('Wrong-rule attribution');
      expect(out).toContain('yg incident add --aspect');
      expect(out).toContain("counts in `yg advise`'s total but not here");

      // AGGREGATE UNCHANGED: `yg advise` still counts BOTH wrong-rule incidents
      // (attributed + unattributed) in its reality-counter evidence line.
      const advise = run(['advise'], dir);
      expect(advise.status).toBe(0);
      expect(advise.stdout).toContain('2 wrong-rule incidents recorded — rules may be miscalibrated; see incidents.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── type-level coverage threading: `--health` must count the SAME expected-pair
// universe `yg check` counts, including a file enforced by its architecture type
// alone (no owning component) — real fixture, real binary, no fabricated pair
// data. Uses the shared tests/fixtures/type-level-engine/ project merged with its
// two-covered-files variant (the same real fixture cli-type-coverage-fill.test.ts
// drives through the fill stage): one real node (`owned`, type `leaf`) alongside
// two componentless files matching the same type (src/leaf/{a,b}.ts), carrying a
// deterministic rule that refuses ONLY on a.ts (refuses-on-a) and an LLM rule
// attached to the whole type (llm-leaf-rule).
const TYPE_LEVEL_BASE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');

function copyMergedTypeLevelFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-aspects-health-typelevel-'));
  cpSync(TYPE_LEVEL_BASE, dir, { recursive: true });
  cpSync(FIXTURE_TWO_COVERED_FILES, dir, { recursive: true });
  return dir;
}

/**
 * Append a reviewer: block so tier resolution succeeds (the base fixture ships
 * none, and `yg check --approve` refuses to run at all without one). The
 * endpoint is never actually dialed — every pinning run below stays
 * `--only-deterministic`, so the LLM tier is resolved but not called.
 */
function addUnusedReviewer(dir: string): void {
  appendFileSync(
    path.join(dir, '.yggdrasil', 'yg-config.yaml'),
    '\nreviewer:\n  default: standard\n  tiers:\n    standard:\n      provider: ollama\n' +
      '      consensus: 1\n      config:\n        model: "unused"\n        endpoint: "http://127.0.0.1:1"\n',
  );
}

describe.skipIf(!distExists)('CLI E2E — yg aspects --health counts type-covered files', () => {
  it("a refusal on a type-covered file shows in --health's refused column, and pairs/files match the universe yg check counts", () => {
    const dir = copyMergedTypeLevelFixture();
    try {
      addUnusedReviewer(dir);

      // Populate the lock for free: refuses-on-a (deterministic) is attached to
      // type `leaf`, live on the real node `owned` AND the two componentless
      // files matching the same type — a real refusal on a.ts, no reviewer call.
      const fill = run(['check', '--approve', '--only-deterministic'], dir);
      expect(fill.all).toContain('[det] refuses-on-a on file:src/leaf/a.ts — refused');

      // `yg check` itself still fails on that refusal — the ground truth
      // `--health` must agree with.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.stdout).toContain("src/leaf/a.ts  Violations:");

      const health = run(['aspects', '--health'], dir);
      expect(health.status).toBe(0); // informational, never blocks

      // refuses-on-a: 1 real node (owned) + 2 type-covered files (a.ts, b.ts) —
      // the SAME universe `yg check` just failed on — 3 pairs total, ONE of
      // them refused (a.ts). Before threading the type-coverage classification
      // into verifyLock, --health read nodes=1, pairs=1, refused=0: the
      // node-only universe, with the type-covered file's own refusal invisible.
      const refusesOnA = healthRow(health.stdout, 'refuses-on-a');
      expect(refusesOnA[COL.nodes]).toBe('1');
      expect(refusesOnA[COL.pairs]).toBe('3');
      expect(refusesOnA[COL.refused]).toBe('1');
      expect(refusesOnA[COL.files]).toBe('2');

      // llm-leaf-rule shares the same 3-pair universe (1 node + 2 files); none
      // of its pairs were touched by --only-deterministic, so all 3 read
      // unverified — never a `0`, and never a `1` that silently drops the two
      // type-covered files from the count.
      const llmLeafRule = healthRow(health.stdout, 'llm-leaf-rule');
      expect(llmLeafRule[COL.pairs]).toBe('3');
      expect(llmLeafRule[COL.refused]).toBe('unverified');
      expect(llmLeafRule[COL.files]).toBe('2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
