/**
 * Integration tests for the type-visibility per-type block in `yg check`'s
 * rendered output: real fixture -> real graph -> real runCheck -> real
 * formatOutput, no spawned binary (tests/e2e/ owns that, Step 6). Pins the
 * three load-bearing lines the check summary must show: the zero-applicable-
 * rules honesty line, a half-expanded bundle, and a chain-termination line
 * rendered exactly once per type.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runCheck } from '../../../src/core/check.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';
import { formatOutput } from '../../../src/cli/check-render-views.js';
import { FIXTURE_ZERO_ENFORCEMENT, FIXTURE_BINARY_SUBJECT } from '../../fixtures/type-level-engine/variants/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BASE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');

const tmpDirs: string[] = [];
function copyFixture(...overlays: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-check-type-visibility-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  for (const overlay of overlays) cpSync(overlay, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

async function renderCheck(dir: string): Promise<string> {
  const graph = await loadGraph(dir);
  const files = await walkRepoFiles(dir);
  const result = await runCheck(graph, files);
  return formatOutput(result);
}

describe('yg check — type-visibility block (Step 2)', () => {
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

  // Fix round 1, Critical: a binary file matched by a type whose only rule is
  // an LLM (prose) aspect must never be counted as enforced — the reviewer's
  // own exact case. Before the fix, the binary-subject skip in pairs.ts's
  // nodeless enumeration recorded no drop, so "enforced" (derived by
  // subtracting drops from declared-attached) wrongly counted logo.png too:
  // `prose-rule (2)` when only ONE real pair (readme.md) exists, and
  // logo.png never appeared in the zero-enforcement line even though nothing
  // runs on it.
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
    // its absence from "Enforced:".
    expect(out).toContain("prose-rule (a binary file cannot be reviewed by a prose rule, 1)");
    rmSync(dir, { recursive: true, force: true });
  });

  // Fix round 1, Important: an advisory rule must not be reported under the
  // "Enforced" heading. src/leaf/a.ts's own-file-rule implies
  // implied-file-rule (status: advisory) — it genuinely runs (a real pair
  // exists) but only warns; the check-summary heading must say so honestly.
  it('an advisory rule is named under its own heading, never counted under "Enforced"', async () => {
    const dir = copyFixture();
    const out = await renderCheck(dir);
    expect(out).not.toMatch(/Enforced:.*implied-file-rule/);
    expect(out).toMatch(/Advisory[^\n]*implied-file-rule \(1\)/);
    rmSync(dir, { recursive: true, force: true });
  });
});

// Belt-and-suspenders: each `it` above already removes its own dir; this
// guards against a thrown assertion skipping that cleanup line.
afterAll(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
