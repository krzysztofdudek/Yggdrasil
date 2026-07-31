// =============================================================================
// E2E — `yg impact --file` / `yg impact --type` over files enforced by their
// architecture type alone (coverage.type_level), on the real committed
// tests/fixtures/type-level-engine merged with its two-covered-files variant.
//
// Two counting bugs pinned here, both reproduced against the real binary
// before being fixed:
//   1. `yg impact --file <type-covered file>` DROPPED nodeless pairs from its
//      totals: "0 deterministic pair(s)" / "0 currently-green verdict(s)
//      re-rolled" for a file with real, live, green verdicts. The invalidation
//      set contained the pairs; summarizeImpact's totals discarded them.
//   2. `yg impact --type <id>` printed "Source files covered (0)" for
//      `consumer` (which `yg check` reports as 1 type-covered file with a
//      live enforced rule) and "(1)" for `leaf` (which `yg check` reports as
//      2 type-covered files PLUS the `owned` component's own file — 3 in
//      total) — counting only node-mapped files, never type-covered ones.
//
// Also pins the two new cost previews ("Files enforced by this type: N" /
// "At stake: ..." for --type; "Giving this file a component of its own
// re-checks..." for --file) and, via the mock reviewer's captured prompt, the
// real nodeless prompt variant (no <node> element) actually sent to the
// reviewer for a type-covered file.
//
// HERMETIC: fresh mkdtemp merge (base + variant) per test, mutated in place,
// rmSync'd in finally. No fixed ports.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';
import { readLock } from './support/read-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const BASE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');

function copyMergedFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-typecov-impact-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  cpSync(path.join(BASE_FIXTURE, 'variants', 'two-covered-files'), dir, { recursive: true });
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
  expect(readFileSync(p, 'utf-8')).toContain(content.trim());
}

