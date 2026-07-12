import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
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
//   aspect | kind | status | nodes | pairs | refused | suppresses | errs | age | catch | exposure | signal
const COL = {
  aspect: 0, kind: 1, status: 2, nodes: 3, pairs: 4, refused: 5, suppresses: 6, errs: 7, age: 8,
  catch: 9, exposure: 10, signal: 11,
};

/** Append well-formed synthetic telemetry lines to a gitignored sidecar under `.yggdrasil/`. */
function writeSidecar(dir: string, filename: string, lines: object[]): void {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(path.join(dir, '.yggdrasil', filename), body, 'utf-8');
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
        'catch', 'exposure', 'signal',
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
          'catch', 'exposure', 'signal',
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
});
