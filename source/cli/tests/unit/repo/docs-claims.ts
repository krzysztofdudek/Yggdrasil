// The invariants the docs sell, each tied to the sentence that sells it and to
// the test that holds the CLI to it — the register the guard in
// docs-claims.test.ts checks, and the list the wording policy
// (absolute-wording.test.ts) reads to tell a backed absolute from an unbacked
// one. Reads nothing and writes nothing.
//
// A claim is kept honest from both ends: its quote must still be on its page
// (a reworded sentence drops the claim, and the register says so), and its
// test must still exist and cite that page and quote in a `// Claim (docs/…):`
// comment above it, so a reader of either finds the other.

/** One invariant the docs state, the sentence stating it, and the tests holding the CLI to it. */
export interface DocsClaim {
  /** A stable name for the invariant. */
  id: string;
  /** The page, relative to the repository root. */
  page: string;
  /** A sentence of the page, as it reads there (line breaks read as spaces). */
  quote: string;
  /** The tests that hold it: a file under source/cli/tests/ and the test's title as its source spells it. */
  tests: Array<{ file: string; title: string }>;
}

export const DOCS_CLAIMS: DocsClaim[] = [
  {
    id: 'log-gate-scope',
    page: 'docs/cli-reference.md',
    quote: 'A changed component the run fills nothing of does not stop it, and stays a `log-entry-missing` error on the plain read.',
    tests: [
      { file: 'e2e/cli-log-gate-scope.test.ts', title: 'a changed component the fill fills nothing of stays red but does not stop the fill' },
      { file: 'e2e/cli-log-gate-scope.test.ts', title: 'a change to the component’s own source owes an entry, and the fill stops before recording anything' },
    ],
  },
  {
    id: 'free-runs-leave-committed-files',
    page: 'docs/cli-reference.md',
    quote: 'running it rematerializes the cache for free and clears them, without a key and without touching a committed file.',
    tests: [{ file: 'e2e/cli-aspects-log.test.ts', title: '9: the free CI step and a bare check leave every committed file as it was, even over a standing changed by hand' }],
  },
  {
    id: 'approve-refuses-over-conflicted-log',
    page: 'docs/the-lock.md',
    quote: 'Until the log is reconciled, `yg check --approve` refuses to run (`log-conflict`)',
    tests: [{ file: 'e2e/cli-log-integrity-extended.test.ts', title: '2h: --approve over a conflicted log.md stops before any fill and records nothing (exit 1)' }],
  },
  {
    id: 'merge-recipe-ends-green',
    page: 'docs/the-lock.md',
    quote: 'When a committed lock file conflicted *as well*, the order is: take one side of the lock file, then `merge-resolve` each conflicted log, then commit, then `yg check --approve`.',
    tests: [{ file: 'e2e/cli-log-gate-scope.test.ts', title: 'the merge recipe ends green — $label' }],
  },
  {
    id: 'marketplace-check-implies-install',
    page: 'docs/packages.md',
    quote: 'so a package the check passes is one that installs.',
    tests: [{ file: 'e2e/cli-marketplace-install-parity.test.ts', title: 'CLI E2E — marketplace check passes ⇒ pack add installs' }],
  },
  {
    id: 'pack-list-verify-agree-with-check',
    page: 'docs/packages.md',
    quote: '"copy changed" for exactly what `yg check` blocks — an edited or missing file, or a file the package never installed.',
    tests: [
      { file: 'e2e/cli-pack-lifecycle.test.ts', title: '5b: a file the package never installed — dot-named or not — makes list, verify and check agree, and a reinstall names what it deletes' },
      { file: 'e2e/cli-pack-lifecycle.test.ts', title: '5d: a file outside every installation is named by list and fails verify, as check blocks it' },
    ],
  },
  {
    id: 'impact-type-gap-is-check-strict',
    page: 'docs/cli-reference.md',
    quote: 'computed by the same scan `yg check` runs. Before the flag is set the gap is labelled a preview of what setting it would report.',
    tests: [{ file: 'e2e/cli-impact-strict-preview.test.ts', title: 'lists, before the flag is set, the orphans and misplaced files check reports after' }],
  },
  {
    id: 'impact-node-flows-are-context-flows',
    page: 'docs/cli-reference.md',
    quote: 'Its flows are the ones `yg context --node` lists for the same node: every flow that names the node or one of its ancestors.',
    tests: [{ file: 'e2e/cli-flow-channel5.test.ts', title: '7: yg impact --node and yg context --node name the same flows, for a participant and for its descendant' }],
  },
  {
    id: 'drill-add-measures-or-refuses',
    page: 'docs/cli-reference.md',
    quote: 'Nothing is written when the file is one the drill never runs as a case',
    tests: [
      { file: 'e2e/cli-drill-add.test.ts', title: '9: a file the drill never runs as a case is refused up front, and nothing is written' },
      { file: 'e2e/cli-drill-add.test.ts', title: '1: a rule that catches the escape reports it, names the case for its origin, and logs it' },
    ],
  },
  {
    id: 'provider-switch-drops-the-key',
    page: 'docs/configuration.md',
    quote: 'it removes the key stored for that tier and says so: left there, a key given for one provider would be sent to the next.',
    tests: [{ file: 'e2e/cli-init-provider-switch-key.test.ts', title: 'after switching anthropic → openai-compatible, the new endpoint receives no key at all, and init said so' }],
  },
];

/**
 * The invariants the 2026-09-25 surface audit found the docs selling with
 * nothing holding the CLI to them (its structural recommendation 8). Every one
 * of them has a claim above.
 */
export const AUDITED_INVARIANTS = [
  'log-gate-scope',
  'free-runs-leave-committed-files',
  'approve-refuses-over-conflicted-log',
  'merge-recipe-ends-green',
  'marketplace-check-implies-install',
  'pack-list-verify-agree-with-check',
  'impact-type-gap-is-check-strict',
  'impact-node-flows-are-context-flows',
  'drill-add-measures-or-refuses',
  'provider-switch-drops-the-key',
];

/** Text with line breaks and runs of spaces read as one space, as a quote reads across a hard-wrapped page. */
export function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}
