import type { GoldenCommit, GoldenRepoSpec } from '../../../../support/roots-golden.js';

// =============================================================================
// tests/fixtures/roots/golden/history/spec.ts — the R4 history golden's
// builder spec. Committed alongside its `history.bundle` sibling;
// tests/unit/roots/roots-golden-history.test.ts asserts the two never drift
// apart (`assertGoldenBundleEquivalence`).
//
// 25 commits at 25 STRICTLY ASCENDING day offsets — 0, 20, 30, 60, 65, 90,
// 120, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 300, 320, 340,
// 360, 380, 395, 400 — enforced by `buildGoldenRepo`'s own monotonicity
// guard, so every quantity this comment states is derivable by hand from
// the offsets on this page alone; no mechanism here depends on that
// ascent, only the reader does.
//
// Every scope count below counts the mandatory `file` scope every parsed
// file carries in addition to its named-body scopes (unconditionally,
// after the named-body walk) — an empty-but-parseable file therefore
// contributes exactly 1 scope, never 0, and a path with no registered
// grammar (or excluded from parsing) contributes none at all.
//
// The "ordinary" file shape used throughout (`ordinaryFile`) is a class
// with exactly 3 methods: 1 `type`-kind scope (the class — its body holds
// further scope nodes) + 3 `method`-kind scopes (leaves) + 1 mandatory
// `file` scope = 5 scopes per file, uniformly.
//
// ---------------------------------------------------------------------
// day 0 — the bulk seed (author `alice`). 93 files listed, partitioned:
//   - 88 "ordinary" files (5 scopes each = 440 scopes), split into eight
//     NON-OVERLAPPING cohorts so every later commit's stated exclusions
//     hold by construction rather than by care:
//       * src/svc/order.ts (1)               — touched by the 9 pair
//         commits starting day 160 (co-change population, item 9)
//       * src/decorated/existing0..9.ts (10)  — decorated (no body edit)
//         at day 20 (item 2)
//       * src/legacy/legacy0..5.ts (6)        — renamed at day 90 (item 6)
//       * src/scratch/scratch0..2.ts (3)      — deleted at day 120 (item 7)
//       * src/mega/mega0..39.ts (40)          — mega-commit at day 150
//         (item 8; > megaCommitFileCap, contributes nothing to co-change)
//       * src/touch65/touch0..2.ts (3)        — modified at day 65 (item 5)
//       * src/fix/target.ts (1)               — `fix:` commit at day 200
//         (item 10)
//       * src/idle/idle0..23.ts (24)          — never touched again
//   - the test-pattern seed `test/order.spec.ts` (1 file, 0 scopes — fails
//     D17 gate 2 via `**/*.spec.*`; NOT one of the 88, listed beside it)
//   - the placeholder pair: `src/svc/placeholder.ts` (empty, registered
//     grammar, 1 scope — the mandatory file scope, no named-body scope)
//     and `docs/PLACEHOLDER.md` (empty, no registered grammar, 0 scopes) —
//     ONE shared blob sha (every empty file is git's well-known empty blob,
//     `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`) reaching two paths with
//     OPPOSITE extraction verdicts. `--raw`'s path-ordered listing puts
//     `docs/PLACEHOLDER.md` before `src/svc/placeholder.ts`.
//   - the stub pair: `src/stub/same.ts` and `src/stub/same.py`, byte-
//     identical one-line content (`x = 1\n`), a bare assignment in BOTH
//     grammars — ONE shared blob sha, but BOTH paths clear D17's gates
//     (both extracted, `.ts`/`.py` resolving to different registered
//     grammars), so the sha enters the blob roster once while the
//     per-grammar cache-key roster gains two entries (2 scopes: one
//     mandatory file scope per path).
//   Totals: 93 listed files; 92 scope-bearing files; 440 + 1 + 2 = 443
//   scopes in this one commit. 93 > megaCommitFileCap (30), so this whole
//   commit is excluded from co-change.
//
// day 20 — a change event AND a new cohort (author `alice`): the 10
//   "existing decorated" files gain a class-level decorator with NO body
//   edit (a value event the body-only signature would miss), and 10 BRAND
//   NEW decorated files (`src/deco-new/new0..9.ts`, one function each) are
//   added — 20 scopes with `first_seen` = day 20 (10 named-body + 10 file).
//   20 changed files (10 modified + 10 added) sits inside the 2..30
//   counted band: 190 pairs at support 1, none recurring except among the
//   new-10 (touched again at day 30 for support 2).
//
// day 30 — early-churn (author `alice`): rewrite (in-place body change,
//   same scope names/kinds) all 10 files born day 20. 30 - 20 = 10 <=
//   churnEarlyDays (14) => churned_early for those 20 scopes.
//
// day 60 — an agent commit (author `claude`, mapped to
//   `claude@golden.test`): 3 new files (`src/agent/agent0..2.ts`, 5 scopes
//   each = 15 total). Never touched again.
//
// day 65 — a human commit carrying a `Co-Authored-By: Cursor` trailer
//   (author `alice`, `authorKind` still classifies `agent` on the trailer
//   alone): modifies the 3 `touch65` seed files and nothing else.
//
// day 90 — a rename (author `alice`): `git mv src/legacy src/archive`,
//   moving the 6 legacy files with NO content change (lifecycle
//   continuity case).
//
// day 120 — a delete (author `alice`): removes the 3 `scratch` files.
//
// day 150 — a mega-commit (author `alice`): edits all 40 `mega` files in
//   place. 40 > megaCommitFileCap (30) => excluded from co-change.
//
// days 160, 170, 180, 190, 210, 220, 230, 240, 250 — NINE ordinary commits
//   (author `alice`), each touching EXACTLY the pair `src/svc/order.ts` +
//   `test/order.spec.ts` and nothing else. support(order.ts,
//   order.spec.ts) = 9 >= minSupport (8); no other counted commit touches
//   either file (the day-0 seed is excluded by the mega-commit cap), so
//   commits(order.ts) = 9 and confidence = 9/9 = 1.0 >= minConfidence
//   (0.75). This pair persists past the co-change filter.
//
// day 200 — a `fix:` commit (author `alice`): touches ONLY
//   `src/fix/target.ts`. One changed file, below the 2-file floor, so it
//   contributes no pair and moves no `commits(a)` denominator; sequenced
//   here purely to keep offsets ascending between the day-190 and day-210
//   pair commits.
//
// days 300, 320, 340, 360, 380 — FIVE ordinary commits (author `alice`,
//   never `claude`, never an agent trailer — the population T8's
//   agentShare criterion needs non-empty AND agent-free), each touching
//   the SECOND pair `src/svc/ship.ts` + `test/ship.spec.ts`. The pair is
//   CREATED by the day-300 commit (first_seen = day 300); support 5 <
//   minSupport (8), so this pair never clears the co-change floor — the
//   negative control proving the filter actually runs.
//
// day 395 — the fresh-code cohort (author `alice`, inside the 14-day fresh
//   window at the day-400 clock): ONE new file, `src/svc/refund.ts`,
//   carrying exactly 3 top-level functions (none nesting a further scope,
//   so all three are `method`-kind) — 3 named-body + 1 file = 4 scopes,
//   all in the `method`/`file` kinds respectively, never mixed in one
//   cell. One changed file, below the 2-file floor: no co-change pair, no
//   `commits(a)` movement.
//
// day 400 — the trailing `NOTES.md` commit (D8's clock anchor; author
//   `alice`), matching every other landed golden's own trailing commit.
//
// Live scope count at HEAD (day 400), after day-120's 3 deletions:
//   443 (day 0) - 15 (3 deleted scratch files x 5) = 428
//   + 20 (day 20 new-10)                            = 448
//   + 15 (day 60 agent-3)                           = 463
//   + 5  (day 300 ship.ts, ordinary shape)          = 468
//   + 4  (day 395 refund.ts)                        = 472
// 472 scopes clears spec section 6.8's 300-scope partition floor with
// ~57% margin (test/order.spec.ts and test/ship.spec.ts contribute 0;
// NOTES.md and docs/PLACEHOLDER.md carry no grammar).
// =============================================================================

