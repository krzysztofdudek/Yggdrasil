import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';

// ---------------------------------------------------------------------------
// INVALIDATION — variety across every input channel that feeds a pair's hash.
//
// In the verdict-lock model there is NO typed cascade with a named cause. A
// stored verdict is valid only while its inputs hash to the recorded value;
// "what used to drift" is now EMERGENT from input hashing. This suite walks the
// distinct input channels and pins, for each, whether an edit re-points the
// affected pair(s) to `unverified` — proving BOTH the positive set (exactly the
// pairs whose inputs changed) and the critical negatives (edits that touch no
// pair's inputs leave every verdict valid and the repo green).
//
// Positive channels:
//   * SUBJECT FILE  — editing a node's mapped source invalidates that node's
//     pairs only.
//   * ASPECT CONTENT — editing a deterministic aspect's check.mjs invalidates
//     exactly that aspect's pairs on every node that uses it.
//   * REFERENCE FILE (LLM) — editing an LLM aspect's declared `references:` file
//     invalidates exactly that aspect's LLM pairs on every node that uses it.
//
// Negative channels (no input of any pair changed → verdict stays valid):
//   * PARENT-node metadata edit (description-only).
//   * DEPENDENCY-node metadata edit reached only by a bare `uses` relation.
//   * FLOW yaml edit (description-only).
//
// Hermetic: each test copies the e2e-lifecycle fixture into a FRESH mkdtemp dir,
// mutates only that copy, and rmSync's it in a finally. The deterministic
// scenarios strip the LLM `has-doc-comment` aspect (no network); the LLM
// reference-file scenario serves a live in-process mock and uses runAsync.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-invar-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so every node's
 * effective aspects are purely deterministic — no network, no LLM verdict; the
 * `no-todo-comments` (enforced) and `requires-named-export` (advisory)
 * deterministic aspects drive every outcome.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

const aspectCheckMjs = (dir: string, id: string) =>
  path.join(dir, '.yggdrasil', 'aspects', id, 'check.mjs');
const parentNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'yg-node.yaml');
const ordersNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const paymentsNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');
const flowYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');

/**
 * The unverified pairs a `yg check --details` report lists. The uncapped
 * --details view renders every unverified pair as its own member line,
 * `<aspect> @ <unit>`, under an `error[unverified]` / `warning[unverified]`
 * block (the capped default view folds many pairs of one rule into a count
 * line), so a node's unverified membership is read from those member lines.
 */
function unverifiedPairs(all: string): Array<{ aspect: string; node: string }> {
  const out: Array<{ aspect: string; node: string }> = [];
  let inUnverified = false;
  for (const line of all.split('\n')) {
    const head = line.match(/^(?:error|warning)\[([^\]]+)\]/);
    if (head) { inUnverified = head[1].startsWith('unverified'); continue; }
    if (!line.startsWith(' ')) { inUnverified = false; continue; }
    if (!inUnverified) continue;
    const m = line.match(/^\s+(?:at:\s+)?(\S+) @ (\S+)\s*$/);
    if (m) out.push({ aspect: m[1], node: m[2] });
  }
  return out;
}

/** The set of nodes with at least one unverified pair. */
function unverifiedNodes(all: string): Set<string> {
  return new Set(unverifiedPairs(all).map((p) => p.node));
}

/** The nodes on which a specific aspect is unverified. */
function unverifiedNodesForAspect(all: string, aspectId: string): string[] {
  return unverifiedPairs(all).filter((p) => p.aspect === aspectId).map((p) => p.node);
}

