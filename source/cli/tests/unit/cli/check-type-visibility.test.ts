/**
 * Integration tests for the type-visibility per-type block in `yg check`'s
 * rendered output: real fixture -> real graph -> real runCheck -> real
 * formatOutput, no spawned binary (tests/e2e/ owns that). Pins the
 * three load-bearing lines the check summary must show: the zero-applicable-
 * rules honesty line, a half-expanded bundle, and a chain-termination line
 * rendered exactly once per type.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runCheck } from '../../../src/core/check.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';
import { formatOutput } from '../../../src/cli/check-render-views.js';
import { FIXTURE_ZERO_ENFORCEMENT, FIXTURE_BINARY_SUBJECT } from '../../fixtures/type-level-engine/variants/index.js';
import { copyFixtureTree } from '../../support/fixture-copy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BASE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');

const tmpDirs: string[] = [];
function copyFixture(...overlays: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-check-type-visibility-'));
  copyFixtureTree(BASE_FIXTURE, dir);
  for (const overlay of overlays) copyFixtureTree(overlay, dir);
  tmpDirs.push(dir);
  return dir;
}

/**
 * The report as `yg check --coverage` renders it — the listing is opt-in since
 * 6.0.0, so every assertion about it below must ask for it, exactly as a
 * reader does. `renderPlain` is the other half of the same contract.
 */
async function renderCheck(dir: string): Promise<string> {
  const graph = await loadGraph(dir);
  const files = await walkRepoFiles(dir);
  const result = await runCheck(graph, files);
  return formatOutput(result, { kind: 'full' }, false, false, { coverage: true });
}

/** The report as plain `yg check` renders it — no view flag, no coverage flag. */
async function renderPlain(dir: string): Promise<string> {
  const graph = await loadGraph(dir);
  const files = await walkRepoFiles(dir);
  const result = await runCheck(graph, files);
  return formatOutput(result, { kind: 'full' }, false, false);
}

describe('yg check — type-visibility block', () => {
  // The other side of every assertion in this file: over the SAME fixture and
  // the same run, a plain `yg check` carries none of it. A green tree with
  // type-level coverage on gets the verdict and what the run found, nothing
  // else — the listing is the answer to a question asked when the type map is
  // written, not on every run.
  it('plain yg check renders none of this block — the whole listing is behind --coverage', async () => {
    const dir = copyFixture(FIXTURE_ZERO_ENFORCEMENT);
    const plain = await renderPlain(dir);
    expect(plain).not.toContain('Type coverage:');
    expect(plain).not.toContain('file covered:');
    expect(plain).not.toContain('files covered:');
    expect(plain).not.toContain('Enforced:');
    expect(plain).not.toContain('inherited rules stop at');
    expect(plain).not.toMatch(/matched by a type have no rules that apply/);
    expect(plain).not.toContain('src/ep/e.ts');
    // The same run WITH the flag does carry it — so the absence above is the
    // flag's doing, not a fixture that never produced a block.
    expect(await renderCheck(dir)).toContain('Type coverage:');
    rmSync(dir, { recursive: true, force: true });
  });

  it('says plainly when a file is covered but nothing applies to it', async () => {
    const dir = copyFixture(FIXTURE_ZERO_ENFORCEMENT);
    const out = await renderCheck(dir);
    expect(out).toMatch(/2 files matched by a type have no rules that apply to them/);
    expect(out).toContain('src/ep/e.ts');
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the half of a grouped rule set that cannot run on a single file', async () => {
    const dir = copyFixture();
    const out = await renderCheck(dir);
    expect(out).toMatch(/bundle: file-level part applies; whole-unit part needs a component/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('says once per type where the inherited chain stops', async () => {
    const dir = copyFixture();
    const out = await renderCheck(dir);
    expect(out.match(/inherited rules stop at a fork \(mid \| top\)/g)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  // A binary file matched by a type whose only rule is an LLM (prose) aspect
  // must never be counted as enforced. A silently missing drop for the
  // binary-subject skip would let "enforced" (derived by subtracting drops
  // from declared-attached) wrongly count logo.png too: `prose-rule (2)` when
  // only ONE real pair (readme.md) exists, and logo.png would never appear in
  // the zero-enforcement line even though nothing runs on it.
  it('a binary file whose only attached rule is an LLM (prose) aspect is never counted as enforced, and is named in the zero-enforcement line', async () => {
    const dir = copyFixture(FIXTURE_BINARY_SUBJECT);
    const out = await renderCheck(dir);
    // Exactly one real pair (readme.md) exists — the count must say so, never
    // the pre-fix "2" a silent binary-subject skip used to produce.
    expect(out).toContain('prose-rule (1)');
    expect(out).not.toContain('prose-rule (2)');
    // logo.png is named alongside the base fixture's own pre-existing
    // zero-enforcement file (src/ep/e.ts, unrelated to this variant) — both
    // real, both honestly reported, never silently merged or dropped.
    expect(out).toMatch(/2 files matched by a type have no rules that apply to them — they satisfy coverage with no enforcement:/);
    expect(out).toContain('src/pics/logo.png');
    expect(out).toContain('src/ep/e.ts');
    // The reason is visible right where the count lives, not just implied by
    // its absence from "Enforced:" — grouped by reason, so the phrase is
    // stated once and the affected aspect id follows it with its count.
    expect(out).toMatch(/A binary file cannot be reviewed by a prose rule: prose-rule \(1\)/);
    rmSync(dir, { recursive: true, force: true });
  });

  // An advisory rule must not be reported under the "Enforced" heading.
  // src/leaf/a.ts's own-file-rule implies
  // implied-file-rule (status: advisory) — it genuinely runs (a real pair
  // exists) but only warns; the check-summary heading must say so honestly.
  it('an advisory rule is named under its own heading, never counted under "Enforced"', async () => {
    const dir = copyFixture();
    const out = await renderCheck(dir);
    expect(out).not.toMatch(/Enforced:.*implied-file-rule/);
    // This fixture is never approved, so the pair is genuinely unverified —
    // the count says so (see the "enforced/advisory count names an unconfirmed
    // pair honestly" block below), which is the correct, honest reading, not
    // a regression: `(1)` alone would now be the wrong claim for this fixture.
    expect(out).toMatch(/Advisory[^\n]*implied-file-rule \(1, 1 unverified\)/);
    rmSync(dir, { recursive: true, force: true });
  });
});

// Belt-and-suspenders: each `it` above already removes its own dir; this
// guards against a thrown assertion skipping that cleanup line.
afterAll(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
