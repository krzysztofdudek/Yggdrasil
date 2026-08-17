# Increment 1: `yg context` Progressive Disclosure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** `yg context --file` gains a layered mode — `--brief` (≤ 30 lines, one line per rule,
owner log-gate state, one-hop relations, flows, trail pointers), `--aspect <id>` single-rule
expansion, an arm preview (how many pairs an edit would invalidate, free vs reviewer-billed), and
progressive-mode scope marking (yours vs inherited) — leaving the default full output
byte-identical for a project with no `progressive:` block.

**Architecture:** All new behavior is additive flags on the existing `yg context` command. A new
pure renderer `formatFileContextBrief` sits beside `formatFileContext` in
`formatters/context-file.ts`; `cli/build-context.ts` assembles the new data fields (armPreview,
scopeMarking, log-gate, flows) reusing existing engines read-only:

- `computeExpectedPairs` (`core/pairs.ts`, already imported at `build-context.ts:22`) for the arm
  preview and for the pair universe scope marking is decided over;
- `resolveChangeScope` (`cli/progressive-scope-resolve.ts`) — the exact entry `cli/check.ts:324`
  calls — plus `pairIsInScope` and `progressivePairKey` for scope marking;
- `buildNodeContextData` (already imported) for the owner's flows, and the log-gate helpers
  `computeSourceFingerprint` / `readLock` / `readLogContent` / `hasFreshLogEntry` (all already
  imported) for the owner's log-gate line.

No engine module changes; no lock writes, no reviewer contact, no filesystem writes. This
increment is **not** graph-free, on two counts: two new imports cross a node boundary, so the
graph declaration of `cli/commands/build-context` is edited in Task 6 (see its steps); and every
new test file must be declared in a test-suite node's `mapping:` in the SAME commit that creates
it (see **New test files are graph work** below).

### New test files are graph work

The `test-suite` architecture type is `enforce: strict` over `source/cli/tests/**` (excluding
`tests/fixtures/**`), and every one of the 45 existing files under `tests/unit/cli/` is named
individually in some node's `mapping:` — there is no directory-glob catch-all. An unmapped new
test file is therefore a **blocking `yg check` error**, verified by adding a throwaway file and
running the real binary:

```text
File 'source/cli/tests/unit/cli/<new>.test.ts' satisfies when of type 'test-suite' (enforce: strict):
<match trace>
But file is not in any node's mapping.
…
Fix: Create yg-node.yaml with type: test-suite and add '<that path>' to its mapping.
```

So each task that creates a test file also edits the owning node in the same commit:

| Test file | Owning node | Edit |
| --- | --- | --- |
| `tests/unit/formatters/context-file-brief.test.ts` (Task 1) | `cli/tests/unit/support/formatters` | add to `mapping:`. It already declares `uses cli/formatters` — no new relation. |
| `tests/unit/cli/build-context-brief.test.ts` (Task 2) | `cli/tests/unit/cli/general` | add to `mapping:`. It already declares `uses` on `cli/commands/build-context`, `cli/core/context`, `cli/core/loader`, `cli/tests/fixtures`. |
| `tests/unit/cli/build-context-progressive.test.ts` (Task 6) | `cli/tests/unit/cli/general` | add to `mapping:`. |

Separately, `{ target: cli/tests/support, type: uses }` joins `cli/tests/unit/cli/general` in
**Task 4** — the first task whose test imports `progressive-fixture.ts`. That node declares 28
relations today against a `max_direct_relations.limit` of 30, so 29 fits with no ceiling edit,
and Task 6 reuses the same relation.

`tests/fixtures/` is mapped by directory prefix (`cli/tests/fixtures`), so Task 2's committed
output baseline needs no mapping edit.

**Tech Stack:** TypeScript (strict, no exported `any`), vitest under `source/cli/tests/unit/`.
Two established test shapes are used, both over real on-disk projects (the repo forbids
fabricated data):

1. **In-process, real graph** — `loadGraph(FIXTURE_PROJECT)` over
   `source/cli/tests/fixtures/sample-project`, exactly as
   `source/cli/tests/unit/core/context-builder.test.ts:18-25` does. This is what produces
   coverage numbers for new `src/**` code.
2. **Spawned built binary, real project** — `spawnSync('node', [BIN_PATH, ...])` over a fixture
   copied to a temp dir, exactly as `source/cli/tests/unit/cli/context-file-type-coverage.test.ts:14-34`
   does, and over a real throwaway git repository built by
   `source/cli/tests/support/progressive-fixture.ts#createProgressiveFixture` (the harness
   `source/cli/tests/e2e/cli-progressive-gate.test.ts` already drives).

**Spec:** `planning/plugin/2026-08-17-plugin-marketplace-plan.md` §PART C (C1, C2) — with
`docs/progressive-mode.md` (branch base) as the authority on measurement semantics, and
`source/cli/src/formatters/context-file.ts` as the authority on current output shapes.

## Global Constraints

- `scripts/repo-check.sh` green before every commit (the pre-commit hook enforces it; never
  bypass it, never `--no-verify`). See **Per-commit gate ritual** below — a bare `git commit`
  after touching these files goes RED, and the reason is not lint.
- Default `yg context --file <p>` output stays **byte-identical** when none of the new flags is
  passed and the project has no `progressive:` block — pinned in Task 2 for both full-view
  shapes (node-owned and type-covered) and re-asserted in Task 6.
- Formatters render already-decided text; business decisions live in the caller
  (`build-context.ts`) — the same division `context-file.ts`'s own comments mandate
  (`FileTypeCoverageView.chainTerminationText`).
