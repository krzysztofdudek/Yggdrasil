// =============================================================================
// Task 6 E2E — nodeless (type-covered-file) pairs driven through the real
// fill stage: the pre-dispatch header, the dry-run files section, and the K16
// cross-contamination case (the mandatory Step 6 test — one refusing file
// must not suppress the LLM fill of an unrelated file matching the same type).
//
// Real spawned binary + in-process mock reviewer (support/mock-reviewer.ts),
// against the REAL committed tests/fixtures/type-level-engine/ project (Task 5)
// merged with its `two-covered-files` variant (Task 5, authored FOR this test):
// a deterministic rule (refuses-on-a) that refuses ONLY on src/leaf/a.ts, and
// an LLM rule (llm-leaf-rule) attached to the SAME type, alongside the base
// fixture's src/leaf/a.ts and the variant's src/leaf/b.ts.
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

describe.skipIf(!distExists)('CLI E2E — type-covered-file fill (Task 6)', () => {
  it('one refusing file does not stop the reviewer from reading the other files (K16)', async () => {
    const dir = copyMergedFixture();
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    try {
      addReviewer(dir, mock.endpoint);

      const fill = await runAsync(['check', '--approve'], dir);

      // The deterministic refusal on a.ts is surfaced.
      expect(fill.all).toContain('src/leaf/a.ts');
      // K16's own negative assertion: no phantom component anywhere in output.
      expect(fill.all).not.toMatch(/component 'undefined'|node 'undefined'/);
      // b.ts's LLM rule was still reviewed — the det refusal on a.ts's own file
      // unit must never suppress review of the UNRELATED file unit b.ts.
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
