# Aspect Drills

Hand-authored regression fixtures for this repository's **deterministic**
aspects. Each drill is a tiny synthetic source file that a deterministic
`check.mjs` either refuses or passes. When a maintainer sharpens a check, these
let them confirm — by hand, in seconds — that it still catches what it should
and still ignores what it should.

Drills are committed on purpose: they are hand-authored test fixtures, not
rebuildable derived state, so they are versioned alongside the checks they
guard (unlike the gitignored verdict caches under `.yggdrasil/`).

## Layout and naming convention

Drills live beside the aspect they exercise:

```text
.yggdrasil/aspects/<aspect-id>/drills/<case>/<file>.ts
```

The **case directory name encodes the expected verdict**:

- `violates-*` — the check MUST refuse this case; it contains the forbidden
  pattern the rule exists to catch.
- `satisfies-*` — the check MUST pass this case; it contains only allowed
  patterns, including near-miss shapes that must NOT trip the rule.

Each case holds one small `.ts` file with exactly one construct under test, so a
refusal count of `1` maps to a single, obvious cause.

## Hard rules for authoring drills

- **Deterministic aspects only.** Drills are run through `yg aspect-test
  --files`, which executes the aspect's `check.mjs` directly. LLM aspects have
  no local check to exercise this way.
- **`.ts` files only, and only under `drills/<case>/`.** Nothing else belongs in
  a `drills/` tree.
- **Never place a file named `yg-aspect.yaml` anywhere beneath `drills/`** — not
  even as inert fixture data. The graph loader hard-skips any directory named
  `drills` inside an aspect dir, so a stray aspect manifest there registers
  nothing today; but an older released CLI without that guard would register a
  phantom aspect from it. `drills` is a reserved directory name.
- **No `.md` files inside `drills/`.** Markdown lint runs across the whole repo;
  keep prose in this README, which sits at the aspects-dir root and lints clean.
- **English only**, matching every other file under `.yggdrasil/`.

## Verifying a case

Run the aspect against the case's file(s) and read the **stamp line**, never the
bare exit code — exit `1` also covers infrastructure failures, so a green exit
is meaningful but a red exit is not self-explaining:

- `yg aspect-test: refused — N violation` is the expected result for a
  `violates-*` case.
- `yg aspect-test: satisfied — No violations.` is the expected result for a
  `satisfies-*` case.

For `e2e-public-surface`, pass **repo-relative** `--files` paths. That check
resolves module specifiers textually against the importing file's path; an
absolute path shifts the resolution and the violating case would silently pass.
The five `../` segments in its violating drills walk from `drills/<case>/` back
to the repo root before descending into `source/cli/src/`.

## Run book

Run each command from the repository root. The comment on each line is the
stamp that case must print.

```bash
# no-direct-minimatch
node source/cli/dist/bin.js aspect-test --aspect no-direct-minimatch \
  --files .yggdrasil/aspects/no-direct-minimatch/drills/violates-named-import/*.ts
# -> yg aspect-test: refused — 1 violation
node source/cli/dist/bin.js aspect-test --aspect no-direct-minimatch \
  --files .yggdrasil/aspects/no-direct-minimatch/drills/violates-namespace-import/*.ts
# -> yg aspect-test: refused — 1 violation
node source/cli/dist/bin.js aspect-test --aspect no-direct-minimatch \
  --files .yggdrasil/aspects/no-direct-minimatch/drills/satisfies-helper/*.ts
# -> yg aspect-test: satisfied — No violations.
node source/cli/dist/bin.js aspect-test --aspect no-direct-minimatch \
  --files .yggdrasil/aspects/no-direct-minimatch/drills/satisfies-no-glob/*.ts
# -> yg aspect-test: satisfied — No violations.

# wasm-tree-lifecycle
node source/cli/dist/bin.js aspect-test --aspect wasm-tree-lifecycle \
  --files .yggdrasil/aspects/wasm-tree-lifecycle/drills/violates-direct-parsefile/*.ts
# -> yg aspect-test: refused — 1 violation
node source/cli/dist/bin.js aspect-test --aspect wasm-tree-lifecycle \
  --files .yggdrasil/aspects/wasm-tree-lifecycle/drills/violates-aliased-parsefile/*.ts
# -> yg aspect-test: refused — 1 violation
node source/cli/dist/bin.js aspect-test --aspect wasm-tree-lifecycle \
  --files .yggdrasil/aspects/wasm-tree-lifecycle/drills/satisfies-withparsedfile/*.ts
# -> yg aspect-test: satisfied — No violations.
node source/cli/dist/bin.js aspect-test --aspect wasm-tree-lifecycle \
  --files .yggdrasil/aspects/wasm-tree-lifecycle/drills/satisfies-unrelated-parser/*.ts
# -> yg aspect-test: satisfied — No violations.

# e2e-public-surface  (repo-relative --files required)
node source/cli/dist/bin.js aspect-test --aspect e2e-public-surface \
  --files .yggdrasil/aspects/e2e-public-surface/drills/violates-static-import/*.ts
# -> yg aspect-test: refused — 1 violation
node source/cli/dist/bin.js aspect-test --aspect e2e-public-surface \
  --files .yggdrasil/aspects/e2e-public-surface/drills/violates-dynamic-import/*.ts
# -> yg aspect-test: refused — 1 violation
node source/cli/dist/bin.js aspect-test --aspect e2e-public-surface \
  --files .yggdrasil/aspects/e2e-public-surface/drills/satisfies-public-surface/*.ts
# -> yg aspect-test: satisfied — No violations.
node source/cli/dist/bin.js aspect-test --aspect e2e-public-surface \
  --files .yggdrasil/aspects/e2e-public-surface/drills/satisfies-shallow-relative/*.ts
# -> yg aspect-test: satisfied — No violations.
```

## What drills are, and are NOT

Read these honestly before drawing any conclusion from a drill run.

- Drills are **regression fixtures for sharpening `check.mjs`**. They exist to
  catch a check that stops firing (or starts over-firing) after an edit. They
  are NOT a sensitivity/specificity measurement and carry no statistical claim
  about how well a check generalizes.
- This committed dev-set is **agent-visible by design**. Anyone (human or agent)
  editing a check can read the exact cases it is graded against. That is
  intentional for a sharpening aid — and it is precisely why the set proves
  nothing about held-out performance.
- A **sealed holdout**, if one is ever kept, lives **outside this repository**,
  or not at all. Nothing in a committed, agent-visible tree can serve as a
  holdout.
- There is **no engine support** for drills yet: no runner, no gate, no lock
  interaction. `yg check` does not execute them, no verdict is recorded for
  them, and they do not affect any pair's hash. They are inert fixtures run
  manually via `yg aspect-test`, exactly as the run book shows.
