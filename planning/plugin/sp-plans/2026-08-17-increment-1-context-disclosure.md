# Increment 1: `yg context` Progressive Disclosure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** `yg context --file` gains a layered mode — `--brief` (≤30 lines, one line per rule,
trail pointers), `--aspect <id>` single-rule expansion, an arm preview (how many pairs an edit
would invalidate, free vs reviewer-billed), and progressive-mode scope marking (yours vs
inherited) — leaving the default full output byte-identical.

**Architecture:** All new behavior is additive flags on the existing `yg context` command. A new
pure renderer `formatFileContextBrief` sits beside `formatFileContext` in
`formatters/context-file.ts`; `cli/build-context.ts` assembles two new data fields (armPreview,
scopeMarking) reusing existing engines read-only: `computeExpectedPairs` (already imported there)
for the arm preview, and the progressive resolver (`cli/progressive-scope-resolve.ts` →
`core/check-progressive.ts#pairIsInScope`) for scope marking. No engine module changes; no lock,
no reviewer, no writes.

**Tech Stack:** TypeScript (strict, no exported `any`), vitest unit tests under
`source/cli/tests/unit/`, existing fixture-graph helpers used by
`tests/unit/cli/build-context.test.ts`.

**Spec:** `planning/plugin/2026-08-17-plugin-marketplace-plan.md` §PART C (C1, C2) — with
`docs/progressive-mode.md` (branch base) as the authority on measurement semantics, and
`source/cli/src/formatters/context-file.ts` as the authority on current output shapes.

## Global Constraints

- `scripts/repo-check.sh` green before every commit (the pre-commit hook enforces it; never
  bypass it, never `--no-verify`).
- Default `yg context --file <p>` output stays **byte-identical** when none of the new flags is
  passed and the project has no `progressive:` block — pinned by test in Task 5.
- Formatters render already-decided text; business decisions live in the caller
  (`build-context.ts`) — same division the file's own comments mandate.
- Engine layers (`core/`, `io/`, `ast/`) must not call `buildIssueMessage` and must not import
  `node:fs` directly (enforced aspects `no-buildissuemessage-in-engine`, `no-direct-fs`).
- All output paths through `toPosixPath` (aspect `posix-paths-output`).
- No `Date.now()`/`Math.random()`/`process.env` in engine files (aspect `no-nondeterminism-direct`).
- Brief output ≤ 30 lines for a node-owned file with ≤ 8 aspects; when it would exceed, the aspect
  list is truncated with a final line `  … and N more — run yg context --file <p> for all`.
- Coverage stays ≥ 90 % (gate step); every new branch gets a test.
- One CHANGELOG entry under `## [Unreleased]` for the whole increment (Task 6), release-notes
  voice.
- `templates/rules.ts` is deliberately NOT edited in this increment (decision D1 below).
- New CLI flags are registered in the same commander style `build-context.ts` already uses;
  errors follow what/why/next via `buildIssueMessage` in the CLI layer only.

**Decisions binding this plan:**
- **D1:** The agent manual keeps teaching plain `yg context --file`; `--brief` enters the manual
  in the plugin increment (its consumer), avoiding a second digest regeneration cycle now.