describe.skipIf(!distExists)('CLI E2E — yg impact over type-covered files', () => {
  it('--file counts a type-covered file\'s nodeless pairs in its totals (not zero)', async () => {
    const dir = copyMergedFixture();
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    try {
      addReviewer(dir, mock.endpoint);
      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).not.toBeNull();

      // src/leaf/b.ts is never refused by refuses-on-a (that rule targets only
      // a.ts) — every one of its own enforced pairs approves. Recompute the
      // real, per-kind expected counts from the committed lock (not a
      // hardcoded guess), so this pin tracks the fixture's own truth.
      const lock = readLock(path.join(dir, '.yggdrasil'));
      const ownEntries = Object.entries(lock.verdicts)
        .filter(([, units]) => units['file:src/leaf/b.ts'] !== undefined)
        .map(([aspectId]) => aspectId);
      expect(ownEntries.length).toBeGreaterThan(0);
      // llm-leaf-rule is the fixture's one LLM aspect on 'leaf'; everything
      // else attached to a type-covered file here is deterministic.
      const llmCount = ownEntries.filter((id) => id === 'llm-leaf-rule').length;
      const detCount = ownEntries.length - llmCount;
      expect(detCount).toBeGreaterThan(0);

      const out = await runAsync(['impact', '--file', 'src/leaf/b.ts'], dir);
      expect(out.all).toMatch(new RegExp(`${detCount} deterministic pair\\(s\\) — free\\.`));
      expect(out.all).toMatch(new RegExp(`${ownEntries.length} currently-green verdict\\(s\\) re-rolled\\.`));
      // The pre-fix bug printed exactly these zeros — pin their absence too.
      expect(out.all).not.toContain('0 deterministic pair(s)');
      expect(out.all).not.toContain('0 currently-green verdict(s) re-rolled');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('the reviewer prompt for a type-covered file carries no <node> element (the real nodeless variant, end to end)', async () => {
    // 'leaf' is BOTH a real node's type (owned/o.ts, a genuine component) AND
    // matches two type-covered files (a.ts/b.ts, no component) — llm-leaf-rule
    // reviews all three. Only the type-covered files' prompts must omit
    // <node>; the real component's prompt keeps it (byte-identical, unchanged).
    const dir = copyMergedFixture();
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    try {
      addReviewer(dir, mock.endpoint);
      await runAsync(['check', '--approve'], dir);
      const nodelessPrompts = mock.chatRequests.filter((r) => r.prompt.includes('src/leaf/a.ts') || r.prompt.includes('src/leaf/b.ts'));
      const componentPrompt = mock.chatRequests.filter((r) => r.prompt.includes('src/owned/o.ts'));
      expect(nodelessPrompts.length).toBeGreaterThan(0);
      expect(componentPrompt.length).toBeGreaterThan(0);
      for (const req of nodelessPrompts) {
        expect(req.prompt).not.toContain('<node');
        expect(req.prompt).not.toContain('node (component)');
        expect(req.prompt).toContain('Below is a single source file with its content and one aspect (rule set).');
      }
      // The real component's prompt is unaffected — byte-identical framing.
      for (const req of componentPrompt) {
        expect(req.prompt).toContain('<node path="owned"');
        expect(req.prompt).toContain('Below is a node (component) with its source files and one aspect (rule set).');
      }
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('--type counts type-covered files too, agreeing with yg check\'s own per-type count (a type with NO node at all)', async () => {
    const dir = copyMergedFixture();
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    try {
      addReviewer(dir, mock.endpoint);
      await runAsync(['check', '--approve'], dir);

      const check = await runAsync(['check'], dir);
      const checkLine = check.all.split('\n').find((l) => l.includes("'consumer'"));
      expect(checkLine, 'expected a per-type check line for consumer').toBeDefined();
      const m = /(\d+) files? covered/.exec(checkLine!);
      expect(m, `expected a file count in: ${checkLine}`).not.toBeNull();
      const checkCount = Number(m![1]);
      expect(checkCount).toBeGreaterThan(0); // src/consumer/c.ts

      const out = await runAsync(['impact', '--type', 'consumer'], dir);
      expect(out.all).toContain(`Source files covered (${checkCount})`);
      expect(out.all).toContain('src/consumer/c.ts');
      // The pre-fix bug printed exactly this — pin its absence.
      expect(out.all).not.toContain('Source files covered (0)');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('--type counts type-covered files PLUS the component\'s own (a type with BOTH a node and type-covered files)', async () => {
    const dir = copyMergedFixture();
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    try {
      addReviewer(dir, mock.endpoint);
      await runAsync(['check', '--approve'], dir);

      const check = await runAsync(['check'], dir);
      const checkLine = check.all.split('\n').find((l) => l.includes("'leaf'"));
      expect(checkLine, 'expected a per-type check line for leaf').toBeDefined();
      const m = /(\d+) files? covered/.exec(checkLine!);
      expect(m, `expected a file count in: ${checkLine}`).not.toBeNull();
      const typeCoveredCount = Number(m![1]); // src/leaf/a.ts, src/leaf/b.ts -> 2

      const out = await runAsync(['impact', '--type', 'leaf'], dir);
      // 'owned' is the one real leaf-typed node, mapping src/owned/o.ts.
      expect(out.all).toContain('src/owned/o.ts');
      expect(out.all).toContain('src/leaf/a.ts');
      expect(out.all).toContain('src/leaf/b.ts');
      expect(out.all).toContain(`Source files covered (${typeCoveredCount + 1})`);
      // The pre-fix bug printed exactly this (node-mapped files only) — pin its absence.
      expect(out.all).not.toContain('Source files covered (1)');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('--type previews the cost of changing a type ("Files enforced by this type" / "At stake")', async () => {
    const dir = copyMergedFixture();
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    try {
      addReviewer(dir, mock.endpoint);
      await runAsync(['check', '--approve'], dir);

      const out = await runAsync(['impact', '--type', 'leaf'], dir);
      // 2 type-covered files (a.ts, b.ts); llm-leaf-rule is the type's one LLM
      // aspect (consensus 1) -> 2 review(s) = 2 reviewer call(s).
      expect(out.all).toMatch(/Files enforced by this type: 2/);
      expect(out.all).toMatch(/At stake: \d+ free check\(s\), 2 review\(s\) = 2 reviewer call\(s\)/);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('--file previews what giving a type-covered file a component of its own would cost', async () => {
    const dir = copyMergedFixture();
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    try {
      addReviewer(dir, mock.endpoint);
      await runAsync(['check', '--approve'], dir);

      const out = await runAsync(['impact', '--file', 'src/leaf/b.ts'], dir);
      // llm-leaf-rule is b.ts's one LLM pair (consensus 1) -> 1 review(s) = 1 reviewer call(s).
      expect(out.all).toMatch(/Giving this file a component of its own re-checks .*1 review\(s\) ≈ 1 reviewer call\(s\)/);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