- Brief output ≤ 30 lines for a node-owned file. Worst case for the RENDERER with every extra
  present and the aspect list at its cap: path 1 + Owner 1 + scope header 1 + `Must satisfy:` 1
  + 8 aspects × 2 lines 16 + arm preview 1 + Depends on 1 + Dependents 1 + log gate 1 + flows 1
  + 3 `next:` 3 = **28**, or **29** with the truncation tail (which appears only when the list
  exceeds the cap, never at exactly 8). When the aspect list would exceed the cap it is truncated
  with a final line `  … and N more — run yg context --file <p> for all`.
  **The CLI prints one more line than the renderer returns:** the node-owned `--file` path writes
  `<file> -> <node>` to **stdout** before the context (`build-context.ts:489` — despite
  `docs/cli-reference.md`'s claim that it goes to stderr), so a spawned-binary assertion over
  stdout counts **29** at the cap and **30** with the truncation tail. One line of headroom at the
  cap, none at the tail — do not add a line to the brief without re-deriving this. (The
  type-covered path never reaches line 489 and so carries no such line.) Nothing else writes to
  stdout on these paths, and that is what keeps the arithmetic total: the advisory
  structural-attention note — two more stdout lines, a blank one and a sentence — is suppressed
  under `--brief` and `--aspect` (decision D8).
- Coverage stays ≥ 90 % (gate step). A spawned-binary test contributes **zero** coverage of
  `src/**` (separate process), so every new branch also gets an in-process test.
- One CHANGELOG entry under `## [Unreleased]` for the whole increment (Task 7), release-notes
  voice.
- `templates/rules.ts` is deliberately NOT edited in this increment (decision D1), so no digest
  regeneration and no `init --upgrade` sweep across `examples/*/` is required.
- New CLI flags are registered in the commander style `build-context.ts` already uses
  (the `--node` / `--file` options at `build-context.ts:576-577`, inside the command chain at
  `:573-578`); the `contextAction` parameter type
  (`{ node?: string; file?: string }`, `build-context.ts:342`) is widened in the same edit.
- Every task that changes what `yg context --file` prints also updates the `description:` of
  `.yggdrasil/model/cli/commands/build-context/yg-node.yaml` in the same commit — the repo's
  standing rule that behavior changes are reflected in `.yggdrasil/` graph metadata, and the
  text the LLM reviewers for `cli-command-contract` / `what-why-next` are judged against.

### Aspects that actually bite on the files this plan touches

Read from the effective sets the CLI itself reports (`yg context --file <path>` on each file),
not from the architecture's type block alone — the type block omits what the node chain adds:

- `cli/commands/build-context` (type `command`): `cli-command-contract` (LLM),
  `command-error-via-buildissuemessage`, `command-exit-codes` (0/1 only — reached through
  `cli-command-contract`'s `implies`, not the type's own list),
  `command-contract-shape` (exactly one `register*Command` export — an extra non-`register*`
  named export such as `composeBriefExtras` is **not** a violation; the check counts only
  `/^register[A-Z]\w*Command$/`), `diagnostic-logging`, `sibling-test-file`, `source-hygiene`,
  `source-no-raw-control-chars`, plus `what-why-next`, `deterministic` and `posix-paths-output`
  (all three LLM, inherited down the node chain). Type `log_required: true`.
- `cli/formatters` (type `formatter`): `what-why-next` (LLM), `source-hygiene`,
  `source-no-raw-control-chars`, plus the inherited `deterministic` and
  `posix-paths-output` (both LLM).
- **Every new test file** (type `test-suite`): `test-deterministic` (LLM, `scope.per: file` —
  one new reviewer pair per file this plan creates, filled by the per-commit ritual's
  `check --approve`), `self-contained-references`, `source-no-raw-control-chars`.
- `source-hygiene` expands to `posix-paths-source`, `no-direct-minimatch`, `no-shell-injection`,
  `prototype-safe-registry-lookup`, `owner-resolution-single-source`, `self-contained-references`.
  **`self-contained-references` bites this plan directly**: a test's own `it`/`describe` name may
  not carry a bare `(Task N)`, `(Step N)` or `(Phase N)` citation. Name tests after the behavior,
  never after this plan.
- All paths written to stdout go through `toPosixPath` (`posixPath()` local helper in
  `context-file.ts:70`).

The engine-scoped aspects (`no-buildissuemessage-in-engine`, `no-direct-fs`,
`no-nondeterminism-direct`, `no-direct-console`) are inert here: this increment edits no file
under `core/`, `io/` or `ast/`. Four repo-wide deterministic rules ARE in the effective set of
both source files above and are deliberately not listed as biting — `wasm-tree-lifecycle`,
`events-reader-boundary`, `instrument-import-fence`, `rules-artifact-names-single-source`. None
constrains anything this plan writes (no `parseFile` import, no events-reader or graph-metrics
import, no artifact-name literal), and all four are deterministic, so `repo-check.sh`'s closing
`check --approve --only-deterministic` refills them for free.

### Per-commit gate ritual

`scripts/repo-check.sh`'s final step is `yg check --approve --only-deterministic`, which
refills **deterministic** verdicts only. Editing `context-file.ts` and `build-context.ts`
invalidates their **LLM** pairs — `what-why-next`, `deterministic`, `posix-paths-output` for
both, plus `cli-command-contract` and `diagnostic-logging` for the command file (both are
`reviewer.type: llm`; `diagnostic-logging` is easy to miss because its subject is a catch block)
— and each new test file adds an unfilled `test-deterministic` pair; all
of those stay unverified — so a bare `git commit` fails the gate on `yg check`, not on lint.
Before each task's commit, from the repo root:

```sh
(cd source/cli && npm run build)          # dist/bin.js — spawned tests skip without it
node source/cli/dist/bin.js log add --node cli/commands/build-context --reason "<why, self-contained prose>"
node source/cli/dist/bin.js check --approve
```

- The log entry is required by the `command` node type's `log_required: true` whenever
  `build-context.ts` changed; a task that touched only `context-file.ts` skips it (the
  `formatter` type does not set `log_required`).
- `yg check --approve` is keyless and unbilled here: the `standard` tier's provider is
  `claude-code` (`.yggdrasil/yg-config.yaml`), a local CLI provider — not a hosted API.
- Commits are **per task, not per step**. The pre-commit hook runs the whole 17-step gate
  (Chromium portal E2E included); budget several minutes each. No step in this plan commits.

**Decisions binding this plan:**

- **D1:** The agent manual keeps teaching plain `yg context --file`; `--brief` enters the manual
  in the plugin increment (its consumer), avoiding a second digest regeneration cycle now.
- **D2:** Scope marking appears in BOTH the brief and the full view, because the measurement is
  free once resolved and hiding it in one view invites contradiction. The full view has **two**
  aspect-header sites, not one — the node-owned line (`context-file.ts:139`,
  `  <id> [<status>] — <desc>`) and the type-covered line (`context-file.ts:96`,
  `    <id> [<status>, unverified] — <desc>`) — and both take the suffix.
- **D3:** When the change scope cannot be measured, context never guesses and never re-words.
  `resolveChangeScope` returns one of three kinds; each is handled by name:
  - `scoped` → measured. Per-aspect marking is emitted. If it also carries `notice` (the
    measurement succeeded and still reached everything — an architecture/config-vocabulary
    change), that notice is printed too. Note that "nothing has moved" (work at or behind the
    reference, tree clean) is ALSO this kind, with an empty burn: the header then reads
    `your change so far: 0 files; this file is not in it` and every rule marks `(inherited)`,
    which is exactly `docs/progressive-mode.md`'s row for that state ("Every eligible finding is
    reported as inherited … no notice, because nothing went wrong").
  - `unmeasurable` → its `notice` is printed and per-aspect marking is omitted.
  - `whole-project` → **no notice field exists on this kind**. Nothing is printed and the scope
    section is absent. This kind covers only the two rows `docs/progressive-mode.md` describes as
    never attempting a measurement — "No branch named in the config" and `yg check --full` — and
    the config-reference gate below already excludes the first, so in `yg context` it is a
    defensive branch rather than the common case.

  The notice is an `IssueMessage` (`{what, why, next}`), **not** a one-line string, so it is
  printed exactly where and how `cli/check.ts:335-341` prints it — to **stderr**, as
  `chalk.yellow('Notice: ' + buildIssueMessage(notice))` — which keeps stdout's ≤ 30-line brief
  budget intact and keeps one spelling of the sentence in the codebase.
- **D4:** Arm preview counts `PairComputation.pairs` whose `subjectFiles` contain the file
  (post-`scope.files` filtering, so it is the true invalidation set), split by
  `kind: 'llm' | 'deterministic'`; consensus multipliers are NOT applied. The preview says
  "reviewer pairs", not "reviewer calls" as §C2 sketches it — a deliberate refinement, because a
  pair is not a bill: `yg check --approve --dry-run` remains the priced quote, and the preview
  line names it.
- **D5:** `computeExpectedPairs` returns `PairComputation`, whose contract says callers MUST
  surface a non-empty `unreadable` array as a blocking error. `yg context` is read-only and exits
  0 by design (see `build-context.ts:530`'s attention-note comment), so it does not adopt that
  obligation: an unreadable subject is recorded via `debugWrite` and the arm-preview line is
  suppressed entirely for that invocation rather than printed as a count that silently omits
  files. `buildTypeCoveredFileContextData` makes the same call and does not block on it either —
  it destructures `{ drops, pairs }` and drops `unreadable` on the floor. This plan is
  deliberately one notch stricter than that precedent: silence plus a debug line, never a number
  that is quietly short.
- **D6:** The marking words are `(yours)` and `(inherited)` — §C2's own vocabulary, and
  `docs/progressive-mode.md`'s ("reported as inherited debt"). Not "(outside changes)", which
  appears nowhere in the product.
- **D7:** §C1 sketches the third trail pointer as "node aspect list"; this plan makes it
  `yg context --file <p> --aspect <first-aspect-id>` instead. A one-rule expansion of a rule the
  brief just named is the pointer the reader can actually act on next, and it is the surface
  Task 3 ships; a separate node-wide aspect listing is a different command with a different
  subject. Recorded as a deviation rather than taken silently.
- **D8:** The advisory structural-attention note (`maybeAppendAttentionLine`, called at
  `build-context.ts:461-463` on the type-covered path and `:531-533` on the node-owned one) is NOT
  printed under `--brief` or `--aspect`. It writes TWO further lines to stdout — a blank line and
  a sentence — which the ≤ 30-line budget has no room for (one line of headroom at the aspect cap,
  none at the truncation tail), and it is a remark about the whole file's structure, not about the
  one rule `--aspect` was asked to expand. It is untouched on the default full view, whose length
  nothing constrains, so no existing output changes.

---

### Task 1: Brief renderer (`formatFileContextBrief`)

**Files:**

- Modify: `source/cli/src/formatters/context-file.ts`,
  `.yggdrasil/model/cli/tests/unit/support/formatters/yg-node.yaml` (map the new test file)
- Test: `source/cli/tests/unit/formatters/context-file-brief.test.ts` (create)

**Interfaces:**

- Consumes: existing `FileContextData`, `FileContextAspect` (both unchanged — verified present at
  `context-file.ts:12` and `:39`; note `FileContextAspect.source` is **never populated** by
  `buildFileContextData`, so no renderer here may depend on it).
- Produces:

  ```ts
  export interface FileBriefExtras {
    /** "editing this file invalidates N pairs (M free / K reviewer pairs) — …" — pre-rendered by the caller; absent → line omitted */
    armPreviewText?: string;
    /** "your change so far: N files; this file is in it" — pre-rendered (D3); absent → no scope section */
    scopeHeaderText?: string;
    /** aspectId → 'yours' | 'inherited' (only when the change was measured) */
    scopeByAspect?: Map<string, 'yours' | 'inherited'>;
    /** pre-rendered owner log-gate line; absent → line omitted */
    logGateText?: string;
    /** pre-rendered owner flows line; absent → line omitted */
    flowsText?: string;
    /** up to 3 pre-rendered "next:" lines */
    nextPointers: string[];
  }
  export function formatFileContextBrief(data: FileContextData, extras: FileBriefExtras): string;
  ```

  Later tasks rely on exactly these names.

  The renderer's `Owner: unmapped` branch is **defensive, not a CLI surface**: Task 2 leaves the
  unmapped-file paths on their existing what/why/next error, which exits 1 before any renderer
  runs. It is written and unit-tested here so the pure function is total over `FileContextData`
  (the MCP/plugin consumer calls it directly), not because `--brief` will ever reach it.

- [ ] **Step 1: Write the failing tests**

```ts
// source/cli/tests/unit/formatters/context-file-brief.test.ts
import { describe, it, expect } from 'vitest';
import { formatFileContextBrief } from '../../../src/formatters/context-file.js';
import type { FileContextData } from '../../../src/formatters/context-file.js';

const base: FileContextData = {
  filePath: 'src/app/handler.ts',
  ownerPath: 'app/handler',
  ownerType: 'command',
  aspects: [
    { aspectId: 'what-why-next', aspectDescription: 'Diagnostics use the shared builder. Second sentence is dropped.', verifiedAgainst: '.yggdrasil/aspects/what-why-next/content.md', status: 'enforced' },
    { aspectId: 'no-direct-db', aspectDescription: 'Handlers never reach the data store directly.', verifiedAgainst: '.yggdrasil/aspects/no-direct-db/check.mjs', status: 'advisory' },
  ],
  dependencies: [{ path: 'core/db', consumed: ['calls'] }],
  dependentCount: 3,
};

/** Eight aspects — the cap — so the line budget is asserted where it is tightest. */
const eight: FileContextData = {
  ...base,
  aspects: Array.from({ length: 8 }, (_, i) => ({
    aspectId: `rule-${i}`,
    aspectDescription: `Rule ${i} does a thing.`,
    verifiedAgainst: `.yggdrasil/aspects/rule-${i}/check.mjs`,
    status: 'enforced' as const,
  })),
};

describe('formatFileContextBrief', () => {
  it('renders one line per aspect: [status] id — first sentence, then its read path', () => {
    const out = formatFileContextBrief(base, { nextPointers: [] });
    expect(out).toContain('src/app/handler.ts');
    expect(out).toContain('Owner: app/handler (command)');
    expect(out).toContain('[enforced] what-why-next — Diagnostics use the shared builder.');
    expect(out).not.toContain('Second sentence');
    expect(out).toContain('read: .yggdrasil/aspects/what-why-next/content.md');
    expect(out).toContain('[advisory] no-direct-db — Handlers never reach the data store directly.');
  });

  it('caps a long single sentence with the same 80-char helper the full view uses', () => {
    const long = { ...base, aspects: [{ ...base.aspects[0], aspectDescription: 'A'.repeat(200) }] };
    const line = formatFileContextBrief(long, { nextPointers: [] })
      .split('\n')
      .find((l) => l.includes('what-why-next'))!;
    expect(line.endsWith('...')).toBe(true);
    expect(line.length).toBeLessThan(140);
  });

  it('names a draft rule without offering a read path, exactly as the full view refuses to', () => {
    const draft = { ...base, aspects: [{ ...base.aspects[0], status: 'draft' as const }] };
    const out = formatFileContextBrief(draft, { nextPointers: [] });
    expect(out).toContain('[draft] what-why-next —');
    expect(out).toContain('(reviewer skipped; aspect is draft)');
    expect(out).not.toContain('read: .yggdrasil/aspects/what-why-next/content.md');
  });

  it('appends scope suffixes and the scope header when the change was measured', () => {
    const out = formatFileContextBrief(base, {
      nextPointers: [],
      scopeHeaderText: 'your change so far: 2 files; this file is in it',
      scopeByAspect: new Map([['what-why-next', 'yours'], ['no-direct-db', 'inherited']]),
    });
    expect(out).toContain('your change so far: 2 files; this file is in it');
    expect(out).toMatch(/what-why-next.*\(yours\)/);
    expect(out).toMatch(/no-direct-db.*\(inherited\)/);
  });

  it('renders the arm preview, the log-gate and flows lines, and the next pointers in order', () => {
    const out = formatFileContextBrief(base, {
      armPreviewText: 'editing this file invalidates 4 pairs (3 free / 1 reviewer pair) — price a fill: yg check --approve --dry-run',
      logGateText: 'Log entry required before approve: yes (fresh entry present: no)',
      flowsText: 'Flows: checkout · refund',
      nextPointers: ['next: yg log read --node app/handler', 'next: yg context --node app', 'next: yg context --file src/app/handler.ts --aspect no-direct-db'],
    });
    expect(out).toContain('invalidates 4 pairs (3 free / 1 reviewer pair)');
    expect(out).toContain('Log entry required before approve: yes (fresh entry present: no)');
    expect(out).toContain('Flows: checkout · refund');
    const idx = out.indexOf('next: yg log read');
    expect(idx).toBeGreaterThan(-1);
    expect(out.indexOf('next: yg context --node app')).toBeGreaterThan(idx);
  });

  it('truncates beyond 8 aspects with an honest tail line', () => {
    const many = { ...base, aspects: Array.from({ length: 11 }, (_, i) => ({
      aspectId: `rule-${i}`, aspectDescription: `Rule ${i} does a thing.`,
      verifiedAgainst: `.yggdrasil/aspects/rule-${i}/check.mjs`,
      status: 'enforced' as const })) };
    const out = formatFileContextBrief(many, { nextPointers: [] });
    expect(out).toContain('rule-7');
    expect(out).not.toContain('rule-8');
    expect(out).toContain('… and 3 more — run yg context --file src/app/handler.ts for all');
  });

  it('stays within 30 lines at the aspect cap with every extra present', () => {
    const out = formatFileContextBrief(eight, {
      armPreviewText: 'editing this file invalidates 4 pairs (3 free / 1 reviewer pair) — price a fill: yg check --approve --dry-run',
      scopeHeaderText: 'your change so far: 2 files; this file is in it',
      scopeByAspect: new Map(eight.aspects.map((a) => [a.aspectId, 'yours' as const])),
      logGateText: 'Log entry required before approve: no (fresh entry present: no)',
      flowsText: 'Flows: checkout',
      nextPointers: ['next: a', 'next: b', 'next: c'],
    });
    expect(out.trimEnd().split('\n').length).toBeLessThanOrEqual(30);
  });

  it('renders the type-covered variant with the same one-line-per-aspect shape', () => {
    const tc: FileContextData = { filePath: 'src/lib/util.ts', aspects: [], dependencies: [], dependentCount: 0,
      typeCoverage: { typeId: 'library', chainTerminationText: 'Inherited rules stop at the type.',
        applied: [{ aspectId: 'pure-fn', aspectDescription: 'Library files export pure functions.', verifiedAgainst: '.yggdrasil/aspects/pure-fn/check.mjs', status: 'enforced', unverified: true }],
        dropped: [] } };
    const out = formatFileContextBrief(tc, { nextPointers: [] });
    expect(out).toContain('Owner: type:library');
    expect(out).toContain('[enforced, unverified] pure-fn — Library files export pure functions.');
  });

  it('an unmapped file says so and still offers its candidate nodes', () => {
    const un: FileContextData = { filePath: 'src/loose.ts', aspects: [], dependencies: [], dependentCount: 0,
      candidates: [{ nodePath: 'app', mappingPrefix: 'src/app' }, { nodePath: 'lib', mappingPrefix: 'src/lib' }] };
    const out = formatFileContextBrief(un, { nextPointers: [] });
    expect(out).toContain('Owner: unmapped');
    expect(out).toContain('Candidate nodes: app · lib');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd source/cli && npx vitest run tests/unit/formatters/context-file-brief.test.ts`
Expected: FAIL — `formatFileContextBrief` is not exported.

- [ ] **Step 3: Implement `formatFileContextBrief` in `context-file.ts`**

Append at the end of the file (`truncateDescription` and `posixPath` are already in scope at
`context-file.ts:1` and `:70` — do not re-import or re-define):

```ts
export interface FileBriefExtras {
  armPreviewText?: string;
  scopeHeaderText?: string;
  scopeByAspect?: Map<string, 'yours' | 'inherited'>;
  logGateText?: string;
  flowsText?: string;
  nextPointers: string[];
}

const BRIEF_ASPECT_CAP = 8;

/**
 * The first sentence of a rule's description, capped by the SAME 80-char helper
 * the full view already applies to reference descriptions — a brief that can be
 * blown out to one 2000-character line by one verbose rule is not a brief.
 */
function briefDescription(text: string): string {
  const trimmed = text.trim();
  const m = /^.*?[.!?](?=\s|$)/.exec(trimmed);
  return truncateDescription((m ? m[0] : trimmed).trim());
}

function briefAspectLines(a: FileContextAspect, scope?: 'yours' | 'inherited'): string[] {
  const status = a.status ?? 'enforced';
  const caveat = a.unverified ? ', unverified' : '';
  const suffix = scope === undefined ? '' : ` (${scope})`;
  const head = `  [${status}${caveat}] ${a.aspectId} — ${briefDescription(a.aspectDescription)}${suffix}`;
  // A draft rule has no reviewer and no verdict; the full view withholds its
  // read path for exactly that reason, and the brief must not contradict it by
  // pointing at a rule source nothing is judged against.
  if (status === 'draft') return [head, '    (reviewer skipped; aspect is draft)'];
  return [head, `    read: ${posixPath(a.verifiedAgainst)}`];
}

export function formatFileContextBrief(data: FileContextData, extras: FileBriefExtras): string {
  const lines: string[] = [];
  lines.push(posixPath(data.filePath));
  if (data.ownerPath) {
    lines.push(`  Owner: ${posixPath(data.ownerPath)} (${data.ownerType ?? 'unknown'})`);
  } else if (data.typeCoverage) {
    lines.push(`  Owner: type:${data.typeCoverage.typeId}`);
  } else {
    lines.push('  Owner: unmapped');
    if (data.candidates && data.candidates.length > 0) {
      lines.push(`  Candidate nodes: ${data.candidates.map((c) => posixPath(c.nodePath)).join(' · ')}`);
    }
  }
  if (extras.scopeHeaderText) lines.push(`  ${extras.scopeHeaderText}`);
  const aspects = data.ownerPath ? data.aspects : (data.typeCoverage?.applied ?? []);
  if (aspects.length > 0) {
    lines.push('  Must satisfy:');
    for (const a of aspects.slice(0, BRIEF_ASPECT_CAP)) {
      lines.push(...briefAspectLines(a, extras.scopeByAspect?.get(a.aspectId)));
    }
    if (aspects.length > BRIEF_ASPECT_CAP) {
      lines.push(`  … and ${aspects.length - BRIEF_ASPECT_CAP} more — run yg context --file ${posixPath(data.filePath)} for all`);
    }
  }
  if (extras.armPreviewText) lines.push(`  ${extras.armPreviewText}`);
  if (data.dependencies.length > 0) {
    lines.push(`  Depends on: ${data.dependencies.slice(0, 3).map((d) => posixPath(d.path)).join(' · ')}${data.dependencies.length > 3 ? ' · …' : ''}`);
  }
  if (data.dependentCount > 0) lines.push(`  Dependents: ${data.dependentCount} nodes`);
  if (extras.logGateText) lines.push(`  ${extras.logGateText}`);
  if (extras.flowsText) lines.push(`  ${extras.flowsText}`);
  for (const p of extras.nextPointers.slice(0, 3)) lines.push(`  ${p}`);
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd source/cli && npx vitest run tests/unit/formatters/context-file-brief.test.ts`
Expected: PASS (all 9).

- [ ] **Step 5: Map the new test file, typecheck, gate ritual, commit**

```sh
# add source/cli/tests/unit/formatters/context-file-brief.test.ts to the mapping: of
# .yggdrasil/model/cli/tests/unit/support/formatters/yg-node.yaml — without it yg check
# fails with type-strict-orphan on the new file
cd source/cli && npm run typecheck && npm run build
cd .. && node source/cli/dist/bin.js check --approve      # refills cli/formatters' LLM pairs and the new file's test-deterministic pair; no log entry needed (formatter type)
git add source/cli/src/formatters/context-file.ts source/cli/tests/unit/formatters/context-file-brief.test.ts .yggdrasil
git commit -m "feat(context): brief renderer with scope suffixes, arm preview and trail pointers"
```

---

### Task 2: `--brief` flag wiring in `build-context.ts`, plus the byte-identity pin

**Files:**

- Modify: `source/cli/src/cli/build-context.ts`,
  `.yggdrasil/model/cli/commands/build-context/yg-node.yaml` (description),
  `.yggdrasil/model/cli/tests/unit/cli/general/yg-node.yaml` (map the new test file)
- Test: `source/cli/tests/unit/cli/build-context-brief.test.ts` (create)

**Interfaces:**

- Consumes: `formatFileContextBrief`, `FileBriefExtras` (Task 1).
- Produces:
  - `yg context --file <p> --brief` CLI behavior. `contextAction`'s parameter type widens from
    `{ node?: string; file?: string }` to `{ node?: string; file?: string; brief?: boolean }`.
  - `export async function composeBriefExtras(graph: Graph, filePath: string, data: FileContextData): Promise<FileBriefExtras>` —
    a named export marked `/** Exported so the brief's assembly decisions are testable in-process; not part of the CLI surface. */`.
    (`command-contract-shape` counts only `register*Command` exports, so this extra export is
    legal — verified against `.yggdrasil/aspects/command-contract-shape/check.mjs`.)
    In this task it assembles only `nextPointers`; later tasks fill the rest:
    1. `next: yg log read --node <ownerPath>` — only when an owner node exists,
    2. `next: yg context --node <parent-of-owner>` — only when the owner has a parent node,
    3. `next: yg context --file <p> --aspect <first-aspect-id>` — only when the file has ≥ 1
       EFFECTIVE aspect, read from the same list the renderer and `--aspect` read
       (`data.aspects` for a node-owned file, `data.typeCoverage.applied` for a type-covered one),
       so a type-covered file offers the pointer too rather than silently dropping it.

- [ ] **Step 1: Write the failing tests**

```ts
// source/cli/tests/unit/cli/build-context-brief.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { buildFileContextData } from '../../../src/core/context-builder.js';
import { composeBriefExtras } from '../../../src/cli/build-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
const distExists = existsSync(BIN_PATH);

// The fixture's one node-owned file, read off orders/order-service's `mapping:`
// (it maps exactly this path) rather than guessed: the assertions below are
// about the SHAPE of the brief, and a wrong path would fail them for the wrong
// reason.
const OWNED_FILE = 'src/orders/order.service.ts';
const BASELINE = path.join(CLI_ROOT, 'tests', 'fixtures', 'context-baselines', 'sample-project-order-service.txt');

function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-context-brief-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

describe('composeBriefExtras — trail pointers', () => {
  it('offers the owner log, the parent node, and the first rule, in that order', async () => {
    const graph = await loadGraph(FIXTURE);
    const data = buildFileContextData(graph, OWNED_FILE, 'orders/order-service');
    const extras = await composeBriefExtras(graph, OWNED_FILE, data);
    expect(extras.nextPointers[0]).toBe('next: yg log read --node orders/order-service');
    expect(extras.nextPointers[1]).toBe('next: yg context --node orders');
    expect(extras.nextPointers[2]).toBe(`next: yg context --file ${OWNED_FILE} --aspect ${data.aspects[0].aspectId}`);
    expect(extras.nextPointers.length).toBeLessThanOrEqual(3);
  });
});

describe.skipIf(!distExists)('yg context --file --brief', () => {
  it('is compact, one line per rule, and never exceeds the budget', () => {
    const dir = copyFixture();
    try {
      const { stdout, status } = run(['context', '--file', OWNED_FILE, '--brief'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Must satisfy:');
      expect(stdout).toContain('next: yg log read --node orders/order-service');
      expect(stdout.trimEnd().split('\n').length).toBeLessThanOrEqual(30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses the compact view for a component, naming the flag that fits', () => {
    const dir = copyFixture();
    try {
      const { stderr, status } = run(['context', '--node', 'orders/order-service', '--brief'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('--brief is only available with --file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the default full view byte-identical when no new flag is passed', () => {
    // A REAL run of the built binary against a capture taken before this
    // command's output path was touched at all, byte for byte. Re-run after
    // every later task; it is the increment's regression floor.
    const dir = copyFixture();
    try {
      const withoutFlag = run(['context', '--file', OWNED_FILE], dir);
      expect(withoutFlag.status).toBe(0);
      // THE pin: the committed pre-edit capture, byte for byte.
      expect(withoutFlag.stdout).toBe(readFileSync(BASELINE, 'utf-8'));
      expect(withoutFlag.stdout).toContain('Must satisfy:');
      expect(withoutFlag.stdout).toContain('Node context: run yg context --node');
      // The brief is a DIFFERENT rendering, not a reformat of the same text.
      const brief = run(['context', '--file', OWNED_FILE, '--brief'], dir);
      expect(brief.stdout).not.toBe(withoutFlag.stdout);
      expect(brief.stdout.length).toBeLessThan(withoutFlag.stdout.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

The `BASELINE` file the pin reads must be captured FIRST, in Step 1, before any edit to
`build-context.ts` — a baseline captured after the edit proves nothing. (Task 1's commit is
already in; it only appended new exports to `context-file.ts` and changed no byte of what
`formatFileContext` renders, so a capture taken here is still the pre-increment output.) Capture it with
`node source/cli/dist/bin.js context --file src/orders/order.service.ts > …` run inside a COPY of
the fixture (never in-place: the run leaves gitignored engine state behind), writing to
`source/cli/tests/fixtures/context-baselines/sample-project-order-service.txt`, and commit it.
Note it captures stdout only, so it includes the `<file> -> <node>` resolution line the command
writes there.

- [ ] **Step 2: Run the tests, verify they fail** (`composeBriefExtras` is not exported;
  `--brief` is an unknown option). Run: `cd source/cli && npm run build && npx vitest run tests/unit/cli/build-context-brief.test.ts`.

- [ ] **Step 3: Implement**

- Register `.option('--brief', 'compact one-line-per-rule view (≤ 30 lines)')` beside the
  existing `--node`/`--file` options at `build-context.ts:576-577`. **`--aspect` is NOT registered
  here** — a flag that parses but does nothing is a worse surface than an absent one; it lands
  with its behavior in Task 3.
- Widen `contextAction`'s parameter type to include `brief?: boolean`.
- In the `resolvedFilePath` branch (`build-context.ts:525-527`) and in the type-covered branch
  (`:459-460`), when `options.brief` is set call
  `formatFileContextBrief(data, await composeBriefExtras(graph, <file>, data))` instead of
  `formatFileContext(data)`. `<file>` is `resolvedFilePath` at `:525-527` and `displayFile` at
  `:459-460` — the two hold the same value (`toPosixPath(result.file)`), but `displayFile` is
  block-scoped inside `if (options.file)` (declared `:370`, out of scope by `:525`), so naming it
  in the lower branch would not compile. The unmapped-file branches keep their existing
  what/why/next messages — a file with no owner and no type has no rules to brief.
- Skip `maybeAppendAttentionLine` on both branches when `options.brief` is set (D8) — otherwise
  the note's two stdout lines land inside the brief's budget.
- `--brief` with `--node` is refused, beside the existing `--node`/`--file` exclusivity check
  (`:352-359`) and in the same shape — `buildIssueMessage` to stderr, `process.exit(1)`:
  - WHAT: `--brief is only available with --file.`
  - WHY: `The brief compresses one file's obligations into a line per rule; --node already prints the component view, which has no per-file rule list to compress.`
  - NEXT: `Run: yg context --file <path> --brief, or yg context --node <path> for the component view.`
- `composeBriefExtras` derives the parent node path by trimming the last `/`-segment of
  `data.ownerPath` and checking `graph.nodes.has(...)`; it emits nothing for a root-level owner.

- [ ] **Step 4: Run the new test plus `tests/unit/cli/build-context.test.ts` and
  `tests/unit/cli/context-file-type-coverage.test.ts`; verify all pass.**

- [ ] **Step 5: Update the node description, map the new test file, run the gate ritual, commit**

```sh
# edit .yggdrasil/model/cli/commands/build-context/yg-node.yaml description: add the --brief view
# add source/cli/tests/unit/cli/build-context-brief.test.ts to the mapping: of
# .yggdrasil/model/cli/tests/unit/cli/general/yg-node.yaml (no new relation needed — that node
# already declares uses on cli/commands/build-context, cli/core/context, cli/core/loader,
# cli/tests/fixtures)
(cd source/cli && npm run build)
node source/cli/dist/bin.js log add --node cli/commands/build-context --reason "yg context --file gains a compact one-line-per-rule view so an agent can read a file's obligations without paging through the full package; the default output is unchanged and pinned against a committed baseline."
node source/cli/dist/bin.js check --approve
git add -A && git commit -m "feat(context): --brief flag renders the compact layered view"
```

---

### Task 3: `--aspect <id>` single-rule expansion

**Files:**

- Modify: `source/cli/src/cli/build-context.ts`, `source/cli/src/formatters/context-file.ts`,
  `.yggdrasil/model/cli/commands/build-context/yg-node.yaml` (description)
- Test: extend `source/cli/tests/unit/formatters/context-file-brief.test.ts` (renderer) and
  `source/cli/tests/unit/cli/build-context-brief.test.ts` (CLI behavior)

**Interfaces:**

- Produces: `export function formatFileContextAspect(data: FileContextData, aspectId: string): string | undefined`
  in `context-file.ts` — returns `undefined` when the id is not among the file's effective
  aspects (`data.aspects` for a node-owned file, `data.typeCoverage.applied` for a type-covered
  one), so the CLI owns the error, not the formatter. When found it renders, for that one aspect:
  the FULL untruncated `aspectDescription`, the `[status]` tag (with `, unverified` when set),
  `read: <verifiedAgainst>`, one `read:` line per entry of `references` (with
  `truncateDescription(description)` where present, exactly as `context-file.ts:149-157` does),
  and `read: <companionReadPath>` when set.
  **No `Source:` line** — `FileContextAspect.source` is never populated by
  `buildFileContextData` or by `buildTypeCoveredFileContextData`, so a `Source:` branch here
  would be dead code claiming a field that has no producer.
- CLI: `contextAction`'s parameter type gains `aspect?: string`. An unknown id is a USER error —
  `process.stderr.write(chalk.red('Error: ' + buildIssueMessage({...}) + '\n'))` then
  `process.exit(1)`, matching `command-error-via-buildissuemessage` and `command-exit-codes`:
  - WHAT: `Rule '<id>' is not one of the rules enforced on <file>.`
  - WHY: `--aspect names a rule from this file's own effective set; a rule attached elsewhere in the graph is not enforced here.`
  - NEXT: `Run: yg context --file <file> --brief to list this file's rules, then retry with one of them.`

- [ ] **Step 1: Write the failing tests**

Renderer tests, added to `context-file-brief.test.ts`:

```ts
describe('formatFileContextAspect', () => {
  const withRefs: FileContextData = {
    ...base,
    aspects: [{
      aspectId: 'what-why-next',
      aspectDescription: 'Diagnostics use the shared builder. Second sentence is kept here.',
      verifiedAgainst: '.yggdrasil/aspects/what-why-next/content.md',
      status: 'enforced',
      references: [{ path: 'src/formatters/message-builder.ts', description: 'The builder itself.' }],
      companionReadPath: '.yggdrasil/aspects/what-why-next/companion.mjs',
    }],
  };

  it('keeps the whole description the brief truncated, and every read path', () => {
    const out = formatFileContextAspect(withRefs, 'what-why-next')!;
    expect(out).toContain('Second sentence is kept here.');
    expect(out).toContain('read: .yggdrasil/aspects/what-why-next/content.md');
    expect(out).toContain('read: src/formatters/message-builder.ts — The builder itself.');
    expect(out).toContain('read: .yggdrasil/aspects/what-why-next/companion.mjs');
  });

  it('returns undefined for a rule this file does not carry', () => {
    expect(formatFileContextAspect(withRefs, 'no-such-rule')).toBeUndefined();
  });

  it('finds a rule on a type-covered file too', () => {
    const tc: FileContextData = { filePath: 'src/lib/util.ts', aspects: [], dependencies: [], dependentCount: 0,
      typeCoverage: { typeId: 'library', chainTerminationText: 'stops here.',
        applied: [{ aspectId: 'pure-fn', aspectDescription: 'Library files export pure functions.', verifiedAgainst: '.yggdrasil/aspects/pure-fn/check.mjs', status: 'enforced', unverified: true }],
        dropped: [] } };
    expect(formatFileContextAspect(tc, 'pure-fn')).toContain('[enforced, unverified]');
  });
});
```

CLI tests, added to `build-context-brief.test.ts` inside the `describe.skipIf(!distExists)` block:

```ts
  it('expands one rule in full', () => {
    const dir = copyFixture();
    try {
      const brief = run(['context', '--file', OWNED_FILE, '--brief'], dir);
      const ruleId = /\[\w+\] ([a-z0-9-]+) —/.exec(brief.stdout)![1];
      const { stdout, status } = run(['context', '--file', OWNED_FILE, '--aspect', ruleId], dir);
      expect(status).toBe(0);
      expect(stdout).toContain(ruleId);
      expect(stdout).toContain('read: ');
      expect(stdout).not.toContain('Must satisfy:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unknown rule id with what, why and a next command', () => {
    const dir = copyFixture();
    try {
      const { stderr, status } = run(['context', '--file', OWNED_FILE, '--aspect', 'no-such-rule'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain("Rule 'no-such-rule' is not one of the rules enforced on");
      expect(stderr).toContain('--aspect names a rule from this file');
      expect(stderr).toContain('--brief to list this file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run both suites, verify the new cases fail** (`formatFileContextAspect` is not
  exported; `--aspect` is an unknown option). Run `npm run build` first.

- [ ] **Step 3: Implement** the renderer, then register
  `.option('--aspect <id>', 'expand one rule in full (wins over --brief)')` and add the CLI
  branch: `--aspect` is checked BEFORE `--brief` in both the node-owned and type-covered file
  branches; `undefined` from the renderer routes to the what/why/next error above. As with
  `--brief`: the attention note is skipped on this path too (D8), and `--aspect` passed with
  `--node` is refused by the same guard Task 2 added — WHAT `--aspect is only available with
  --file.`, WHY `--aspect expands one rule from one file's own effective set; a component's rules
  are listed by yg context --node itself.`, NEXT `Run: yg context --file <path> --aspect <id>.`

- [ ] **Step 4: Run both suites plus `build-context.test.ts` and
  `context-file-type-coverage.test.ts`; verify all pass, and that the byte-identity assertion
  from Task 2 still holds.**

- [ ] **Step 5: Update the node description, run the gate ritual (log entry + `check --approve`),
  commit** — `feat(context): --aspect expands a single rule in full`

---

### Task 4: Arm preview (D4, D5)

**Files:**

- Modify: `source/cli/src/cli/build-context.ts`,
  `.yggdrasil/model/cli/commands/build-context/yg-node.yaml` (description),
  `.yggdrasil/model/cli/tests/unit/cli/general/yg-node.yaml` (new `cli/tests/support` relation)
- Test: extend `source/cli/tests/unit/cli/build-context-brief.test.ts`

**Interfaces:**

- Consumes: `computeExpectedPairs` (already imported, `build-context.ts:22`) and
  `computeTypeCoverageForContext` (already defined, `build-context.ts:100`). The call is
  `const { pairs, unreadable } = await computeExpectedPairs(graph, { typeCoverage: await computeTypeCoverageForContext(graph) })`:
  - it returns a `PairComputation`, **not** an array — destructure `.pairs`;
  - `typeCoverage` must be passed, otherwise a type-covered file's nodeless pairs are never
    enumerated and its preview is always zero;
  - `includeDraft` stays at its default `false`, so draft pairs never appear (D4) — do not
    re-filter for status;
  - a non-empty `unreadable` suppresses the whole preview line (D5) and is recorded via
    `debugWrite`.
- Produces: `armPreviewText` inside `composeBriefExtras`:
  `editing this file invalidates N pairs (M free / K reviewer pairs) — price a fill: yg check --approve --dry-run`
  where N counts pairs whose `subjectFiles` includes `toPosixPath(file)`, M those with
  `kind === 'deterministic'`, K those with `kind === 'llm'`. Singular/plural: `1 pair`,
  `1 reviewer pair`. When N = 0 the line is omitted — a brief must not carry a zero-information
  line.
- **Cost note:** this adds one whole-repo walk plus one whole-graph pair enumeration to every
  `--brief` invocation. Compute both ONCE per invocation and thread the result to Task 6's scope
  marking rather than enumerating twice; the plugin's post-edit hook is the consumer, and it runs
  this per file edit. Sharing the walk is not free by default: `computeTypeCoverageForContext`
  takes only `(graph)` and calls `walkRepoFiles` itself (`build-context.ts:103`). Widen that
  private helper to `(graph, repoFiles?: string[])` and fall back to its own walk when the
  argument is absent — a local, behavior-preserving change to a non-exported function, so no
  graph or contract consequence. Sharing is bounded, not total: under progressive mode Task 6's
  `resolveChangeScope` runs its OWN `resolveTypeCoverage` + `computeExpectedPairs`
  (`progressive-scope-resolve.ts:447-448`) behind a signature that accepts neither result, so the
  enumeration still happens twice on a measured run. That is pre-existing and out of scope here;
  do not widen the resolver's public input to chase it in this increment.

- [ ] **Step 1: Write the failing tests** — build a real project with both reviewer kinds using
  `createProgressiveFixture` from `source/cli/tests/support/progressive-fixture.ts` (it is
  importable from `tests/unit/`: it imports only node builtins and `git-fixture.ts`). The two
  spawned cases below go **inside** the existing `describe.skipIf(!distExists)` block, like every
  other binary-driven case in this file; `afterEach` joins the file's `vitest` import. This is the
  first import of `tests/support/` from this test file, so **this task** adds
  `{ target: cli/tests/support, type: uses }` to `.yggdrasil/model/cli/tests/unit/cli/general/yg-node.yaml`
  (28 declared relations against a limit of 30 — 29 fits). Task 6 then reuses it:

```ts
// `afterEach` is added to the file's EXISTING `import { describe, it, expect } from 'vitest'`,
// not imported a second time.
import { createProgressiveFixture, type ProgressiveFixture } from '../../support/progressive-fixture.js';

const fixtures: ProgressiveFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

it('counts the pairs an edit would invalidate, split free vs reviewer', () => {
  // deterministicAspect is on by default (no-todo-comments, per component);
  // reviewedAspect adds a per-FILE reviewer-judged rule. The endpoint is a
  // loopback that is never dialed: this preview contacts no reviewer.
  const f = createProgressiveFixture({ label: 'arm', reviewedAspect: { endpoint: 'http://127.0.0.1:1/never', perFile: true } });
  fixtures.push(f);
  const { stdout, status } = run(['context', '--file', 'src/alpha/alpha.ts', '--brief'], f.dir);
  expect(status).toBe(0);
  expect(stdout).toContain('invalidates 2 pairs (1 free / 1 reviewer pair)');
  expect(stdout).toContain('price a fill: yg check --approve --dry-run');
});

it('omits the line for a file no rule reviews', () => {
  const f = createProgressiveFixture({ label: 'arm-none', deterministicAspect: false,
    reviewedAspect: { endpoint: 'http://127.0.0.1:1/never', perFile: true, sourceFilesOnly: true } });
  fixtures.push(f);
  f.commit('src/alpha/NOTES.md', 'no rule reviews this file\n');
  const { stdout } = run(['context', '--file', 'src/alpha/NOTES.md', '--brief'], f.dir);
  expect(stdout).not.toContain('invalidates');
});
```

Also add an in-process case so the branch is covered by the coverage gate. In
`tests/fixtures/sample-project`, `orders/order-service` carries exactly two rules, both
reviewer-judged and both per-component (`requires-audit`, which `implies requires-logging`;
neither declares a `scope:`), so the assertion is exact:

```ts
it('reports a reviewer-only file as costing no free checks', async () => {
  const graph = await loadGraph(FIXTURE);
  const data = buildFileContextData(graph, OWNED_FILE, 'orders/order-service');
  const extras = await composeBriefExtras(graph, OWNED_FILE, data);
  expect(extras.armPreviewText).toBe(
    'editing this file invalidates 2 pairs (0 free / 2 reviewer pairs) — price a fill: yg check --approve --dry-run',
  );
});
```

- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement in `composeBriefExtras`,** per the interface above.
- [ ] **Step 4: Run the suite plus the byte-identity assertion; verify all pass.**
- [ ] **Step 5: Update the node description, run the gate ritual, commit** —
  `feat(context): arm preview counts the pairs an edit would invalidate`

---

### Task 5: Completing C1 — owner log-gate state and flows in the brief

§PART C's C1 lists "log-gate state, one-hop relations, flows" as brief content. Relations landed
in Task 1; this task lands the other two. It is a separate task because it needs no new imports
and no graph edit, so it must not be entangled with Task 6's.

**Files:**

- Modify: `source/cli/src/cli/build-context.ts`,
  `.yggdrasil/model/cli/commands/build-context/yg-node.yaml` (description)
- Test: extend `source/cli/tests/unit/cli/build-context-brief.test.ts`

**Interfaces:**

- Produces, inside `composeBriefExtras` for a node-owned file only (a type-covered file has no
  component, therefore no log gate and no flow membership — both lines are absent):
  - `logGateText` = `Log entry required before approve: <yes|no> (fresh entry present: <yes|no>)`,
    derived by the SAME sequence `attachLockObservability` uses for the node view
    (its log-gate block, `build-context.ts:264-294`):
    `graph.architecture.node_types[<ownerType>]?.log_required`,
    then `computeSourceFingerprint(graph, ownerPath)` compared against
    `readLock(graph.rootPath).nodes[ownerPath]?.source`, then
    `hasFreshLogEntry(await readLogContent(projectRoot, ownerPath), lock.nodes[ownerPath]?.log)`.
    Every one of those symbols is ALREADY imported by `build-context.ts` —
    `computeSourceFingerprint` and `FileUnreadableError` at line 22, `readLock` at 29,
    `readLogContent` / `hasFreshLogEntry` at 31 — so no new import and no new relation. When the owner's type does not set `log_required`, the line
    is omitted rather than printed as "no": a brief carries no zero-information lines.
    A `FileUnreadableError` from the fingerprint is caught and the line omitted, exactly as
    `attachLockObservability` catches it.
  - `flowsText` = `Flows: <name> · <name>` from `buildNodeContextData(graph, ownerPath).flows`
    (`buildNodeContextData` is already imported at line 7 and is pure). Omitted when the owner
    participates in no flow.

- [ ] **Step 1: Write the failing tests**

```ts
it('tells a component whose type demands a written reason that one is owed', () => {
  // A fresh fixture has recorded no entry and no baseline, so the gate is open
  // and nothing satisfies it yet — the honest state for a first edit.
  const f = createProgressiveFixture({ label: 'gate', logRequired: true });
  fixtures.push(f);
  const { stdout, status } = run(['context', '--file', 'src/alpha/alpha.ts', '--brief'], f.dir);
  expect(status).toBe(0);
  expect(stdout).toContain('Log entry required before approve: yes (fresh entry present: no)');
});

it('says nothing about a written reason when the type does not demand one', () => {
  const f = createProgressiveFixture({ label: 'no-gate' });   // logRequired defaults off
  fixtures.push(f);
  const { stdout } = run(['context', '--file', 'src/alpha/alpha.ts', '--brief'], f.dir);
  expect(stdout).not.toContain('Log entry required before approve');
});

it('derives the owed-reason state from the graph, not from the printed line', async () => {
  // In-process twin of the spawned case above: the log-gate branch is new
  // `src/**` code, and a spawned run contributes no coverage of it.
  const f = createProgressiveFixture({ label: 'gate-inproc', logRequired: true });
  fixtures.push(f);
  const graph = await loadGraph(f.dir);
  const data = buildFileContextData(graph, 'src/alpha/alpha.ts', 'alpha');
  const extras = await composeBriefExtras(graph, 'src/alpha/alpha.ts', data);
  expect(extras.logGateText).toBe('Log entry required before approve: yes (fresh entry present: no)');
});

it('names the flows the owning component participates in, and omits the line when it is in none', async () => {
  const graph = await loadGraph(FIXTURE);
  const data = buildFileContextData(graph, OWNED_FILE, 'orders/order-service');
  const extras = await composeBriefExtras(graph, OWNED_FILE, data);
  const flows = buildNodeContextData(graph, 'orders/order-service').flows;
  if (flows.length > 0) {
    expect(extras.flowsText).toBe(`Flows: ${flows.map((fl) => fl.name).join(' · ')}`);
  } else {
    expect(extras.flowsText).toBeUndefined();
  }
});

it('offers no log-gate or flows line for a file enforced by its type alone', async () => {
  // A type-covered file has no component, so neither fact exists to report.
  // Driven through the built binary over tests/fixtures/type-level-engine, the
  // same fixture tests/unit/cli/context-file-type-coverage.test.ts uses.
  const dir = copyTypeLevelFixture();
  try {
    const { stdout } = run(['context', '--file', 'src/leaf/a.ts', '--brief'], dir);
    expect(stdout).toContain('Owner: type:leaf');
    expect(stdout).not.toContain('Log entry required before approve');
    expect(stdout).not.toContain('Flows:');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

`buildNodeContextData` is imported from `../../../src/core/context-builder.js`; the flows
assertion reads the real fixture rather than hard-coding a name, so it cannot go stale if the
fixture gains a flow. (`orders/order-service` does belong to `checkout-flow` today, so the
`flows.length > 0` leg is the one that runs.) `copyTypeLevelFixture` is the same three-line
`mkdtempSync` + `cpSync` helper as `copyFixture`, pointed at `tests/fixtures/type-level-engine`,
whose `src/leaf/a.ts` renders `Owner: type:leaf` — the same file and fixture
`context-file-type-coverage.test.ts` already drives. The three spawned cases go inside the
`describe.skipIf(!distExists)` block; the flows case and its in-process log-gate twin sit outside
it, beside the other in-process cases.

- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement,** per the interface above.
- [ ] **Step 4: Run the suite; re-assert the ≤ 30-line budget and byte identity.**
- [ ] **Step 5: Update the node description, run the gate ritual, commit** —
  `feat(context): brief carries the owner's log-gate state and flow membership`

---

### Task 6: Progressive-mode scope marking (D2, D3, D6) — including the graph edit

**Files:**

- Modify: `source/cli/src/cli/build-context.ts`; `source/cli/src/formatters/context-file.ts`
  (full-view suffixes at BOTH aspect-header sites, D2);
  `.yggdrasil/model/cli/commands/build-context/yg-node.yaml` (**relations, `max_direct_relations`
  and description** — see Step 3b);
  `.yggdrasil/model/cli/tests/unit/cli/general/yg-node.yaml` (map the new test file **and** add
  `{ target: cli/tests/support, type: uses }`).
  `source/cli/src/cli/progressive-scope-resolve.ts` needs **no change**: its exported entry is
  already callable from any command (verified below).
- Test: `source/cli/tests/unit/cli/build-context-progressive.test.ts` (create)

**Interfaces — verified against the working tree, not assumed:**

- `resolveChangeScope(input: ChangeScopeInput): Promise<ChangeScopeDecision>` is the exact
  function `cli/check.ts:324` calls (`progressive-scope-resolve.ts:496`). Its input is
  `{ graph: Graph; projectRoot: string; coverageVisibleFiles: string[]; fullFlag: boolean }`.
  `build-context.ts` does **not** already hold `coverageVisibleFiles` on the node-owned `--file`
  path — it must produce it with `await walkRepoFiles(projectRoot)` (already imported, line 20).
  That is the same walk `computeTypeCoverageForContext` performs internally, so pass the result
  into the widened helper Task 4 introduces rather than walking the repo twice.
  `fullFlag: false` — `yg context` has no `--full`.
- `ChangeScopeDecision` is a three-way union (`progressive-scope-resolve.ts:100-121`):
  `{ kind: 'whole-project' }` (NO notice field), `{ kind: 'scoped'; burn: BurnSet; referenceName: string; blobOidByPath; notice?: IssueMessage }`,
  `{ kind: 'unmeasurable'; notice: IssueMessage }`. Handle all three by name (D3).
- `pairIsInScope(scope: BurnSet, aspectId: string, unitKey: string, known: ReadonlySet<string>): boolean`
  (`core/check-progressive.ts:110`) takes **four** arguments. The fourth is load-bearing: the
  function returns `true` for any pair NOT in `known` ("cannot attribute" is never read as "not
  touched"), so passing an empty set marks every rule `(yours)` and the feature silently does
  nothing. Build it from the same whole-graph enumeration Task 4 already computed:
  `const known = new Set(pairs.map((p) => progressivePairKey(p.aspectId, p.unitKey)))` — the
  identical derivation `knownPairKeys` performs, one layer up from `VerifiedPair`.
  `progressivePairKey` is imported from `../core/progressive-scope.js` (`:210`) rather than
  re-spelling `` `${aspectId} ${unitKey}` ``.
- `BurnSet` supplies the header's numbers directly (`core/progressive-scope.ts:276-337`):
  `burn.changedInputCount` (documented as "the number a person is shown as 'N changed file(s)'")
  and `burn.files: Set<string>` (repo-relative POSIX) for the in-it test.

**Produces:**

- One producer, two consumers. D2 puts the marking in the brief AND in the full view, and the
  full view never calls `composeBriefExtras`, so the measurement is factored into its own named
  export rather than duplicated — two derivations of the same sentence about the same file is
  exactly how the two views would come to disagree:

  ```ts
  export interface ScopeMarking {
    /** absent ⇒ no scope section (unmeasurable, or no reference configured) */
    scopeHeaderText?: string;
    scopeByAspect?: Map<string, 'yours' | 'inherited'>;
  }
  /**
   * Exported so both context views read ONE measurement; not part of the CLI surface.
   * `aspectIds` is the file's effective list (`data.aspects`, or `data.typeCoverage.applied`);
   * `pairs` and `repoFiles` are the SINGLE whole-graph enumeration and the SINGLE repo walk this
   * invocation already made (Task 4), never fresh ones. Prints the decision's `notice` to stderr
   * itself — one print site, as `cli/check.ts:335-341`'s own comment argues for.
   */
  export async function computeScopeMarking(
    graph: Graph,
    filePath: string,
    aspectIds: string[],
    pairs: ExpectedPair[],
    repoFiles: string[],
  ): Promise<ScopeMarking>;
  ```

  `composeBriefExtras` calls it and copies both fields into `FileBriefExtras`; BOTH full-view call
  sites call it and pass `scopeByAspect` to `formatFileContext` — the node-owned one at
  `build-context.ts:527` and the type-covered one at `:460`. Both, not one: D2's second suffix site
  (`context-file.ts:96`) is reachable only from `:460`, so wiring the node-owned call alone would
  leave it dead code and a type-covered file silently unmarked. `ExpectedPair` is imported as a type
  from `../core/pairs.js` (`pairs.ts:67`) — a type-only import, so no new relation.
- `graph.config.progressive?.reference !== undefined` gates the work, and the two callers gate at
  different depths because they already pay different prices. The brief path walks and enumerates
  regardless (Task 4's arm preview needs both), so for it the gate skips only this call. The
  full-view path enumerates nothing today, so it tests the reference FIRST and skips the walk, the
  enumeration and this call together — otherwise every plain `yg context --file` in a
  reference-less project would start paying for a whole-repo walk it has no use for.
  `computeScopeMarking` re-tests the condition defensively and returns `{}`. With a reference
  present:
  - `kind === 'scoped'`: `scopeHeaderText` =
    `your change so far: ${burn.changedInputCount} files; this file is ${burn.files.has(posixFile) ? 'in it' : 'not in it'}`
    (`1 file` singular), and `scopeByAspect` maps each of the file's aspects to `'yours'` when ANY
    pair carrying that `aspectId` whose `subjectFiles` include this file satisfies
    `pairIsInScope(burn, aspectId, unitKey, known)`, else `'inherited'`. When
    `decision.notice` is also set, print it (below).
  - `kind === 'unmeasurable'`: no `scopeHeaderText`, no `scopeByAspect`; print the notice.
  - `kind === 'whole-project'`: nothing at all — no header, no marking, no notice.
  - Printing a notice means, verbatim in the shape `cli/check.ts:335-341` uses:
    `process.stderr.write(chalk.yellow('Notice: ' + buildIssueMessage(decision.notice)) + '\n')`.
    stderr, so the ≤ 30-line stdout budget is untouched and a hook reading stdout is unaffected.
- In `context-file.ts`, `formatFileContext` widens to
  `export function formatFileContext(data: FileContextData, scopeByAspect?: ReadonlyMap<string, 'yours' | 'inherited'>): string`
  and appends ` (yours)` / ` (inherited)` at **both** aspect-header sites — the node-owned line at
  `:139` and the type-covered line at `:96`. Omitted argument ⇒ byte-identical output, which is
  what makes the pin below meaningful, and every existing call site keeps compiling unchanged.

- [ ] **Step 1: Write the failing tests** over real git repositories — there is **no injection
  seam** into `resolveChangeScope` (it shells to git), and the `burn()` helper in
  `tests/unit/core/check-progressive.test.ts:28` builds a `BurnSet` by hand for direct
  `pairIsInScope` calls only; it cannot be threaded through the CLI, and fabricating one would
  break the repo's no-artificial-mocking rule. Use `createProgressiveFixture` exactly as
  `tests/e2e/cli-progressive-gate.test.ts` does. The new file repeats the same six-line preamble
  Task 2's file established — `BIN_PATH`, `distExists`, `run()`, the `fixtures[]` array and its
  `afterEach` cleanup — and every spawned case below sits inside a
  `describe.skipIf(!distExists)` block, so the suite fails loudly on a missing build rather than
  passing over zero cases. `'main'` is `REFERENCE_BRANCH`, exported by the fixture module; import
  it rather than re-typing the literal:

```ts
import { createProgressiveFixture, REFERENCE_BRANCH, type ProgressiveFixture } from '../../support/progressive-fixture.js';

it('marks a rule on a file the change touched as yours', () => {
  const f = createProgressiveFixture({ label: 'ctx-in', progressiveReference: REFERENCE_BRANCH });
  fixtures.push(f);
  f.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
  const { stdout, status } = run(['context', '--file', 'src/alpha/alpha.ts', '--brief'], f.dir);
  expect(status).toBe(0);
  expect(stdout).toContain('your change so far: 1 file; this file is in it');
  expect(stdout).toMatch(/no-todo-comments.*\(yours\)/);
});

it('marks a rule on a file the change left alone as inherited', () => {
  const f = createProgressiveFixture({ label: 'ctx-out', progressiveReference: REFERENCE_BRANCH });
  fixtures.push(f);
  f.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
  const { stdout } = run(['context', '--file', 'src/beta/beta.ts', '--brief'], f.dir);
  expect(stdout).toContain('this file is not in it');
  expect(stdout).toMatch(/no-todo-comments.*\(inherited\)/);
});

it('says nothing about scope when the reference cannot be resolved, and explains why on stderr', () => {
  const f = createProgressiveFixture({ label: 'ctx-unmeasurable', progressiveReference: 'origin/never-fetched' });
  fixtures.push(f);
  const { stdout, stderr, status } = run(['context', '--file', 'src/alpha/alpha.ts', '--brief'], f.dir);
  expect(status).toBe(0);
  expect(stdout).not.toContain('your change so far');
  expect(stdout).not.toContain('(yours)');
  expect(stdout).not.toContain('(inherited)');
  expect(stderr).toContain('Notice:');
  expect(stderr).toContain('origin/never-fetched');
});

it('adds no scope marking and no notice to a project that named no reference', () => {
  const f = createProgressiveFixture({ label: 'ctx-optout' });   // no progressiveReference
  fixtures.push(f);
  const full = run(['context', '--file', 'src/alpha/alpha.ts'], f.dir);
  expect(full.status).toBe(0);
  expect(full.stdout).not.toContain('(yours)');
  expect(full.stdout).not.toContain('(inherited)');
  expect(full.stdout).not.toContain('your change so far');
  expect(full.stderr).not.toContain('Notice:');
});
```

Add in-process cases for the `'yours'` / `'inherited'` mapping itself so the branch is covered by
the coverage gate — and load them from a **progressive fixture**, not from
`tests/fixtures/sample-project`: that fixture names no reference, so `composeBriefExtras` over it
short-circuits before `resolveChangeScope` and would cover the opt-out branch only. The shape is
`const f = createProgressiveFixture({ label: 'ctx-inproc', progressiveReference: REFERENCE_BRANCH });`,
then `f.branchWithEdit(...)`, then `await loadGraph(f.dir)` and `composeBriefExtras` against it —
a real on-disk graph in a real git repository, so no rule about fabricated data is bent.

- [ ] **Step 2: Run, verify failures.**

- [ ] **Step 3a: Implement** `computeScopeMarking` — the resolver call (guarded on the config
  reference), the three-way `kind` switch, the `known` set, the `scopeByAspect` mapping and the
  single notice print — then wire its consumers: `composeBriefExtras`, and both full-view call
  sites (`:527` node-owned, `:460` type-covered), each feeding its own suffix site in
  `context-file.ts` (`:139` and `:96`).

- [ ] **Step 3b: Update the graph — this task cannot pass `yg check` without it.**
  `build-context.ts` now statically imports two modules it never did:
  `cli/progressive-scope-resolve.ts` (node `cli/progressive-scope-resolve`, type
  `command-support`) and `core/progressive-scope.ts` (node `cli/core/progressive-scope`, type
  `engine`). `core/check-progressive.ts` belongs to `cli/core/check`, which is already declared.
  In `.yggdrasil/model/cli/commands/build-context/yg-node.yaml`:
  - add `- target: cli/progressive-scope-resolve` / `type: calls` and
    `- target: cli/core/progressive-scope` / `type: calls`. Both are permitted by the
    architecture: the `command` type's `relations.calls` list includes `command-support` and
    `engine` — no `yg-architecture.yaml` edit, and therefore no owner confirmation, is needed.
  - raise `max_direct_relations.limit` from **21 to 23** and extend its `reason:` prose — the node
    sits exactly at its reviewed ceiling today, so without this the run fails on the quality
    ceiling rather than on an undeclared dependency. The added reason must state the real cause:
    the context view now answers what a change is accountable for using the same measurement
    `yg check` gates on, which means reaching the scope resolver and the burn-set key helper
    rather than re-deriving either.
  - extend `description:` with the scope-marking behavior and the three-way honesty rule (D3).

  In `.yggdrasil/model/cli/tests/unit/cli/general/yg-node.yaml`: add
  `source/cli/tests/unit/cli/build-context-progressive.test.ts` to `mapping:` and
  `{ target: cli/tests/support, type: uses }` to `relations:` (28 declared today against a
  `max_direct_relations.limit` of 30, so 29 needs no ceiling edit). If Task 4 already added that
  relation for `build-context-brief.test.ts`, only the mapping line is new.

- [ ] **Step 4: Run the new suite, the Task 2–5 suites — Task 2's committed-baseline pin is the
  byte-identity assertion for this task too, and the widened `formatFileContext` signature is
  exactly what it guards — and `npx vitest run tests/unit/core/check-progressive.test.ts` (must be
  untouched).**

- [ ] **Step 5: Gate ritual, commit** —
  `feat(context): progressive scope marking — yours vs inherited, honest fallbacks`

---

### Task 7: Docs + CHANGELOG

**Files:**

- Modify: `docs/cli-reference.md` (the `yg context` section beginning at line 23: `--brief`,
  `--aspect`, the arm preview, scope marking, with one rendered brief example), `docs/progressive-mode.md`
  (a short "In `yg context`" subsection tying the marking to the measurement states table),
  `CHANGELOG.md` (`## [Unreleased]` → `### Added`)
- Test: none — the gate's docs and markdown steps cover it.

Also correct one sentence already in that section while it is open: it says `--file` "Prints
owner mapping to stderr", but `build-context.ts:489` writes `<file> -> <node>` to **stdout**.
The brief's line budget is measured over stdout, so the docs and the budget must agree. And the
paragraph at `docs/cli-reference.md:69-74` — the advisory structural-attention line — gains the
one clause D8 makes true: it ends the `--file` view in its default, full form only, not the
compact or single-rule views.

- [ ] **Step 1: Write the docs sections.** The rendered brief example is COPIED from a real run
  (`node source/cli/dist/bin.js context --file <a real repo file> --brief`), never hand-typed.
  The CHANGELOG entry is one entry for the whole increment, in release-notes voice: what an
  adopter can now do and why it matters — not a task list and not a method log.
- [ ] **Step 2: Run the gate's own docs steps, with their exact commands** (from
  `scripts/repo-check.sh:126-127`):

  ```sh
  (cd docs && npm run build)
  npx markdownlint-cli2 "**/*.md" ".markdownlint-cli2.jsonc"     # from the repo root
  ```

- [ ] **Step 3: Commit** — `docs(context): layered context — brief, expansion, arm preview, scope marking`

---

## Self-Review (performed at plan-writing time, against the working tree)

- **Spec coverage:** C1 — brief T1/T2, `--aspect` expansion T3, trail pointers T1/T2, ≤ 30 lines
  T1 (arithmetic in Global Constraints, asserted at the 8-aspect cap), one-hop relations T1,
  **log-gate state and flows T5** (§C1 names both; omitting them would be a silent descope, which
  §6.8 of the strategic plan forbids), full dump remains the default and is pinned T2/T6.
  C2 — yours/inherited T6, scope header T6, honest fallback T6 (D3 covers all three decision
  kinds, including `whole-project`, which carries no notice), arm preview T4,
  measurement reused rather than re-derived T6 (`resolveChangeScope` + `pairIsInScope`, never a
  second copy of either). One deviation from §C1's sketch is recorded rather than taken silently
  (D7, the third trail pointer). C3 (roots conventions) is NOT here — §5's increment order lands
  it in increment 8 with R7/R8. MCP consumption is the plugin increment; T1's pure renderer is
  the seam it calls.
- **API truth:** every symbol, field and line reference above was read from the working tree.
  Three claims an earlier draft made were false and are corrected here: `pairIsInScope` takes a
  fourth `known` argument whose omission silently marks everything `(yours)`; the resolver's
  message field is `notice: IssueMessage` on two of three kinds, not a one-line string on all
  three; and `FileContextAspect.source` has no producer, so `--aspect` renders no `Source:` line.
  The fixture facts T2/T4/T5 assert on were re-derived by running the engines, not read off the
  YAML: `orders/order-service` maps exactly `src/orders/order.service.ts`, carries exactly two
  pairs (`requires-audit` and the `requires-logging` it implies, both `kind: 'llm'`, both
  per-node), has parent `orders`, and participates in `checkout-flow`.
- **Gate reality:** three separate mandatory graph edits, not one. (a) T6 Step 3b's relation +
  ceiling raise on `cli/commands/build-context` — the node sits at exactly its declared
  21-relation ceiling today. (b) Every new test file must be named in a test-suite node's
  `mapping:`; `test-suite` is `enforce: strict` and an unmapped file is a blocking
  `type-strict-orphan`, confirmed by running the real binary against a throwaway file. (c) The
  `cli/tests/support` relation for `progressive-fixture.ts`. Beyond the graph: the `command`
  type's `log_required: true` makes a `yg log add` part of every `build-context.ts` commit;
  `repo-check.sh`'s closing `check --approve --only-deterministic` does not refill the LLM pairs
  these edits invalidate (`what-why-next`, `deterministic`, `posix-paths-output`,
  `cli-command-contract`, `diagnostic-logging`, and each new file's `test-deterministic`) — hence the per-commit
  ritual; and `check --approve` is keyless here because the `standard` tier's provider is
  `claude-code`, read from `.yggdrasil/yg-config.yaml`. Commits are per task; no step commits.
- **Placeholder scan:** clean. Every "mirror file X" pointer was opened and verified to contain
  the pattern it is cited for: `tests/unit/core/context-builder.test.ts` (in-process `loadGraph`
  over `tests/fixtures/sample-project`), `tests/unit/cli/context-file-type-coverage.test.ts`
  (`copyFixture` + `spawnSync` on `dist/bin.js`), `tests/support/progressive-fixture.ts`
  (`createProgressiveFixture`, real git). The earlier draft's two pointers were removed as
  placeholders: `tests/unit/cli/build-context.test.ts` contains no fixture setup at all (20 lines
  asserting option registration), and `tests/unit/core/check-progressive.test.ts`'s `burn()`
  helper cannot be threaded into a CLI run.
- **Type consistency:** `FileBriefExtras` names match between T1 (producer) and T2/T4/T5/T6
  (consumers); `'inherited'` is both the map value and the rendered word, so there is no
  second mapping to drift. `ScopeMarking.scopeByAspect` (T6) is the same `Map<string, 'yours' |
  'inherited'>`, assignable straight into `FileBriefExtras` and into `formatFileContext`'s
  `ReadonlyMap` parameter, so the brief and the full view cannot disagree about one file. Both `Map` literals in T1's tests were compiled against a strict
  `tsc` to confirm the contextual `'yours' | 'inherited'` inference holds — `tsconfig.check.json`
  typechecks `tests/**/*.ts`, so a widened `Map<string, string>` there would fail the gate's
  first step, not merely read oddly.
- **Line budget:** the worst-case arithmetic in Global Constraints was recomputed line by line
  against T1 Step 3's implementation and against T1's own 8-aspect assertion: the RENDERER
  returns 28 lines at the cap, 29 with the truncation tail. The two assertions measure different
  things and must not be conflated — T1's is over the renderer's return value (28/29), T2's and
  T4–T6's are over spawned stdout, which carries the command's extra `<file> -> <node>`
  resolution line (29/30). Both stay inside 30; the stdout side has no headroom left at the tail.
  The third stdout writer on that path — the advisory attention note, two lines — is the reason
  D8 exists: left running under `--brief` it would put a real invocation at 32 on a file the
  attention index happens to name, so it is suppressed there and kept on the full view.
