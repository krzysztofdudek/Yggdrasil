# Aspect Drills

Hand-authored regression fixtures for this repository's aspects. Each drill is a
tiny synthetic source file that an aspect's rule either refuses or passes. When a
maintainer sharpens a rule, these let them confirm — in seconds — that it still
catches what it should and still ignores what it should. Run a whole corpus with
`yg drill --aspect <id>` (see **Running drills** below); deterministic aspects
run locally and free, LLM aspects go through the real reviewer.

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

## Taking a case from real history

A case does not have to be written by hand. When code gets past a rule, take that
exact code into the corpus:

```bash
node source/cli/dist/bin.js drill add --aspect no-todo-comments \
  --violates source/cli/src/cli/check.ts@a1b2c3d \
  --why "shipped on the 3rd; the rule looked for the wrong marker"
```

It reads the file as it stood at that commit, writes it in under the same
`violates-*` / `satisfies-*` convention with the file, the day and the short
commit in the case name, runs the rule over it, and records the reason in a
`log.md` beside the rule. A rule that does not catch its own escape exits
non-zero **and the case stays** — that is the point of adding it. Nothing is
written when the file was not there at that commit, when the same bytes are
already a case, or when the rule cannot be exercised over case files at all.

## Hard rules for authoring drills

- **Either reviewer kind.** `yg drill` runs a deterministic aspect's `check.mjs`
  locally (free) and an LLM aspect's `content.md` through the production prompt
  path (billed). A deterministic check that reads graph context, or an LLM aspect
  that ships `companion.mjs`, resolves to `unsupported` (recorded, not scored) —
  a drill runs the rule over case files only, with no whole-graph context.
- **Source files only, and only under `drills/<case>/`.** Nothing else belongs in
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

## Running drills

`yg drill --aspect <id>` runs an aspect's WHOLE corpus in one command and reports
each case as `pass`, `MISS` (a `violates-*` case the rule failed to refuse — a
real hole), `FALSE-ALARM` (a `satisfies-*` case the rule wrongly refused),
`unrun` (could not be evaluated — a check runtime error or an over-limit LLM
prompt), or `unsupported` (a capability gap — a graph-context check or a
`companion.mjs` aspect). Exit is `1` on any MISS or FALSE-ALARM, `2` if any case
is unrun, else `0`.

```bash
# Run the whole corpus (deterministic aspects run free; LLM aspects bill the reviewer)
node source/cli/dist/bin.js drill --aspect no-direct-minimatch
# -> ... 4 pass · 0 MISS · 0 FALSE-ALARM · 0 unrun · 0 unsupported

# Filter to a subset of case labels
node source/cli/dist/bin.js drill --aspect wasm-tree-lifecycle --case 'violates-*/**'
```

The lock is NEVER written: `yg drill` only appends to a local, gitignored results
log (`.yggdrasil/.drill-results.jsonl`) plus, for LLM cases, one telemetry line
each. Failure output shows only the corpus label, content hashes, and pass/fail —
never the case source, since the committed set is a sharpening aid, not a
measurement. The doctrine "no drill, no enforced" stays advisory: a missing
corpus never gates `yg check`.

## Run book (low-level, one case at a time)

To exercise a single deterministic case directly — bypassing corpus discovery —
run `yg aspect-test --files` over the case's file(s) and read the **stamp line**.
Run each command from the repository root; the comment on each line is the stamp
that case must print.

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