- **D2:** Scope marking appears in BOTH the brief and the full view (one line per aspect suffix
  `(yours)` / `(outside changes)` in full view's header lines), because the measurement is free
  once resolved and hiding it in one view invites contradiction.
- **D3:** When the change scope cannot be measured (any resolver fallback state), context prints
  the same one-line notice `yg check` prints for that state and omits per-aspect marking — never
  guesses. Reuses the resolver's decision, never re-derives.
- **D4:** Arm preview counts pairs from `computeExpectedPairs` whose `subjectFiles` contain the
  file (post-`scope.files` filtering, so it is the true invalidation set), split by
  `kind: 'llm' | 'deterministic'`; consensus multipliers are NOT applied (the preview says
  "reviewer pairs", not a bill — `yg check --approve --dry-run` remains the priced quote, and the
  preview line names it).

---

### Task 1: Brief renderer (`formatFileContextBrief`) with trail pointers

**Files:**
- Modify: `source/cli/src/formatters/context-file.ts`
- Test: `source/cli/tests/unit/formatters/context-file-brief.test.ts` (create)

**Interfaces:**
- Consumes: existing `FileContextData`, `FileContextAspect` (unchanged).
- Produces:
  ```ts
  export interface FileBriefExtras {
    /** "editing this file invalidates N pairs (M free / K reviewer pairs)" — pre-rendered by the caller; absent → line omitted */
    armPreviewText?: string;
    /** one line per state, pre-rendered (D3) — absent → no scope section */
    scopeHeaderText?: string;
    /** aspectId → 'yours' | 'outside' (only when measured) */
    scopeByAspect?: Map<string, 'yours' | 'outside'>;
    /** up to 3 pre-rendered "next:" lines */
    nextPointers: string[];
  }
  export function formatFileContextBrief(data: FileContextData, extras: FileBriefExtras): string;
  ```
  Later tasks rely on exactly these names.

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
    { aspectId: 'what-why-next', aspectDescription: 'Diagnostics use the what/why/next structure via the shared builder. Second sentence is dropped.', verifiedAgainst: '.yggdrasil/aspects/what-why-next/content.md', status: 'enforced' },
    { aspectId: 'no-direct-db', aspectDescription: 'Handlers never reach the data store directly.', verifiedAgainst: '.yggdrasil/aspects/no-direct-db/check.mjs', status: 'advisory' },
  ],
  dependencies: [{ path: 'core/db', consumed: ['calls'] }],
  dependentCount: 3,
};

