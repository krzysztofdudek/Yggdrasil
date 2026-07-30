// =============================================================================
// E2E — nodeless (type-covered-file) pairs driven through the real fill
// stage: the pre-dispatch header and the dry-run "files enforced by their
// type" section.
//
// LIMITATION — read before extending this suite or trusting its first test's
// green: a deterministic (or companion-backed) check for a file with no
// owning component currently INFRA-ERRORS at fill time with "Node '' not in
// graph." — the structure runner resolves the owning component by path and
// builds the rest of its ctx from it BEFORE a check ever sees ctx.files
// (verified directly: `buildUnitCtx` in structure/hook-loader.ts throws that
// error as its very first step, so check.mjs never runs at all for such a
// file). Until the runner accepts a request with no owning component, the
// deterministic-gate cross-contamination guarantee — one refusing file must
// not suppress the LLM review of an unrelated file matching the same type —
// cannot be exercised end-to-end here: the det check that is supposed to
// refuse never reaches a verdict, so the gate it is meant to arm is never
// armed. The first test below pins only what is actually true today: the
// infra failure is reported cleanly (the file name surfaces, no phantom
// `undefined` node/component appears anywhere) and an unrelated file's plain
// LLM review still runs (which does not depend on the same node-resolving
// path, so it is not itself evidence the gate did anything). A real
// cross-file gate pin for this case lives at the unit level instead
// (tests/unit/core/fill-det.test.ts), seeded with a cached, correctly-hashed
// refusal so it never needs the broken runner path. Re-enable a genuine
// end-to-end version of the first test here once a fresh deterministic fill
// for a file with no owning component actually reaches a verdict.
//
// Real spawned binary + in-process mock reviewer (support/mock-reviewer.ts),
// against the REAL committed tests/fixtures/type-level-engine/ project merged
// with its `two-covered-files` variant: a deterministic rule (refuses-on-a)
// that targets src/leaf/a.ts, and an LLM rule (llm-leaf-rule) attached to the
// SAME type, alongside the base fixture's src/leaf/a.ts and the variant's
// src/leaf/b.ts.
//
// HERMETIC: fresh mkdtemp merge (base + variant) per test, mutated in place,
// rmSync'd in finally. No fixed ports. Strong observables: stdout/stderr text,
// the local events sidecar (which units actually got a reviewer disposition).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';
import { FIXTURE_TWO_COVERED_FILES } from '../fixtures/type-level-engine/variants/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const BASE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const eventsPath = (d: string) => path.join(d, '.yggdrasil', '.yg-events.jsonl');

function copyMergedFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-typecov-fill-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  cpSync(FIXTURE_TWO_COVERED_FILES, dir, { recursive: true });
  return dir;
}

/** Append a reviewer: block pointing at the mock endpoint — the base fixture ships none. */
function addReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  const content = readFileSync(p, 'utf-8');
  appendFileSync(
    p,
    `\nreviewer:\n  default: standard\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: "mock-model"\n        endpoint: "${endpoint}"\n`,
  );
  // Sanity: the append must not have clobbered the existing coverage block.
  expect(readFileSync(p, 'utf-8')).toContain(content.trim());
}

/**
 * The set of unit keys that actually received an LLM disposition this run —
 * read from the local events sidecar (a plain on-disk JSONL file the CLI
 * itself writes), never the internal engine. Public-surface only, mirrors
 * this suite's own read-lock.ts convention (parse what the binary wrote).
 */
function reviewedLlmUnits(dir: string): string[] {
  const p = eventsPath(dir);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  const units: string[] = [];
  for (const line of lines) {
    const event = JSON.parse(line) as { kind?: string; unitKey?: string };
    if (event.kind === 'llm' && event.unitKey) units.push(event.unitKey);
  }
  return units;
}

describe.skipIf(!distExists)('CLI E2E — type-covered-file fill', () => {
  it('NOT A GATE PIN (see file header): refuses-on-a infra-errors before it can refuse, so this only shows the infra failure is reported cleanly and does not block an unrelated file\'s review', async () => {
    const dir = copyMergedFixture();
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    try {
      addReviewer(dir, mock.endpoint);

      const fill = await runAsync(['check', '--approve'], dir);

      // refuses-on-a never reaches a verdict on a.ts — it infra-errors before
      // check.mjs runs at all (see the file header). This confirms only that
      // the file name surfaces in the infra-error text, not that the check ran
      // or that anything was refused.
      expect(fill.all).toContain('src/leaf/a.ts');
      // No phantom component/node identity leaks into the output either way.
      expect(fill.all).not.toMatch(/component 'undefined'|node 'undefined'/);
      // b.ts's plain LLM rule does not depend on node resolution, so it is
      // reviewed regardless of a.ts's outcome — this is NOT evidence that a
      // deterministic refusal was isolated to its own file by the gate.
      expect(reviewedLlmUnits(dir)).toContain('file:src/leaf/b.ts');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('the pre-dispatch header counts components and files separately when nodeless pairs exist', async () => {
    const dir = copyMergedFixture();
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    try {
      addReviewer(dir, mock.endpoint);
      const fill = await runAsync(['check', '--approve'], dir);
      // At least one real component (owned/forbidden, from the base fixture)
      // AND at least one file (a.ts/b.ts) are both in this run's fill set —
      // the combined wording must appear, never a bare "N nodes" that would
      // silently fold the files into (or hide them from) the component count.
      expect(fill.all).toMatch(/Filling \d+ unverified pairs across \d+ components and \d+ files/);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('--dry-run renders a "Files enforced by their type" section with no phantom component line', async () => {
    const dir = copyMergedFixture();
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    try {
      addReviewer(dir, mock.endpoint);
      const preview = await runAsync(['check', '--approve', '--dry-run'], dir);
      expect(preview.all).toContain('Files enforced by their type');
      expect(preview.all).toContain('src/leaf/a.ts');
      expect(preview.all).toContain('src/leaf/b.ts');
      // No reviewer calls made during a preview.
      expect(mock.chatCount()).toBe(0);
      expect(preview.all).not.toMatch(/component 'undefined'|node 'undefined'/);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