# reviewer-secrets-not-from-flags
node source/cli/dist/bin.js aspect-test --aspect reviewer-secrets-not-from-flags \
  --files .yggdrasil/aspects/reviewer-secrets-not-from-flags/drills/violates-api-key-option/*.ts
# -> yg aspect-test: refused — 1 violation
node source/cli/dist/bin.js aspect-test --aspect reviewer-secrets-not-from-flags \
  --files .yggdrasil/aspects/reviewer-secrets-not-from-flags/drills/violates-options-credential-read/*.ts
# -> yg aspect-test: refused — 1 violation
node source/cli/dist/bin.js aspect-test --aspect reviewer-secrets-not-from-flags \
  --files .yggdrasil/aspects/reviewer-secrets-not-from-flags/drills/satisfies-env-only/*.ts
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
- The `yg drill` runner executes a corpus and classifies each case, but it is
  **never a gate and never touches the lock**: `yg check` does not execute drills,
  no verdict is recorded for them, and they do not affect any pair's hash. `yg
  drill` writes only a local, gitignored results log (and, for LLM cases, a
  telemetry line); the doctrine "no drill, no enforced" stays advisory. Drills
  remain sharpening fixtures, not part of the verification lock.

## errs census

Every **deterministic** aspect (each `check.mjs`) carries an `errs:` field in
its `yg-aspect.yaml` declaring the **error-direction** of the check — which way
it leans when it is wrong. The value is derived from the check's CODE (its
detection mechanism), not from the aspect's prose description. It is
rendering/analysis metadata only: `errs` is **never** folded into any verdict
hash, so seeding or relabeling it re-verifies nothing.

The three values (canonical definitions from `yg schemas read aspect`):

- **over** — the check may flag code the rule does not forbid (false positives
  possible). Typically a text/regex heuristic, a name allowlist that must be
  maintained, a proxy threshold, or a fail-closed rule that flags anything not
  statically provable-safe. A green is trustworthy; a red might be a false alarm.
- **under** — the check only ever fires on provable violations (no false
  positives by design). It resolves only unambiguous cases and stays silent on
  dynamic/aliased shapes. A red is trustworthy; a green may hide a missed
  violation. (`yg suppressions` warns when a waiver targets an `errs: under`
  check, since it has no false positives to waive.)
- **exact** — the check neither over- nor under-approximates: the property is
  fully decidable from what it reads (an existence fact, list-membership, or a
  static structural contract).

One aspect is a genuine **mixed** case and intentionally leaves `errs` **absent**
(see the note below the table) — forcing a single label there would be
dishonest.

| aspect id | errs | justification (from the check's code) |
| --- | --- | --- |
| `command-error-via-buildissuemessage` | over | Heuristic 400-char text window plus `Error:` / `chalk.red` regex around a `stderr.write`; an error routed through `buildIssueMessage` farther away or via an unlisted helper is falsely flagged. |
| `migration-bumps-version` | over | Passes only if some string literal contains the version substring; a migration that references its version by any other means is falsely flagged. |
| `parser-yaml-guard` | over | Requires the literal text `Array.isArray(raw)`; a valid array guard written with a different variable name or form is falsely flagged. |
| `posix-paths-source` | over | Flags a backslash inside any string literal as a path separator; a backslash present for any other reason (escape, message, non-path token) is falsely flagged. |
| `provider-redaction` | over | Sensitivity is decided by a fixed name allowlist (`prompt`/`response`/`content`/`body`); a benignly-named variable matching one is falsely flagged. |
| `read-or-default-via-helper` | over | Regex-matches `readFile` + `ENOENT` in a try/catch's text; a try that reads a file and handles ENOENT for a non-default reason is falsely flagged. |
| `top-level-error-handler` | over | Requires one exact structural idiom (try/catch around `program.parse` with `process.exit(1)` plus an `unhandledRejection` handler); an entry point guaranteeing the same exit via a different structure is falsely flagged. |
| `portal/every-spec-uses-playwright-chromium` | over | "Drives a browser" is approximated by a maintained allowlist of page-method names; a spec that drives the page via any unlisted method is falsely flagged. |
| `portal/every-surface-has-e2e` | over | A spec's coverage is confirmed by a maintained `NAV_MARKERS` regex table; a spec that genuinely navigates a surface via an unlisted marker is falsely flagged as hollow. |
| `portal/focused-file-exports` | over | A >4 runtime-export count is a proxy for single-responsibility; a legitimately-focused file with more exports is falsely flagged (advisory). |
| `portal/focused-file-size` | over | A >400 physical-line cap is a proxy for focus; a legitimately-focused longer file is falsely flagged. |
| `portal/honest-state-anchor` | over | "Renders verdict state" is triggered by a green-word class allowlist (`green`/`ok`/`pass`/`verified`); a decorative green class unrelated to verdict state is falsely flagged as needing the shared model. |
| `portal/loadgraph-nosecrets-flag` | over | Fail-closed: a loader call whose safe flag is not a statically-provable literal `true` (e.g. a variable that is true at runtime) is flagged though functionally safe. |
| `portal/loopback-only` | over | Fail-closed: any `.listen(...)` whose host is not a statically-provable loopback literal (a computed-but-loopback host, or a non-server `.listen` name collision) is flagged. |
| `portal/no-cdn-no-network` | over | Content regex scan for URLs over physical lines; an off-origin-looking but benign string (e.g. an SVG/XML namespace URL) is falsely flagged. |
| `portal/no-network-egress` | over | The content URL-scan arm flags any http(s)/protocol-relative URL in executable code; a non-egress URL (XML/SVG namespace, data value) is falsely flagged (the AST egress-name arm is itself an evadable tripwire). |
| `portal/no-secrets-strings` | over | Substring match of `yg-secrets`/`api_key` in any frontend string literal; a glossary or label string that merely mentions the field name is falsely flagged. |
| `reference/relations/case-has-test` | over | The forward arm flags a catalogue `<id>.md` whenever a bare `it('<id>')` literal is not found, but its regex ignores rule-permitted forms — `it.only`/`it.skip`/`it.todo('<id>')` and template-literal names — so a case that does have a test is falsely flagged; the reverse arm's `runCase` proximity slice can likewise mis-attribute a call, so a red may be a false alarm. |
| `ci-actions-pinned` | over | Content scan of YAML `uses:` lines; any value under a `uses:` key with no `@ref`, `./`/`../` prefix, or `docker://` scheme is treated as an unpinned action, so a non-workflow YAML that reused a `uses:` key for another purpose is falsely flagged (advisory). |
| `repo-check-gate-steps` | over | Category presence is decided by command-keyword regexes over the gate script's non-comment lines; a category invoked under a phrasing the matcher does not recognize is falsely reported missing (advisory). |
| `atomic-write-contract` | under | Flags only a direct call to a raw write function imported by its exact name; a namespace or aliased import (`fs.writeFile`, `writeFile as wf`) is silently skipped. |
| `command-exit-codes` | under | Flags only a literal numeric `process.exit(N)` where N is not 0 or 1; a computed or variable exit code is silently skipped. |
| `e2e-public-surface` | under | Resolves only statically-analyzable relative specifiers into `src/**`; an interpolated or computed specifier is silently skipped (zero-FP by design). |
| `example-self-contained` | under | Resolves only statically-analyzable relative module specifiers (`import`/`export … from`, `require`, dynamic `import`) in JS/TS-family example files; a Python relative import, a computed/interpolated specifier, or a string-path `fs` read is silently skipped, so every flagged escape is a provable cross-directory reference (zero-FP by design, advisory). |
| `no-buildissuemessage-in-engine` | under | Flags only a bare `buildIssueMessage(` identifier call; an aliased or member-form call is silently skipped. |
| `no-direct-console` | under | Flags only a callee whose text is `console.*`; an aliased or bracket-access console is silently skipped. |
| `no-direct-fs` | under | Flags only a static `import` from an fs module; `require('fs')` or a dynamic import is silently skipped. |
| `no-direct-minimatch` | under | Flags only a static `import 'minimatch'`; a require or dynamic import is silently skipped. |
| `no-nondeterminism-direct` | under | Flags only literal `Date.now()` / `Math.random()` / `process.env`; an aliased or bracket-access form is silently skipped. |
| `no-side-effects-on-import` | under | Flags only a bare top-level call/await statement; a side effect hidden in an initializer (`const x = f()`) is silently skipped. |
| `schema-bump-bookkeeping` | under | Flags only a bare `updateConfigVersion(` identifier call; an aliased or member-form call is silently skipped. |
| `single-source-graph-queries` | under | Flags only a reserved-name function or arrow/function-expression declaration; a redefinition through another form is silently skipped. |
| `source-no-raw-control-chars` | under | Flags only a provable raw C0 control byte (`0x00`–`0x1F` except tab/LF/CR) in the decoded content — each such code point is a single UTF-8 byte equal to its value, so a hit is never a false positive; the broader family of invisible/corrupting bytes it does not check (DEL `0x7F`, the C1 range `0x80`–`0x9F`, zero-width and other non-printing code points) is silently skipped, so a green does not prove the file free of every invisible character. |
| `wasm-tree-lifecycle` | under | Flags only a named import of `parseFile` from the parser module; a require, dynamic, or namespace-access form is silently skipped. |
| `portal/approve-shells-cli-only` | under | A tripwire over literal spawn-argument arrays and bare fill-call identifiers; a dynamically-built spawn or an aliased fill call is silently skipped. |
| `portal/count-parity-via-reuse` | under | The negative arms are a self-described evadable tripwire over raw-verdict iteration shapes; a sufficiently obfuscated re-count is silently skipped (the real guarantee is the positive reuse manifest plus the parity test). |
| `portal/no-lock-writer-import` | under | Flags only proven writer imports/calls (with lock-store namespace aliasing); a deeper alias or dynamic reach is silently skipped. |
| `portal/no-node-imports-in-frontend` | under | Flags only static/require/dynamic node-builtin imports and literal `process.` access; a computed specifier or aliased `process` is silently skipped. |
| `portal/no-secrets-import` | under | Flags only proven secrets-module imports/calls and fs reads of a path whose literal text names the secrets file; a computed module or path is silently skipped. |
| `reference/relations/case-is-tested` | under | Fires only on a positively-matched `it('<id>')` block proven defective — `.skip`/`.todo`, no `runCase('…')` string-literal call, or a mismatched literal; an absent block is skipped (delegated to case-has-test) and delegation is confirmed by a loose in-block `runCase` slice, so a green can hide a non-exercising or dynamically-named test. |
| `runcheck-injected-input-parity` | under | Two provable families. PARITY: flags a `runCheck()` call only when its options argument is a plain object literal PROVABLY missing a derived issue-gating key, or is absent entirely; a variable, a spread (in the argument list or inside the literal), a computed key, or any key shape the check cannot read is unprovable and silently skipped. CLASSIFICATION: flags an optional member of runCheck's options interface that is neither derived as issue-gating nor named in the check's side-effect allowlist — a fact read straight off the parsed interface, and itself what the rule forbids. |
| `command-contract-shape` | exact | Decidably counts the file's exported `register<Pascal>Command` declarations and requires exactly one; the contract is fully visible in the static export shape. |
| `sibling-test-file` | exact | Decidably checks whether a file named `<stem>.test.ts` exists in the mapped unit-test node's file set — a pure existence fact over the graph. |
| `reference/doc-shape` | exact | Decidably checks the doc against its `_reference-schema.yaml`: required/enumerated frontmatter, `id` equals the stem, `language` equals the segment, and required sections present in order. |
| `reference/layout` | exact | Decidably checks each doc path against the kind's layout pattern and segment enums, and lists directories for disallowed files — all facts from the graph and filesystem. |
| `reference/section-body` | exact | Decidably checks each section body against the schema contract: a balanced fence of the declared width, keyed-list keys within the allowed set and enums, and every frontmatter-required key present. |

**Mixed / absent — `reviewer-secrets-not-from-flags`.** This check errs in BOTH
directions by design, so its `errs` field is intentionally omitted. It is *over*
because credential-ness is a broad name regex
(`key|secret|token|password|credential`) that false-positives on non-credential
names — notably `token`, which is ubiquitous in an LLM reviewer
(`maxTokens`, `tokenBudget`, …). It is *under* because it matches only direct
reads of the literal `options` identifier, silently skipping the documented
shapes: an aliased options object, a short-flag-only spec, a dynamically-built
spec, and a rest-pattern capture. Neither direction dominates, so no single
label would be honest.

## Graph-context aspects (no drill corpus in v1)

These deterministic aspects read graph context (node / graph / fs / parseYaml),
which a drill case — plain files with no whole-graph context — cannot supply. So
they ship no drill corpus in v1: `yg drill` finds no cases and reports "no case
corpus found — nothing to run". Were a probe case added, the runner would record
it `unsupported` (recorded, not scored), because the check reaches for graph
context the case cannot provide. A future fixture-graph drill mode lifts this.
Each line names the graph context the check actually reads.

- `sibling-test-file` — reads graph context (node, graph); a probe case would record `unsupported` — a future fixture-graph mode lifts this.
- `portal/count-parity-via-reuse` — reads graph context (node); a probe case would record `unsupported` — a future fixture-graph mode lifts this.
- `reference/doc-shape` — reads graph context (node, graph, parseYaml); a probe case would record `unsupported` — a future fixture-graph mode lifts this.
- `reference/layout` — reads graph context (node, graph, fs, parseYaml); a probe case would record `unsupported` — a future fixture-graph mode lifts this.
- `reference/section-body` — reads graph context (node, graph, parseYaml); a probe case would record `unsupported` — a future fixture-graph mode lifts this.
- `reference/relations/case-has-test` — reads graph context (node, graph); a probe case would record `unsupported` — a future fixture-graph mode lifts this.
- `reference/relations/case-is-tested` — reads graph context (node, graph); a probe case would record `unsupported` — a future fixture-graph mode lifts this.
- `runcheck-injected-input-parity` — reads graph context (graph, parseAst) to derive its own rule from another node's file; a probe case would record `unsupported` — a future fixture-graph mode lifts this. Regression-covered instead by a PERMANENT negative-direction fixture pair on disk — `source/cli/tests/fixtures/runcheck-parity` (every call shape it must judge and must not) and `source/cli/tests/fixtures/runcheck-parity-drift` (a seam whose optional member drifted out from under the derivation) — driven through the real built binary by `source/cli/tests/e2e/cli-runcheck-parity.test.ts`, which materializes the REAL aspect directory into each run so the fixture can never hold a stale copy of the rule. See that aspect's check.mjs header for why a drill corpus cannot exercise it: any read of `ctx.graph` under `yg drill` throws `GraphAccessTrap` (`source/cli/src/ast/runner.ts`), which the runner correctly reclassifies as `unsupported` before the check's own logic ever runs, so no drill case could ever produce a real refused/satisfied verdict for it.

Two of these — `reference/doc-shape` and `reference/section-body` — reach graph
context only on the `.md`-file branch that a generic non-`.md` probe never
exercises, so the runner's runtime `unsupported` classification alone would
mis-file them as files-only. Their residual placement is established by READING
the check (`ctx.node` / `ctx.graph` / `ctx.parseYaml` in the schema-load helper),
which is authoritative over a single probe run.

## Path-pinned files-only aspects (no drill corpus in v1)

These two aspects use NO graph context, but each self-scopes to a
repo-root-anchored production path (`filePath.startsWith('source/cli/…')` or an
exact module-path allowlist). A drill case lives under
`.yggdrasil/aspects/<id>/drills/…`, so it can never occupy that path: the check
skips every synthetic case and a would-be `violates-*` case `MISS`es (verified:
a case nested at the look-alike path still `MISS`es, because the prefix stays
`.yggdrasil/`). `yg drill` v1 cannot exercise them; a future path-remapping drill
mode lifts this.

- `no-buildissuemessage-in-engine` — fires only inside `source/cli/src/{core,io,ast}/`; a `.yggdrasil/`-rooted case is always out of scope.
- `instrument-import-fence` — fires only on exact gating / presentation module paths (e.g. `source/cli/src/cli/check.ts`, `source/cli/src/core/check.ts`); a synthetic case path is never in the set.

## Uncovered by design

- Deleting the gate invocation (`- run: scripts/repo-check.sh`) from `ci.yml` is a residual hole left uncovered: `repo-check-gate-steps` guards that the gate keeps its check categories (drift protection), not that CI still runs the gate at all (tamper-proofing). Asserting the invocation is a maintainer opt-up, not part of this aspect.

## family-without-law miner

`scripts/family-without-law.mjs` is an OFFLINE, read-only analysis script (a "miner"),
NOT an aspect and not part of any drill corpus. It makes ZERO LLM calls, is not wired into
`yg`, has no effect on any exit code / verdict / issue / `suggestedNext`, and — the hard
stability guarantee — it **NEVER creates or writes any aspect**. Its only write is the
gitignored `.yggdrasil/.family-candidates.json` telemetry file (best-effort, atomic; the
writer self-ensures the `.gitignore` line). It surfaces PROPOSALS for a human to weigh; a
later `yg advise` layer reads the file. A human always decides.

What it does: within each language stratum (never across languages), it clusters source
files whose structure is near-identical — a **tight cluster**, where "tight" is a robust
intra-cluster distance below a parameter threshold, computed with **median / MAD, never
mean / σ** — and keeps only those clusters that share **no narrow law**. For each surviving
cluster it cuts a **fitted applicability predicate** from the members' shared path or
structure (a minimatch glob, or a content regex over a shared structural signature), so a
proposed rule is born WITH its reach evidence; a cluster for which no discriminating
predicate can be cut is dropped, not proposed.

Near-vacuous caveat (printed verbatim by the miner, and binding here):

> Note: "no shared aspect" is near-vacuous — type-default and broad-parent cascades are excluded, so a family fires only when the cluster shares no NARROW (own / port / narrow-ancestor) aspect that would already be its law.

Shard dependency: the per-file structural feature vectors it clusters on are the wave-6
`features` the AST fact shards carry (`source/cli/src/relations/facts-cache.ts` →
`FeatureVector`: `nodeCount`, depth quartiles, six category counts). The miner reads them
through the CLI's own read-only calibration surface (`yg check --attention-dump`), so it
never re-derives the content-addressed shard key (which would silently rot on a grammar or
extractor-revision bump) and it inherits the engine's exact node-ownership resolution.

Admission control (RZ-21): this surface is admitted only after proven precision at BUILD
time — the planted-family fixtures (`family-planted-mono`, `family-planted-polyglot`) assert
exact recall, zero false families, correct language tagging, no cross-language merge, and
byte-identical determinism across two runs (`tests/unit/family-without-law.test.ts`). That
evidence gate, not any elapsed time, is what lets a family be shown. Thresholds are
evidence-tuned documented constants in the script header (env overrides `YG_FAMILY_*` exist
for recalibration sweeps; the committed defaults are the shipped policy).
