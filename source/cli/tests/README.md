# CLI tests

`npm test` runs every tier below with vitest; `npm run test:e2e:portal` runs the portal's browser suite separately (Playwright).

| Directory | What it holds |
|---|---|
| `unit/` | In-process tests of one module. |
| `integration/` | In-process tests of several modules together, on real files. |
| `e2e/` | Tests that spawn the built `dist/bin.js` and read only what it prints and writes. They import nothing from `src/**` (the `e2e-public-surface` rule), so run `npm run build` first. |
| `portal-e2e/` | The portal in a real browser. |
| `fixtures/` | Committed projects the tests copy, and the golden corpus. |
| `support/` | Helpers every tier may import. They import nothing from `src/**`. |

## Assert on what the CLI did, not on how it said it

A behaviour test asks a question such as "was an `unverified` issue raised for this node, with this cause?" or "does `next:` point at `yg log merge-resolve`?". Answer it from the parts of the output that stay put when the wording changes:

- in a `--json` document: an issue's `code`, `cause`, `node`, `aspect` or `severity`; the `next` object's `command` and `requiresUser`; `exit.code`;
- in the text report: the `error[<label>]` and `warning[<label>]` block headers, the `yg check: PASS|FAIL|ABORTED` verdict line and its counts, and the command on the `next:` line;
- in an error: the code in its `error[<code>]:` header.

`support/assert-output.ts` has one helper for each:

```ts
import { parseJson, expectIssue, expectNoIssue, expectNext, expectBlock, expectVerdict, expectErrorCode, textNext } from '../support/assert-output.js';

const doc = parseJson(run(['check', '--json'], dir).stdout);
expectIssue(doc, { code: 'unverified', cause: 'stale', node: 'services/orders' });
expectNoIssue(doc, { code: 'orphaned-aspect' });
expectNext(doc, { command: 'yg log merge-resolve --node services/payments' });

const text = run(['check'], dir).stdout;
expectVerdict(text, { status: 'FAIL', errors: 5 });
expectBlock(text, { label: 'unverified', severity: 'error' });
expect(textNext(text)).toBe('yg check --approve --only-deterministic');

expectErrorCode(run(['check', '--top', '0'], dir).stderr, 'usage');
```

A failing helper prints what was there instead (the issue codes and causes, or the block labels), so the failure says where to look.

Do not assert a sentence of the output (`toContain('whose inputs changed since the verdict')`). Every rewording of that sentence then breaks the test although the behaviour it checks has not changed, and a change to how the CLI words things ends up touching tests across the tree. The exact words are recorded in one place: the golden corpus.

## The golden corpus: where the wording lives

`fixtures/golden-corpus/<state>/<case>.txt` holds what the CLI prints, byte for byte, in a fixed set of project states (`support/golden-corpus.ts` builds them; `e2e/cli-golden-corpus.test.ts` compares). A change to the output shows up as a diff of these files, and that diff is where the wording gets reviewed. After a deliberate change, run `npm run golden:update` and review the diff before you commit it.

A sentence is the right thing to assert only when the sentence itself is the contract: the golden corpus, and the docs samples that must match a real run (`e2e/docs-output-samples.test.ts`).

## The prose ratchet

`unit/repo/e2e-prose-ratchet.test.ts` counts, in each end-to-end file, the assertions whose argument is a string or regular-expression literal of five or more words (a command-line flag is not counted as a word). `unit/repo/e2e-prose-baseline.json` records how many each file had when the guard was introduced. The count may only go down:

- A new prose assertion fails the guard, which names the file and line. Assert on a code, a label or a JSON field instead.
- When a conversion removes prose assertions, the guard fails until the baseline follows. Run `npm run prose:baseline`: it lowers each count to what the file holds now, and never raises one.
- If the wording is what a whole file tests, add the file to `WORDING_CONTRACT` in the guard. That change is visible in review.
- When you rename an end-to-end file, rename its key in the baseline by hand. The guard cannot tell a rename from a new file without asking git, so the new name fails with a baseline of 0; its message names the baseline entries whose files are gone, so the key to move is in front of you.
