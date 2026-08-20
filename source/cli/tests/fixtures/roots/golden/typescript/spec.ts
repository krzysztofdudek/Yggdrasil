import type { GoldenRepoSpec } from '../../../../support/roots-golden.js';

// =============================================================================
// tests/fixtures/roots/golden/typescript/spec.ts — the TypeScript golden's
// builder spec (Task 7, plan §"Task 7: Goldens for the six measured grammars
// + data + controls"). Committed alongside its `typescript.bundle` sibling;
// `tests/unit/roots/golden.test.ts` asserts the two never drift apart
// (`assertGoldenBundleEquivalence`).
//
// SHAPE, chosen so every downstream assertion this golden carries is
// hand-derivable rather than merely observed:
//   - `PACKAGE_COUNT` (100) directories `src/mod<i>/`, each holding ONE file
//     `file<i>.ts` with exactly one class (`type` kind — its body contains a
//     further scope, the method below it) and two methods (`method` kind).
//     Raw scope count = 100 * (1 type + 2 method + 1 file) = 400, well past
//     spec §6.8's 300-scope partition floor with real margin (33%) — Task 7
//     Step 1's own sizing arithmetic, not a boundary landing.
//   - No `import` statements anywhere — `auto.imp:*` never enters ANY
//     scope's domain (E8's domain is "files with >= 1 import"), which is
//     what keeps the hand-counted `candidateCountLog2` pin
//     (`tests/unit/roots/golden.test.ts`) tractable: one whole
//     enumerator eliminated by construction, not by a config knob.
//   - No `extends`/`implements` clause anywhere — §6.2's heritage rule never
//     finds a heritage-shaped child, so `grammarHasHeritageCandidacy` is
//     `false` for every scope and `auto.extends:*` never enters ANY scope's
//     domain either (independent of vocabulary support — see `binding.ts`'s
//     own doc for why this is a per-scope structural fact, not a token
//     count).
//   - EVERY class is named `Handler<i>` and EVERY method is named
//     `exec<i>_0` / `exec<i>_1` — the literal digits differ per instance,
//     but `enumerate.ts`'s name-shape char-class folding (E1) collapses
//     digits into the same run as adjacent letters, so `auto.nameshape`
//     converges to ONE value per kind across all 100/200 instances
//     (proven, not merely hoped: `tests/unit/roots/golden.test.ts`
//     asserts BOTH kinds' facts exist — the alphabets-union regression
//     guard Task 4-6's review demanded).
//   - `exec<i>_0()` takes 0 parameters and returns a literal (numeric for
//     95 of them, string for the 5 deviants below); `exec<i>_1(x)` takes 1
//     parameter and its body is a bare `if` with NO return statement — a
//     DELIBERATE 50/50 split on `auto.arity` ONLY, rejected at spec §9.4a
//     acceptance (a near-coin-flip data_term, per Appendix E.3 S2/S5,
//     never even reaching a fire-ability gate) — the golden's own
//     MUST-NOT-mine control, not an oversight. `auto.ret` is NOT part of
//     that split: E5's domain is "methods with >= 1 return", i.e. the 100
//     `exec<i>_0` scopes only, where the numeric return is 95% uniform —
//     a MUST-mine fact (`tests/unit/roots/golden.test.ts` pins
//     `expected: "number"`, `deviantsN: 5`).
//   - `exec<i>_0` calls `console.log` and returns a literal; `exec<i>_1`
//     calls nothing and contains only an `if` statement — a DELIBERATE
//     content split (not merely the arity/ret split above) that keeps
//     `auto.nameshape` (identical for both variants — the char-class fold
//     does not see a method's BODY, only its name) from landing in the
//     SAME §9.4e dedup cluster as every body-shaped surface (`auto.call:`,
//     `auto.has:`, `auto.first1`, `auto.ret`, `auto.stshape:` — each of
//     which necessarily splits 100/100 or narrows its own domain once the
//     two variants' bodies diverge). Without this split, EVERY boolean/
//     categorical method-level surface shares the identical 200-member
//     conform set (100% uniform bodies), and spec §9.4e's own "one latent
//     fact, one message" dedup collapses them all into ONE lead FACT —
//     measured directly against this golden's first draft, where
//     `auto.nameshape` at `method` kind lost that competition to
//     `auto.call:console.log` and never appeared in `.facts` at all,
//     silently failing the alphabets-union regression guard. The content
//     split is what keeps `auto.nameshape`'s conform set (all 200 — a
//     property of the NAME, unaffected by which of the two bodies a scope
//     has) from ever exactly matching any body-derived surface's own
//     (at-most-100-member) conform set, so it survives dedup as its own
//     lead.
//   - ONE extra file, `src/mod0/decoy.test.ts`, named to match spec
//     §6.8's `*.test.*` mining exclusion — real, parseable TypeScript (a
//     function that itself calls `console.log` and returns, exactly the
//     shape every other method in this golden takes) so the "forParsing
//     drops it" control has something genuine to prove a negative about:
//     `tests/unit/roots/golden.test.ts`'s live round-trip
//     compares `extractUnits` called DIRECTLY on this file's own content
//     (scopes: real) against the same content reached through
//     `parseAndExtractAll` (scopes: none) — the review-demanded contrast
//     that keeps the negative from being a false green.
// =============================================================================

const PACKAGE_COUNT = 100;
/** Every 20th package (5 of 100: i = 0, 20, 40, 60, 80) returns a string literal instead of a numeric one — a deliberate MINORITY deviation inside the otherwise-100%-uniform `auto.ret` convention (`_all:method` domain = 100, the exec<i>_0-only population — see the class comment above), giving `tests/unit/roots/golden.test.ts` a real, non-zero `deviantsN` to assert against (review-inherited requirement (d): `deviantsN` is the RAW non-conforming count, Appendix D's own worked record). */
function isDeviant(i: number): boolean {
  return i % 20 === 0;
}

function classFile(i: number): string {
  return [
    `export class Handler${i} {`,
    `  exec${i}_0() {`,
    `    console.log("x");`,
    isDeviant(i) ? '    return "y";' : '    return 1;',
    `  }`,
    `  exec${i}_1(x) {`,
    `    if (x) {`,
    `    }`,
    `  }`,
    `}`,
    '',
  ].join('\n');
}

const DECOY_TEST_FILE = ['export function shouldNeverMine() {', '  console.log("x");', '  return 1;', '}', ''].join('\n');

export function buildTypeScriptGoldenSpec(): GoldenRepoSpec {
  const files: Record<string, string> = {};
  for (let i = 0; i < PACKAGE_COUNT; i++) {
    files[`src/mod${i}/file${i}.ts`] = classFile(i);
  }
  files['src/mod0/decoy.test.ts'] = DECOY_TEST_FILE;

  return {
    name: 'typescript',
    commits: [
      { author: 'roots-golden', files, message: 'seed: 100 uniform handler modules + one test-pattern decoy' },
      // D8's time-depth anchor — see tests/fixtures/roots/golden/data/spec.ts's own comment for why.
      { author: 'roots-golden', dayOffset: 400, files: { 'NOTES.md': 'Time-depth anchor commit — no registered grammar, no scopes, no partition marker.\n' }, message: 'chore: trailing note (time-depth anchor)' },
    ],
  };
}