/** A class with exactly 3 methods: 1 `type` scope + 3 `method` scopes + 1 mandatory `file` scope = 5 scopes, uniformly. `decorated` prepends a class-level decorator with NO body change (the "value event without a body edit" case); `rev` perturbs the three method bodies (an in-place content change that never renames a scope). */
function ordinaryFile(className: string, opts: { decorated?: boolean; rev?: number } = {}): string {
  const rev = opts.rev ?? 0;
  const lines = [
    ...(opts.decorated ? [`@Decorated()`] : []),
    `export class ${className} {`,
    `  first() {`,
    `    return ${1 + rev};`,
    `  }`,
    `  second() {`,
    `    return ${2 + rev};`,
    `  }`,
    `  third() {`,
    `    return ${3 + rev};`,
    `  }`,
    `}`,
    '',
  ];
  return lines.join('\n');
}

/** A single function: 1 `method` scope + 1 mandatory `file` scope = 2 scopes. `rev` perturbs the body (same name/kind, in-place body change). */
function newFeatureFile(name: string, opts: { decorated?: boolean; rev?: number } = {}): string {
  const rev = opts.rev ?? 0;
  const lines = [...(opts.decorated ? [`@Decorated()`] : []), `export function ${name}() {`, `  return ${100 + rev};`, `}`, ''];
  return lines.join('\n');
}