describe('formatFileContextBrief', () => {
  it('renders one line per aspect: [status] id — first sentence + read path', () => {
    const out = formatFileContextBrief(base, { nextPointers: [] });
    expect(out).toContain('src/app/handler.ts');
    expect(out).toContain('Owner: app/handler (command)');
    expect(out).toContain('[enforced] what-why-next — Diagnostics use the what/why/next structure via the shared builder.');
    expect(out).not.toContain('Second sentence');
    expect(out).toContain('read: .yggdrasil/aspects/what-why-next/content.md');
    expect(out).toContain('[advisory] no-direct-db — Handlers never reach the data store directly.');
  });

  it('appends scope suffixes and header when provided', () => {
    const out = formatFileContextBrief(base, {
      nextPointers: [],
      scopeHeaderText: 'your change so far: 2 files; this file is in it',
      scopeByAspect: new Map([['what-why-next', 'yours'], ['no-direct-db', 'outside']]),
    });
    expect(out).toContain('your change so far: 2 files; this file is in it');
    expect(out).toMatch(/what-why-next.*\(yours\)/);
    expect(out).toMatch(/no-direct-db.*\(outside changes\)/);
  });

  it('renders arm preview and next pointers when provided', () => {
    const out = formatFileContextBrief(base, {
      armPreviewText: 'editing this file invalidates 4 pairs (3 free / 1 reviewer pair) — price a fill: yg check --approve --dry-run',
      nextPointers: ['next: yg log read --node app/handler', 'next: yg context --node app', 'next: yg context --file src/app/handler.ts --aspect no-direct-db'],
    });
    expect(out).toContain('invalidates 4 pairs (3 free / 1 reviewer pair)');
    const idx = out.indexOf('next: yg log read');
    expect(idx).toBeGreaterThan(-1);
    expect(out.indexOf('next: yg context --node app')).toBeGreaterThan(idx);
  });

  it('truncates beyond 8 aspects with an honest tail line', () => {
    const many = { ...base, aspects: Array.from({ length: 11 }, (_, i) => ({
      aspectId: `rule-${i}`, aspectDescription: `Rule ${i} does a thing.`,
      verifiedAgainst: `.yggdrasil/aspects/rule-${i}/check.mjs`, status: 'enforced' as const })) };
    const out = formatFileContextBrief(many, { nextPointers: [] });
    expect(out).toContain('rule-7');
    expect(out).not.toContain('rule-8 ');
    expect(out).toContain('… and 3 more — run yg context --file src/app/handler.ts for all');
  });

  it('stays within 30 lines for ≤8 aspects with all extras present', () => {
    const out = formatFileContextBrief(base, {
      armPreviewText: 'editing this file invalidates 4 pairs (3 free / 1 reviewer pair) — price a fill: yg check --approve --dry-run',
      scopeHeaderText: 'your change so far: 2 files; this file is in it',
      scopeByAspect: new Map(),
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
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd source/cli && npx vitest run tests/unit/formatters/context-file-brief.test.ts`
Expected: FAIL — `formatFileContextBrief` is not exported.

- [ ] **Step 3: Implement `formatFileContextBrief` in `context-file.ts`**

Append (exports at end of file; helper local):

```ts
export interface FileBriefExtras {
  armPreviewText?: string;
  scopeHeaderText?: string;
  scopeByAspect?: Map<string, 'yours' | 'outside'>;
  nextPointers: string[];
}

const BRIEF_ASPECT_CAP = 8;

function firstSentence(text: string): string {
  const m = /^.*?[.!?](?=\s|$)/.exec(text.trim());
  return (m ? m[0] : text.trim()).trim();
}

function briefAspectLine(a: FileContextAspect, scope?: 'yours' | 'outside'): string[] {
  const caveat = a.unverified ? ', unverified' : '';
  const suffix = scope === 'yours' ? ' (yours)' : scope === 'outside' ? ' (outside changes)' : '';
  return [
    `  [${a.status ?? 'enforced'}${caveat}] ${a.aspectId} — ${firstSentence(a.aspectDescription)}${suffix}`,
    `    read: ${posixPath(a.verifiedAgainst)}`,
  ];
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
  }
  if (extras.scopeHeaderText) lines.push(`  ${extras.scopeHeaderText}`);
  const aspects = data.ownerPath ? data.aspects : (data.typeCoverage?.applied ?? []);
  if (aspects.length > 0) {
    lines.push('  Must satisfy:');
    for (const a of aspects.slice(0, BRIEF_ASPECT_CAP)) {
      lines.push(...briefAspectLine(a, extras.scopeByAspect?.get(a.aspectId)));
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
  for (const p of extras.nextPointers.slice(0, 3)) lines.push(`  ${p}`);
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd source/cli && npx vitest run tests/unit/formatters/context-file-brief.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Typecheck + commit**

Run: `cd source/cli && npm run typecheck`
Then: `git add source/cli/src/formatters/context-file.ts source/cli/tests/unit/formatters/context-file-brief.test.ts && git commit -m "feat(context): brief renderer with scope suffixes, arm preview and trail pointers"`
(The pre-commit gate runs the full repo check; expect several minutes.)

---

### Task 2: `--brief` flag wiring in `build-context.ts` (node-owned + type-covered + unmapped)

**Files:**
- Modify: `source/cli/src/cli/build-context.ts`
- Test: `source/cli/tests/unit/cli/build-context-brief.test.ts` (create; mirror the fixture-graph
  setup used in `tests/unit/cli/build-context.test.ts` — copy its graph-construction helper usage
  verbatim rather than inventing a new fixture style)

**Interfaces:**
- Consumes: `formatFileContextBrief`, `FileBriefExtras` (Task 1).
- Produces: `yg context --file <p> --brief` CLI behavior; internal helper
  `composeBriefExtras(...): FileBriefExtras` exported from `build-context.ts` **for tests only**
  (named export, marked `/** exported for tests */`), assembling `nextPointers`:
  1. `next: yg log read --node <ownerPath>` (only when owner exists),
  2. `next: yg context --node <parent-of-owner>` (only when the owner has a parent node),
  3. `next: yg context --file <p> --aspect <first-aspect-id>` (only when ≥1 aspect).

- [ ] **Step 1: Write the failing test** — drive the command function directly (same entry the
  existing `build-context.test.ts` uses), assert: `--brief` output contains `Must satisfy:` line
  count ≤ 30, contains the three `next:` pointers for a node-owned file with parent and aspects,
  and that WITHOUT `--brief` the output is exactly the current full format (snapshot equality
  against a captured pre-change run stored in the test as a string built from the SAME fixture —
  build the fixture, run current formatter, store expected inline).
- [ ] **Step 2: Run it, verify failure** (`--brief` unknown option).
- [ ] **Step 3: Implement**: register `.option('--brief', 'compact one-line-per-rule view')` and
  `.option('--aspect <id>', 'expand one rule in full')` (registration only here; `--aspect`
  behavior lands in Task 3 — until then, passing it prints the full view unchanged); in the
  `--file` branch, when `opts.brief` is set, call `composeBriefExtras` + `formatFileContextBrief`
  instead of `formatFileContext`. Type-covered and unmapped files route through the same brief
  renderer (Task 1 already handles their shapes).
- [ ] **Step 4: Run the new test + the existing `build-context.test.ts`, verify both pass.**
- [ ] **Step 5: Commit** — `feat(context): --brief flag renders the compact layered view`

---

### Task 3: `--aspect <id>` single-rule expansion

**Files:**
- Modify: `source/cli/src/cli/build-context.ts`, `source/cli/src/formatters/context-file.ts`
- Test: extend `source/cli/tests/unit/cli/build-context-brief.test.ts`

**Interfaces:**
- Produces: `formatFileContextAspect(data: FileContextData, aspectId: string): string` in
  `context-file.ts` — the one aspect's full description (untruncated), status, `read:` lines
  (rule source + every reference + companion path), and `Source:` when implied; unknown id →
  the CLI prints a what/why/next error via `buildIssueMessage` (WHAT: aspect not found on this
  file; WHY: the id must be one of the file's effective aspects; NEXT: `yg context --file <p>
  --brief` to list them) and exits 1.

- [ ] **Step 1: Failing tests** — (a) expansion contains the FULL multi-sentence description
  (assert the second sentence Task 1's brief dropped IS present) and every reference `read:`
  line; (b) unknown aspect id exits non-zero and the message contains all three what/why/next
  members.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** renderer + CLI branch (`--aspect` implies single-aspect view; combined
  with `--brief`, `--aspect` wins — document in the option help string).
- [ ] **Step 4: Verify pass** (new + existing tests).
- [ ] **Step 5: Commit** — `feat(context): --aspect expands a single rule in full`

---

### Task 4: Arm preview

**Files:**
- Modify: `source/cli/src/cli/build-context.ts`
- Test: extend `source/cli/tests/unit/cli/build-context-brief.test.ts`

**Interfaces:**
- Consumes: `computeExpectedPairs` (already imported in `build-context.ts`), `ExpectedPair.kind`,
  `ExpectedPair.subjectFiles`.
- Produces: inside `composeBriefExtras`, the `armPreviewText`:
  `editing this file invalidates N pairs (M free / K reviewer pairs) — price a fill: yg check --approve --dry-run`
  where N = pairs whose `subjectFiles` include the (posix-normalized) file, M = those with
  `kind === 'deterministic'`, K = with `kind === 'llm'`. When N = 0 the line is omitted (a brief
  must not carry a zero-information line). Draft-status pairs never appear (computeExpectedPairs
  already excludes them — do not re-filter).

- [ ] **Step 1: Failing test** — fixture with one deterministic per-node aspect and one LLM
  per-file aspect covering the file: expect `invalidates 2 pairs (1 free / 1 reviewer pair)`;
  second fixture where the file matches no pair: expect NO `invalidates` line.
- [ ] **Step 2: Verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `feat(context): arm preview counts the pairs an edit would invalidate`

---

### Task 5: Progressive-mode scope marking (D2, D3)

**Files:**
- Modify: `source/cli/src/cli/build-context.ts`, `source/cli/src/formatters/context-file.ts`
  (full-view suffixes only — one-line change per aspect header), `source/cli/src/cli/progressive-scope-resolve.ts`
  (ONLY if its entry function needs an options widening to be callable without check-specific
  inputs; prefer zero changes — read its `ChangeScopeInput` first and construct it from what
  `build-context.ts` already loads)
- Test: `source/cli/tests/unit/cli/build-context-progressive.test.ts` (create); byte-identity
  pin: extend `build-context-brief.test.ts` with a no-progressive-config fixture asserting the
  full view equals the pre-change snapshot string.

**Interfaces:**
- Consumes: `resolveProgressiveScope` (or the resolver's exported entry — use the exact function
  `cli/check.ts` calls; read that call site first and mirror it), `pairIsInScope` from
  `core/check-progressive.ts`, `computeExpectedPairs` output from Task 4.
- Produces: in `composeBriefExtras` (and a full-view variant): when the committed config carries
  `progressive.reference` AND the resolver returns a measured decision, `scopeHeaderText` =
  `your change so far: <changedCount> files; this file is <in it|not in it>` and `scopeByAspect`
  maps each of the file's aspects to `'yours'` when ANY of its pairs (from Task 4's set,
  filtered to this file) satisfies `pairIsInScope`, else `'outside'`. When the resolver returns
  any non-measured state: `scopeHeaderText` = the same notice sentence `yg check` prints for that
  state (reuse the resolver's own message field — do not re-word), and `scopeByAspect` absent.
  No `progressive:` block → no scope section at all and byte-identical output (pinned).

- [ ] **Step 1: Failing tests** — three fixtures: (a) measured, file inside the change → header
  `in it`, aspect suffix `(yours)`; (b) measured, file outside → `(outside changes)` suffixes;
  (c) no progressive block → byte-identical full view, no header. Build (a)/(b) the way
  `tests/unit/core/check-progressive.test.ts` builds its scope inputs — reuse its helpers/mocks
  for the changed-file set rather than shelling out to real git in a unit test.
- [ ] **Step 2: Verify failures.** — [ ] **Step 3: Implement** (resolver call guarded by config
  presence; all failure states flow through D3). — [ ] **Step 4: Verify pass + existing
  progressive tests untouched (`npx vitest run tests/unit/core/check-progressive.test.ts`).**
- [ ] **Step 5: Commit** — `feat(context): progressive scope marking — yours vs inherited, honest fallbacks`

---

### Task 6: Docs + CHANGELOG

**Files:**
- Modify: `docs/cli-reference.md` (the `yg context` section: `--brief`, `--aspect`, arm preview,
  scope marking, with one rendered example of the brief), `docs/progressive-mode.md` (a short
  "In `yg context`" subsection linking the marking to the measurement semantics),
  `CHANGELOG.md` (`## [Unreleased]` → `### Added`, one entry covering the increment,
  release-notes voice: what an adopter can now do, not the task list)
- Test: none (docs build is a gate step; `npm run docs:build` locally if present — check
  `package.json` scripts and run the gate's docs step command)

- [ ] **Step 1: Write the docs sections** (concrete rendered example copied from a real fixture
  run, not hand-typed).
- [ ] **Step 2: Run the markdown lint + docs build steps** from `scripts/repo-check.sh` locally.
- [ ] **Step 3: Commit** — `docs(context): layered context — brief, expansion, arm preview, scope marking`

---

## Self-Review (performed at plan-writing time)

- **Spec coverage:** C1 (brief ✅ T1/T2, expansion ✅ T3, trail pointers ✅ T1/T2, ≤30 lines ✅ T1,
  full dump default ✅ T2/T5 pins); C2 (yours/inherited ✅ T5, scope header ✅ T5, honest
  fallback D3 ✅ T5, arm preview ✅ T4, measurement reuse-not-rederive ✅ T5). C3 (roots
  conventions) is NOT here — it belongs to the roots increments by the strategic plan's §5 graph.
  MCP consumption is the plugin increment; T1's pure renderer is the seam it will call.
- **Placeholder scan:** clean — every step has code, exact commands, or an exact source pointer
  to mirror (`check-progressive.test.ts` helpers, `build-context.test.ts` fixture style).
- **Type consistency:** `FileBriefExtras` names match between T1 (producer) and T2/T4/T5
  (consumers); `'outside'` map value renders as `(outside changes)` — one mapping, in T1's
  renderer only.
