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
// So the drill corpus is replaced here by four REAL, committed on-disk fixture
// projects under tests/fixtures/ — runcheck-parity, runcheck-parity-drift,
// runcheck-parity-unrecognized and runcheck-parity-return-shapes — each a
// self-contained graph plus source, driven through the REAL built binary against
// the REAL check.mjs. Nothing about the rule is copied or restated: the aspect
// directory is materialized into each run's temp project straight from
// `.yggdrasil/aspects/`, so a fixture can never drift from the rule it pins.
//
// What each fixture proves:
//   runcheck-parity       — every call shape the rule must judge, in ONE node:
//                           five that PROVABLY omit an issue-affecting option
//                           (must be refused — three omitting a gating option,
//                           including the two that a comment-blind matcher
//                           skipped in silence; one omitting the whole-list
//                           rewrite; one omitting the member declared ahead of
//                           its consumer) and four that cannot be proven to omit
//                           one (must stay silent, per `errs: under`). Its seam
//                           also carries a same-file helper with its own gating
//                           ternary AND its own whole-list rewrite, so a
//                           derivation walking the whole file instead of
//                           runCheck's body would refuse every compliant one;
//                           and a byproduct assembled in the exact rewrite shape,
//                           which must not derive because it is not the list
//                           runCheck returns — the false positive `errs: under`
//                           forbids.
//   runcheck-parity-drift — a seam whose call site passes every option the rule
//                           asks for, so ONLY its classification half can refuse
//                           it: an issue-gating input written in a shape the
//                           derivation does not match, plus a STALE entry on each
//                           hand-signed list — the side-effect allowlist naming a
//                           member this seam dropped, and the demanding map
//                           naming one it never declared.
//   runcheck-parity-      — one near miss per REJECTING requirement of the
//   unrecognized            rewrite matcher, each differing from the recognized
//                           shape in exactly ONE respect, so deleting the
//                           requirement it targets — and only that one — makes it
//                           derive. Three read the member the demanding map
//                           lists, whose entry must then go UNPROVEN rather than
//                           be trusted; the fourth is conditioned on a local, the
//                           shape that would have the rule invent a key outright.
//                           Four of the matcher's five requirements are pinned
//                           this way; the fifth (a bare-identifier alternative)
//                           is subsumed by the first-argument comparison and
//                           cannot change a verdict alone, so nothing pins it.
//   runcheck-parity-      — two rewrites that reach the returned issue set
//   return-shapes           WITHOUT being bound to a name: one as the `issues`
//                           property of a returned object literal, one as the
//                           returned expression itself. Both are shapes the rule
//                           documents as recognized and both were unreachable
//                           while it gave up whenever no return named an
//                           identifier — which is what a body written this way
//                           produces.
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
  it('refuses exactly the five call sites that provably omit an issue-affecting option', () => {
    withFixture('runcheck-parity', (out) => {
      expect(out).toContain('refused');
      expect(out).toContain('5 violations');

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

      // The whole-list rewrite is demanded exactly as a gate is: this caller
      // passes both gating options and omits only the rewrite. Its alternative
      // is the untransformed list, never `[]`, so the gating matcher can never
      // derive it — with the rewrite matcher absent, this call site is silent.
      expect(out).toContain('src/callers/transform-omitted.ts');
      expect(out).toContain('missing issue-affecting option(s): scopeFilter');

      // A member the seam declares but does not yet read: no derivation can see
      // it, so the rule's hand-signed ISSUE_TRANSFORM map is the only thing
      // demanding it — and it must demand it at every call site, or the surface
      // that skipped it starts reporting differently the day the consumer lands.
      expect(out).toContain('src/callers/declared-omitted.ts');
      expect(out).toContain('missing issue-affecting option(s): changeScope');

      // Every violation names the omitted option, and only the omitted one.
      expect(out).toContain('missing issue-affecting option(s): rulesArtifacts');
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

  it('derives no phantom key from a gating ternary or a rewrite outside runCheck\'s own body', () => {
    withFixture('runcheck-parity', (out) => {
      // The fixture's seam file carries a same-file helper with its own
      // `options?.phantomKey ? … : []` AND its own whole-list rewrite on
      // `phantomScope`. A derivation walking the whole file would demand both at
      // every call site and refuse all four compliant ones with a fix that would
      // not even typecheck.
      expect(out).not.toContain('phantomKey');
      expect(out).not.toContain('phantomScope');
    });
  });

  it('does not derive a byproduct assembled in the exact rewrite shape', () => {
    withFixture('runcheck-parity', (out) => {
      // The seam's near miss satisfies every requirement of the rewrite matcher
      // but one: the list it rewrites is a byproduct, not what runCheck returns
      // as its issues. Without that requirement the rule would derive
      // `precomputedVerification`, demand it at every compliant caller, and
      // contradict its own side-effect classification of it — a provable false
      // positive on code that alters no issue, which `errs: under` forbids.
      expect(out).not.toContain('precomputedVerification');
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
      expect(out).not.toContain('missing issue-affecting option');
    });
  });

  it('refuses a stale ISSUE_TRANSFORM entry naming a member the seam never declared', () => {
    withFixture('runcheck-parity-drift', (out) => {
      // The DEMANDING map gets the same stale sweep the exempting one gets. Left
      // unswept, this entry would have every call site judged against a key the
      // options interface cannot accept, and would silently pre-classify any
      // future member that happened to take that name.
      expect(out).toContain('stale classification');
      expect(out).toContain("ISSUE_TRANSFORM lists 'changeScope'");
      expect(out).toContain('declares no such optional member');
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

describe.skipIf(!distExists)(`${ASPECT_ID} — hand-signed entry outlives its window (fixture: runcheck-parity-unrecognized)`, () => {
  it('refuses an ISSUE_TRANSFORM entry once the seam reads the member in a shape no derivation matches', () => {
    withFixture('runcheck-parity-unrecognized', (out) => {
      expect(out).toContain('refused');
      // The single safety property the hand-signed entry rests on: it claims the
      // member is issue-affecting and this body cannot act on it YET. The moment
      // the body reads it, the shape it is read in — not the entry — decides
      // whether call sites are being asked for enough, so an unrecognized shape
      // must be loud rather than quietly trusted.
      expect(out).toContain('unproven classification');
      expect(out).toContain("ISSUE_TRANSFORM lists 'changeScope'");
      expect(out).toContain("already reads 'options.changeScope'");
      // …and it says what to do about it, in the same three-part shape.
      expect(out).toContain('WHY:');
      expect(out).toContain('NEXT:');
    });
  });

  it('demands nothing at the call site while that entry stands unproven', () => {
    withFixture('runcheck-parity-unrecognized', (out) => {
      // The other half of each near miss's proof. The seam's four reads each
      // differ from the recognized rewrite in exactly ONE respect — conditioned
      // on a local rather than on the injected options, the transform rewrites a
      // different list than the one opposite it, the option is never handed to
      // the transform, or the rewritten list is a byproduct rather than the
      // returned one. While none of them derives, nothing is demanded and this
      // caller is silent. Delete the requirement any one of them targets and that
      // read derives: for the three on the hand-signed member the unproven
      // refusal above disappears too; for the local-conditioned one the rule
      // invents a key outright. Either way this assertion fails with the
      // omission.
      //
      // FOUR of the matcher's five requirements are pinned this way (the options
      // object, the first-argument comparison, the option being fed in, and the
      // returned-list test — the last also by the parity fixture's byproduct).
      // The fifth, that the alternative be a bare identifier, is subsumed by the
      // first-argument comparison and provably cannot change a verdict alone, so
      // it is NOT pinned here and no case pretends to; the rule's docblock
      // carries that argument.
      expect(out).not.toContain('missing issue-affecting option');
    });
  });
});

describe.skipIf(!distExists)(`${ASPECT_ID} — rewrites that reach the return unbound (fixture: runcheck-parity-return-shapes)`, () => {
  it('derives a rewrite written as the issues property of a returned object literal, and one written as the returned expression', () => {
    withFixture('runcheck-parity-return-shapes', (out) => {
      expect(out).toContain('refused');
      // Neither rewrite is bound to anything, so this seam names no returned
      // identifier at all — the case the rule's identifier collector used to give
      // up on, leaving both of these documented shapes unreachable and their
      // authors advised to write the code already in front of them.
      expect(out).toContain('src/callers/omits-return-shapes.ts');
      expect(out).toContain('missing issue-affecting option(s): scopeInProperty, scopeInReturn');
    });
  });

  it('stays silent on the call site that passes both', () => {
    withFixture('runcheck-parity-return-shapes', (out) => {
      expect(out).not.toContain('src/callers/complete.ts');
    });
  });
});
