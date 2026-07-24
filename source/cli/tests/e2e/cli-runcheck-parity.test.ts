import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// E2E suite — the permanent, falsifiable regression fixture for this repo's own
// `runcheck-injected-input-parity` aspect.
//
// The rule cannot be drilled: it derives its rule by reading ANOTHER node's file
// through ctx.graph, and any graph read throws under the single-file drill
// sandbox before the check's own logic ever runs. That exemption is legitimate
// in kind, but an undrillable rule with no negative-direction fixture is a rule
// nobody can prove still refuses anything — and this one shipped with a
// silent-skip hole (an inline comment among a call's arguments disabled it at
// that call site) that one negative fixture would have caught on the first run.
//
// So the drill corpus is replaced here by two REAL, committed on-disk fixture
// projects — tests/fixtures/runcheck-parity and .../runcheck-parity-drift —
// each a self-contained graph plus source, driven through the REAL built binary
// against the REAL check.mjs. Nothing about the rule is copied or restated: the
// aspect directory is materialized into each run's temp project straight from
// `.yggdrasil/aspects/`, so the fixture can never drift from the rule it pins.
//
// What each fixture proves:
//   runcheck-parity       — every call shape the rule must judge, in ONE node:
//                           three that PROVABLY omit an issue-gating option
//                           (must be refused, including the two that a
//                           comment-blind matcher skipped in silence) and four
//                           that cannot be proven to omit one (must stay silent,
//                           per `errs: under`). Its seam also carries a
//                           same-file helper with its own gating ternary, so a
//                           derivation walking the whole file instead of
//                           runCheck's body would refuse all four compliant ones.
//   runcheck-parity-drift — a seam whose call site passes every DERIVED option,
//                           so ONLY the rule's classification half can refuse
//                           it: a new issue-gating input written in a shape the
//                           derivation does not match, and a stale entry in the
//                           rule's side-effect allowlist.
//
// Hermetic: each test copies the committed fixture into a fresh mkdtemp tree and
// removes it in `finally`; zero committed bytes change. No network, no clock, no
// reviewer — the aspect is deterministic, so every outcome is computed locally.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const REPO_ROOT = path.join(CLI_ROOT, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const ASPECT_ID = 'runcheck-injected-input-parity';
const ASPECT_SRC = path.join(REPO_ROOT, '.yggdrasil', 'aspects', ASPECT_ID);

const distExists = existsSync(BIN_PATH);

/**
 * Materialize a run: the committed fixture project plus the REAL aspect
 * directory copied in from this repo's own graph (single source of truth — the
 * fixture holds no copy of the rule).
 */
function materialize(fixture: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-runcheck-parity-${fixture}-`));
  cpSync(path.join(CLI_ROOT, 'tests', 'fixtures', fixture), dir, { recursive: true });
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', ASPECT_ID);
  mkdirSync(aspectDir, { recursive: true });
  cpSync(ASPECT_SRC, aspectDir, { recursive: true });
  return dir;
}

function runAspectTest(projectRoot: string, nodePath: string): string {
  const result = spawnSync(
    'node',
    [BIN_PATH, 'aspect-test', '--aspect', ASPECT_ID, '--node', nodePath],
    { cwd: projectRoot, encoding: 'utf-8' },
  );
  return (result.stdout ?? '') + (result.stderr ?? '');
}

/** Run one fixture through the real binary and hand the output to `assert`. */
function withFixture(fixture: string, assert: (out: string) => void): void {
  const dir = materialize(fixture);
  try {
    assert(runAspectTest(dir, 'cli/callers'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!distExists)(`${ASPECT_ID} — call-site parity (fixture: runcheck-parity)`, () => {
  it('refuses exactly the three call sites that provably omit an issue-gating option', () => {
    withFixture('runcheck-parity', (out) => {
      expect(out).toContain('refused');
      expect(out).toContain('3 violations');

      // A caller that supplies the injected clock but not the injected
      // artifacts snapshot — the defect the rule exists to catch, and the proof
      // it still refuses anything at all.
      expect(out).toContain('src/callers/deficient.ts');

      // The same omission with a block comment between the arguments. Before the
      // comment filter, tree-sitter's named-child indexing resolved the options
      // argument to the SECOND argument, found a non-object, and skipped the
      // call in silence — a comment could switch the rule off at a call site.
      expect(out).toContain('src/callers/comment-evasion.ts');

      // No options argument at all, hidden behind a trailing comment that padded
      // the argument list to three named children, so the "no options argument"
      // branch was never reached.
      expect(out).toContain('src/callers/no-options.ts');
      expect(out).toContain('passes no options argument');

      // Every violation names the omitted option, and only the omitted one.
      expect(out).toContain('missing issue-gating option(s): rulesArtifacts');
    });
  });

  it('stays silent on every compliant and unprovable call shape (errs: under)', () => {
    withFixture('runcheck-parity', (out) => {
      // Plain properties — the baseline compliant shape.
      expect(out).not.toContain('src/callers/complete.ts');
      // Method shorthand: type-correct against `nowUtc?: () => Date`, and read
      // as a passed key only once method_definition names are honoured.
      expect(out).not.toContain('src/callers/method-shorthand.ts');
      // Computed key: unprovable, so the whole literal must bail like a spread
      // rather than treat the key as absent.
      expect(out).not.toContain('src/callers/computed-key.ts');
      // A variable options argument, and a spread inside the object literal.
      expect(out).not.toContain('src/callers/unprovable.ts');
    });
  });

  it('derives no phantom key from a gating ternary outside runCheck\'s own body', () => {
    withFixture('runcheck-parity', (out) => {
      // The fixture's seam file carries a same-file helper with its own
      // `options?.phantomKey ? … : []`. A derivation walking the whole file
      // would demand phantomKey at every call site and refuse all four
      // compliant ones with a fix that would not even typecheck.
      expect(out).not.toContain('phantomKey');
    });
  });
});

describe.skipIf(!distExists)(`${ASPECT_ID} — member classification (fixture: runcheck-parity-drift)`, () => {
  it('refuses an optional member that is neither derived-as-gating nor allowlisted', () => {
    withFixture('runcheck-parity-drift', (out) => {
      expect(out).toContain('refused');
      // strictMode gates issues, but via `if (options?.strictMode)` — a shape
      // the derivation does not match. Under a parity-only rule it is simply
      // never asked for and the rule silently under-enforces; here it is loud.
      expect(out).toContain("'strictMode'");
      expect(out).toContain('UNCLASSIFIED');
      expect(out).toContain('SIDE_EFFECT_ONLY');

      // The call site itself passes every DERIVED option, so a parity-only rule
      // would have found nothing at all to say about this fixture.
      expect(out).not.toContain('missing issue-gating option');
    });
  });

  it('refuses a stale side-effect allowlist entry naming a member that no longer exists', () => {
    withFixture('runcheck-parity-drift', (out) => {
      expect(out).toContain('stale classification');
      expect(out).toContain("SIDE_EFFECT_ONLY lists 'now'");
    });
  });

  it('anchors every rule-level refusal at the refused node\'s OWN call site', () => {
    withFixture('runcheck-parity-drift', (out) => {
      // The node owns exactly one file, and every violation is reported against
      // it — never against the seam file (src/core/check.ts), which belongs to
      // another node and cannot be held responsible for this node's refusal.
      const fileHeaders = out.split('\n').filter((l) => /^\S.*\.ts$/.test(l));
      expect(fileHeaders).toEqual(['src/callers/complete.ts']);
      // …and each carries the full what / why / next structure.
      expect(out).toContain('WHY:');
      expect(out).toContain('NEXT:');
    });
  });
});