/** `refund.ts`'s exactly-3-top-level-functions shape (day 395's fresh cohort): no function nests a further scope, so all three are `method`-kind. */
function refundFileBody(): string {
  return [
    'export function calculateRefund(amount) {',
    '  return amount * 0.9;',
    '}',
    '',
    'export function isEligibleForRefund(orderId) {',
    '  return orderId.length > 0;',
    '}',
    '',
    'export function logRefund(orderId, amount) {',
    '  return `refund:${orderId}:${amount}`;',
    '}',
    '',
  ].join('\n');
}

/** A `.spec.ts` file's content — never parsed (D17 gate 2 excludes the spec-pattern glob from `forParsing`), so its content is arbitrary beyond being a genuine per-revision change. */
function specFileBody(target: string, rev: number): string {
  return [`// spec for ${target}, revision ${rev}`, `test('${target} behaves', () => {`, `  expect(true).toBe(true);`, `});`, ''].join('\n');
}

/** Every empty file in every git repository is this same blob sha — the placeholder pair's shared content. */
const EMPTY_FILE_CONTENT = '';
/** The stub pair's shared, byte-identical, one-line content — a bare assignment in both TypeScript and Python. */
const STUB_FILE_CONTENT = 'x = 1\n';

export function buildHistoryGoldenSpec(): GoldenRepoSpec {
  // -------------------------------------------------------------------
  // day 0 — the bulk seed.
  // -------------------------------------------------------------------
  const day0Files: Record<string, string> = {};

  day0Files['src/svc/order.ts'] = ordinaryFile('Order');
  day0Files['test/order.spec.ts'] = specFileBody('order', 0);

  for (let i = 0; i < 10; i++) day0Files[`src/decorated/existing${i}.ts`] = ordinaryFile(`Existing${i}`);
  for (let i = 0; i < 6; i++) day0Files[`src/legacy/legacy${i}.ts`] = ordinaryFile(`Legacy${i}`);
  for (let i = 0; i < 3; i++) day0Files[`src/scratch/scratch${i}.ts`] = ordinaryFile(`Scratch${i}`);
  for (let i = 0; i < 40; i++) day0Files[`src/mega/mega${i}.ts`] = ordinaryFile(`Mega${i}`);
  for (let i = 0; i < 3; i++) day0Files[`src/touch65/touch${i}.ts`] = ordinaryFile(`Touch${i}`);
  day0Files['src/fix/target.ts'] = ordinaryFile('FixTarget');
  for (let i = 0; i < 24; i++) day0Files[`src/idle/idle${i}.ts`] = ordinaryFile(`Idle${i}`);

  day0Files['docs/PLACEHOLDER.md'] = EMPTY_FILE_CONTENT;
  day0Files['src/svc/placeholder.ts'] = EMPTY_FILE_CONTENT;
  day0Files['src/stub/same.ts'] = STUB_FILE_CONTENT;
  day0Files['src/stub/same.py'] = STUB_FILE_CONTENT;

  // -------------------------------------------------------------------
  // day 20 — decorate 10 existing scopes (no body edit) + add 10 new ones.
  // -------------------------------------------------------------------
  const day20Files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) day20Files[`src/decorated/existing${i}.ts`] = ordinaryFile(`Existing${i}`, { decorated: true });
  for (let i = 0; i < 10; i++) day20Files[`src/deco-new/new${i}.ts`] = newFeatureFile(`newFeature${i}`, { decorated: true });

  // -------------------------------------------------------------------
  // day 30 — rewrite (early-churn) the 10 files born at day 20.
  // -------------------------------------------------------------------
  const day30Files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) day30Files[`src/deco-new/new${i}.ts`] = newFeatureFile(`newFeature${i}`, { decorated: true, rev: 1 });

  // -------------------------------------------------------------------
  // day 60 — 3 new agent-authored files.
  // -------------------------------------------------------------------
  const day60Files: Record<string, string> = {};
  for (let i = 0; i < 3; i++) day60Files[`src/agent/agent${i}.ts`] = ordinaryFile(`Agent${i}`);

  // -------------------------------------------------------------------
  // day 65 — modify the 3 touch65 seed files (human + Cursor trailer).
  // -------------------------------------------------------------------
  const day65Files: Record<string, string> = {};
  for (let i = 0; i < 3; i++) day65Files[`src/touch65/touch${i}.ts`] = ordinaryFile(`Touch${i}`, { rev: 5 });

  // -------------------------------------------------------------------
  // day 150 — mega-commit: edit all 40 mega files in place.
  // -------------------------------------------------------------------
  const day150Files: Record<string, string> = {};
  for (let i = 0; i < 40; i++) day150Files[`src/mega/mega${i}.ts`] = ordinaryFile(`Mega${i}`, { rev: 9 });

  // -------------------------------------------------------------------
  // days 160..250 — nine order-pair commits, interleaved with day 200's
  // fix commit, in strictly ascending day order.
  // -------------------------------------------------------------------
  const orderPairDays = [160, 170, 180, 190, 210, 220, 230, 240, 250];
  const orderPairCommits: GoldenCommit[] = orderPairDays.map((day, idx) => {
    const rev = idx + 1;
    return {
      author: 'alice',
      dayOffset: day,
      message: `chore: touch order pair (rev ${rev})`,
      files: {
        'src/svc/order.ts': ordinaryFile('Order', { rev }),
        'test/order.spec.ts': specFileBody('order', rev),
      },
    };
  });

  // -------------------------------------------------------------------
  // days 300..380 — the ship pair: created day 300, touched 320/340/360/380.
  // -------------------------------------------------------------------
  const shipPairCommits: GoldenCommit[] = [
    {
      author: 'alice',
      dayOffset: 300,
      message: 'feat: add ship pair',
      files: {
        'src/svc/ship.ts': ordinaryFile('Ship'),
        'test/ship.spec.ts': specFileBody('ship', 0),
      },
    },
    ...[320, 340, 360, 380].map((day, idx) => {
      const rev = idx + 1;
      const commit: GoldenCommit = {
        author: 'alice',
        dayOffset: day,
        message: `chore: touch ship pair (rev ${rev})`,
        files: {
          'src/svc/ship.ts': ordinaryFile('Ship', { rev }),
          'test/ship.spec.ts': specFileBody('ship', rev),
        },
      };
      return commit;
    }),
  ];

  const commits: GoldenCommit[] = [
    { author: 'alice', dayOffset: 0, files: day0Files, message: 'seed: bulk day-0 population (order pair, decorated cohorts, renames/deletes/mega/stub setup)' },
    { author: 'alice', dayOffset: 20, files: day20Files, message: 'feat: decorate 10 existing scopes + add 10 new decorated files' },
    { author: 'alice', dayOffset: 30, files: day30Files, message: 'chore: early-churn rewrite of the day-20 cohort' },
    { author: 'claude', dayOffset: 60, files: day60Files, message: 'feat: add 3 agent-authored files' },
    {
      author: 'alice',
      dayOffset: 65,
      files: day65Files,
      message: 'fix: adjust touch65 seed files\n\nCo-Authored-By: Cursor <cursor@golden.test>',
    },
    { author: 'alice', dayOffset: 90, renames: [{ from: 'src/legacy', to: 'src/archive' }], files: {}, message: 'refactor: rename src/legacy to src/archive' },
    { author: 'alice', dayOffset: 120, deletes: ['src/scratch/scratch0.ts', 'src/scratch/scratch1.ts', 'src/scratch/scratch2.ts'], files: {}, message: 'chore: remove scratch files' },
    { author: 'alice', dayOffset: 150, files: day150Files, message: 'chore: mega-commit touching 40 files' },
    ...orderPairCommits.slice(0, 4), // days 160, 170, 180, 190
    { author: 'alice', dayOffset: 200, files: { 'src/fix/target.ts': ordinaryFile('FixTarget', { rev: 7 }) }, message: 'fix: correct target.ts computation' },
    ...orderPairCommits.slice(4), // days 210, 220, 230, 240, 250
    ...shipPairCommits, // days 300, 320, 340, 360, 380
    { author: 'alice', dayOffset: 395, files: { 'src/svc/refund.ts': refundFileBody() }, message: 'feat: add refund helpers' },
    {
      author: 'alice',
      dayOffset: 400,
      files: { 'NOTES.md': 'Time-depth anchor commit — no registered grammar, no scopes, no partition marker.\n' },
      message: 'chore: trailing note (time-depth anchor)',
    },
  ];

  return { name: 'history', commits };
}