describe.skipIf(!distExists)('CLI E2E — invalidation across every input channel', () => {
  // --- 1. ASPECT CONTENT: editing a deterministic check.mjs invalidates exactly
  //        that aspect's pairs on every node that uses it; a re-fill clears it. ---

  it('1: editing no-todo-comments/check.mjs invalidates exactly that aspect on both nodes; a re-fill clears it', () => {
    const dir = deterministicFixture('aspect');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Trivial no-op change to the aspect's implementation.
      appendFileSync(aspectCheckMjs(dir, 'no-todo-comments'), '\n// trivial no-op comment\n');

      const drifted = run(['check', '--details'], dir);
      expect(drifted.status).toBe(1);
      // EXACT set: no-todo-comments on BOTH nodes is unverified — and nothing else.
      // The other aspect (requires-named-export) was NOT touched, so it stays valid.
      // The --details view lists each unverified pair as "<aspect> @ <node>".
      expect(unverifiedNodesForAspect(drifted.all, 'no-todo-comments').sort()).toEqual([
        'services/orders',
        'services/payments',
      ]);
      expect(unverifiedNodesForAspect(drifted.all, 'requires-named-export')).toEqual([]);
      expect(drifted.all).not.toContain('requires-named-export @');

      // A deterministic re-fill re-runs only the invalidated pairs (zero cost).
      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(refill.all).toContain('fill  2 pairs · 2 script (free) · 0 reviewer calls');

      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. REFERENCE FILE (LLM-only): editing an LLM aspect's declared reference
  //        file invalidates exactly that aspect's LLM pairs on every node. ---
  //
  // References fold into the LLM pair hash, so this scenario KEEPS the LLM aspect
  // `has-doc-comment` (it does NOT use deterministicFixture). The reviewer is
  // pointed at a live in-process mock returning a satisfied verdict, so the fill
  // records genuine LLM verdicts that capture the reference file's bytes. Editing
  // that reference file then re-points the LLM pairs to unverified. (A dead
  // reviewer would fail closed and write no verdict, leaving nothing to
  // invalidate — hence the mock.)

  it('2: editing an LLM aspect reference file invalidates exactly that aspect on both nodes', async () => {
    const dir = copyFixture('reference');
    const mock = await startMockReviewer();
    try {
      // Point the reviewer at the live mock so the LLM aspect is verified.
      // Also disable required coverage so reference files outside src/ (docs/)
      // are advisory-only and do not block the fill.
      const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
      const cfg = readFileSync(cfgPath, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${mock.endpoint}"`);
      writeFileSync(cfgPath, `${cfg}\ncoverage:\n  required: []\n`, 'utf-8');

      // Declare a reference file on the LLM aspect and create it in the copy.
      const aspectYaml = path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment', 'yg-aspect.yaml');
      writeFileSync(
        aspectYaml,
        [
          'name: HasDocComment',
          "description: Every source file must begin with a documentation comment describing the file's purpose.",
          'reviewer:',
          '  type: llm',
          'status: enforced',
          'references:',
          '  - docs/guidance.md',
          '',
        ].join('\n'),
        'utf-8',
      );
      mkdirSync(path.join(dir, 'docs'), { recursive: true });
      const guidance = path.join(dir, 'docs', 'guidance.md');
      writeFileSync(guidance, '# Guidance\n\nDescribe the file purpose in the opening comment.\n', 'utf-8');

      // Fill records LLM verdicts that capture the reference hash.
      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      const callsAfterFill = mock.chatCount();
      expect(callsAfterFill).toBeGreaterThanOrEqual(2);
      expect((await runAsync(['check'], dir)).status).toBe(0);

      // Edit the reference file — the LLM aspect's pairs lose their valid verdict.
      appendFileSync(guidance, '\nAdditional guidance appended.\n');

      const drifted = await runAsync(['check', '--details'], dir);
      expect(drifted.status).toBe(1);
      // EXACT set: only has-doc-comment, on BOTH nodes — the deterministic
      // aspects' verdicts are untouched (their inputs did not change). The
      // --details view lists each unverified pair as "<aspect> @ <node>".
      expect(unverifiedNodesForAspect(drifted.all, 'has-doc-comment').sort()).toEqual([
        'services/orders',
        'services/payments',
      ]);
      expect(unverifiedPairs(drifted.all).map((p) => p.aspect)).toEqual(['has-doc-comment', 'has-doc-comment']);
      expect(drifted.all).not.toContain('no-todo-comments @');
      expect(drifted.all).not.toContain('requires-named-export @');

      // A re-fill re-runs only the two invalidated LLM pairs — the deterministic
      // verdicts carry forward, so only the reviewer is called again.
      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(refill.all).toContain('fill  2 pairs · 0 script (free) · 2 reviewer calls');
      expect(mock.chatCount()).toBeGreaterThan(callsAfterFill);
      expect((await runAsync(['check'], dir)).status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. NEGATIVE — PARENT metadata: a description-only edit to the parent
  //        node's yaml changes no pair's inputs, so every verdict stays valid. ---
  //
  // (In the verdict-lock model there is NO hierarchy cascade: a parent's metadata
  // is not an input to any child pair's hash. This is the removed "parent change
  // cascade" surface, re-pinned as a strong negative.)

  it('3: NEGATIVE — editing the parent services/yg-node.yaml description invalidates nothing (stays green)', () => {
    const dir = deterministicFixture('parent');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      appendFileSync(parentNodeYaml(dir), '\n# parent metadata tweak — must not invalidate anything\n');

      const after = run(['check'], dir);
      expect(after.status).toBe(0);
      expect(after.all).toContain('yg check: PASS');
      expect(after.all).not.toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. NEGATIVE — DEPENDENCY metadata reached by a bare `uses` relation: a
  //        metadata-only edit to the dependency changes no pair's inputs. ---
  //
  // A bare relation does NOT make the dependency's metadata an input to the
  // dependent's pairs (the removed "dependency metadata cascade" surface). Only a
  // graph-aware deterministic check that actually READS the dependency would fold
  // an observation into the hash — and that is proven in the extended suite.

  it("4: NEGATIVE — a bare 'uses' relation does not make services/payments metadata invalidate services/orders", () => {
    const dir = deterministicFixture('relational');
    try {
      // Add a bare `uses` relation from orders -> payments (no graph-aware check).
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'relations:',
          '  - type: uses',
          '    target: services/payments',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Change the dependency's metadata — orders only RELATES to payments, it
      // does not READ it, so nothing of orders is invalidated.
      appendFileSync(paymentsNodeYaml(dir), '\n# dependency metadata tweak\n');

      const after = run(['check'], dir);
      expect(after.status).toBe(0);
      expect(after.all).toContain('yg check: PASS');
      expect(after.all).not.toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5. NEGATIVE — FLOW yaml: a description-only edit changes no participant's
  //        effective aspect set, so no pair's inputs change. ---
  //
  // A flow influences a participant's verdicts only by changing the EFFECTIVE
  // ASPECT SET (adding/removing a flow aspect or participant). A cosmetic edit to
  // the flow yaml (its description) does NOT, so the repo stays green.

  it('5: NEGATIVE — a flow-yaml description edit invalidates nothing (stays green)', () => {
    const dir = deterministicFixture('flow');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      appendFileSync(flowYaml(dir), '\n# flow description tweak — no effective-aspect change\n');

      const after = run(['check'], dir);
      expect(after.status).toBe(0);
      expect(after.all).toContain('yg check: PASS');
      expect(after.all).not.toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 6. SUBJECT FILE: editing one node's mapped source invalidates only that
  //        node's pairs — the sibling's verdicts stay valid. ---

  it('6: editing services/orders source invalidates only its pairs; services/payments stays valid', () => {
    const dir = deterministicFixture('subject');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      appendFileSync(path.join(dir, 'src', 'services', 'orders.ts'), '\n// benign source edit\n');

      const drifted = run(['check', '--details'], dir);
      expect(drifted.status).toBe(1);
      // EXACT node set: only services/orders is unverified.
      expect(unverifiedNodes(drifted.all)).toEqual(new Set(['services/orders']));
      expect(drifted.all).not.toContain('@ services/payments');

      // A re-fill re-runs only orders' pairs.
      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(refill.all).toContain('fill  2 pairs · 2 script (free) · 0 reviewer calls');
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
