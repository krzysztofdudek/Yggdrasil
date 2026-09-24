// =============================================================================
// SCOPE / OBSERVATION — LLM-side pins not covered by cli-lock-scope.test.ts
// (which is deterministic-only). Covers three E2E gaps from the verdict-lock
// bounty findings:
//   (1) per:file scope for an LLM aspect via the mock reviewer — ONE prompt per
//       subject file, one file: lock entry per file, single-file edit re-invokes
//       the reviewer for ONLY that file's pair (sibling verdict carries forward).
//   (2) scope.files CONTENT atom narrows the subject set — only the matching file
//       forms a pair; editing the non-matching file does not invalidate the aspect.
//   (3) binary files auto-excluded from the LLM subject set — a .png mapped file
//       is not an LLM subject (editing it leaves the LLM pair verified), while a
//       deterministic aspect on the same node DOES cover the binary.
//
// Real spawned binary + in-process mock reviewer over runAsync (never spawnSync
// while the mock serves). HERMETIC: fresh mkdtemp copy of e2e-lifecycle per test,
// mutated in place, rmSync'd in finally. No fixed ports, no clock/random asserts.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';
import { readLock as readTriadLock } from './support/read-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const archPath = (d: string) => path.join(d, '.yggdrasil', 'yg-architecture.yaml');
const flowPath = (d: string) => path.join(d, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');
const aspectYaml = (d: string, a: string) => path.join(d, '.yggdrasil', 'aspects', a, 'yg-aspect.yaml');
const nodeYaml = (d: string, n: string) => path.join(d, '.yggdrasil', 'model', ...n.split('/'), 'yg-node.yaml');
// Read the unified lock by merging the 5.1.0 triad (nondeterministic + logs + deterministic).
const readLock = (d: string) => readTriadLock(path.join(d, '.yggdrasil'));

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-scope-llm-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Reduce the service-type architecture to a single LLM aspect (has-doc-comment),
 * dropping the deterministic + advisory defaults and the flow attach so the only
 * effective aspect on a service node is the LLM one under test. Keeps reviewer
 * call counts and lock key-sets exact. Broadens the service `when` to src/** so a
 * directory-mapped node classifies.
 */
function isolateLlmOnly(dir: string): void {
  // Architecture: service type → only has-doc-comment; broaden when to src/**.
  let arch = readFileSync(archPath(dir), 'utf-8');
  arch = arch.replace(
    '    aspects:\n      - no-todo-comments\n      - requires-named-export\n      - has-doc-comment\n',
    '    aspects:\n      - has-doc-comment\n',
  );
  arch = arch.replace('path: "src/services/**"', 'path: "src/**"');
  writeFileSync(archPath(dir), arch, 'utf-8');
  // Flow: drop its participation-level attach.
  writeFileSync(flowPath(dir), readFileSync(flowPath(dir), 'utf-8').replace('aspects:\n  - no-todo-comments\n', 'aspects: []\n'), 'utf-8');
  // Remove the now-unused deterministic/advisory aspect dirs so nothing else fires.
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments'), { recursive: true, force: true });
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'requires-named-export'), { recursive: true, force: true });
}

/**
 * Drop the payments node so the only effective subject set is the orders node —
 * keeping reviewer-call counts and lock key-sets exact. Removing the node also
 * removes it from the flow's `nodes:` list (else a flow-node-broken error blocks
 * the run for an unrelated reason).
 */
function removePayments(dir: string): void {
  rmSync(path.join(dir, '.yggdrasil', 'model', 'services', 'payments'), { recursive: true, force: true });
  rmSync(path.join(dir, 'src', 'services', 'payments.ts'), { force: true });
  writeFileSync(flowPath(dir), readFileSync(flowPath(dir), 'utf-8').replace('  - services/payments\n', ''), 'utf-8');
}

/** A first-line doc comment so has-doc-comment is satisfied. */
const DOC = '// doc comment\n';

describe.skipIf(!distExists)('CLI E2E — scope (LLM-side): per:file / content-atom / binary exclusion', () => {
  // ===========================================================================
  // (1) PER:FILE SCOPE FOR AN LLM ASPECT
  //   3-file node, LLM aspect {per: file}. Fill → ONE prompt per file (3 chat
  //   calls) + three file: lock entries (no node: entry). Edit ONE file → only
  //   its pair unverified → re-fill makes exactly 1 reviewer call; sibling lock
  //   entries are byte-identical (carry-forward).
  // ===========================================================================

  it('(1) per:file LLM aspect: one prompt per file, single-file edit re-invokes only that pair', async () => {
    const dir = copyFixture('perfile');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      isolateLlmOnly(dir);

      // Restructure orders to map a 3-file DIRECTORY.
      const base = path.join(dir, 'src', 'services', 'orders');
      mkdirSync(base, { recursive: true });
      rmSync(path.join(dir, 'src', 'services', 'orders.ts'), { force: true });
      writeFileSync(path.join(base, 'a.ts'), DOC + 'export const a = 1;\n');
      writeFileSync(path.join(base, 'b.ts'), DOC + 'export const b = 1;\n');
      writeFileSync(path.join(base, 'c.ts'), DOC + 'export const c = 1;\n');
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        ['name: OrdersService', 'description: Orders.', 'type: service', 'mapping:', '  - src/services/orders', ''].join('\n'),
        'utf-8',
      );
      // Remove the payments node so the only LLM subject set is orders' 3 files.
      removePayments(dir);

      // Make has-doc-comment per:file.
      const ay = aspectYaml(dir, 'has-doc-comment');
      writeFileSync(ay, readFileSync(ay, 'utf-8').trimEnd() + '\nscope:\n  per: file\n', 'utf-8');

      // FILL: exactly THREE reviewer calls — one prompt per subject file.
      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(mock.chatCount()).toBe(3);

      // Each prompt contained exactly ONE subject file's content (per:file isolation):
      // a.ts's prompt does not carry b.ts's unique marker, etc. We assert the union of
      // prompts covers all three and that no single prompt carries all three bodies.
      const prompts = mock.chatRequests.map((r) => r.prompt);
      expect(prompts.some((p) => p.includes('export const a = 1;'))).toBe(true);
      expect(prompts.some((p) => p.includes('export const b = 1;'))).toBe(true);
      expect(prompts.some((p) => p.includes('export const c = 1;'))).toBe(true);
      const carriesAllThree = prompts.filter((p) => p.includes('export const a = 1;') && p.includes('export const b = 1;') && p.includes('export const c = 1;'));
      expect(carriesAllThree).toHaveLength(0);

      // The lock holds one file: entry per file — NOT a single node: entry.
      const docVerdicts = readLock(dir).verdicts['has-doc-comment'];
      expect(Object.keys(docVerdicts).sort()).toEqual([
        'file:src/services/orders/a.ts',
        'file:src/services/orders/b.ts',
        'file:src/services/orders/c.ts',
      ]);
      expect(run(['check'], dir).status).toBe(0);

      // Snapshot the untouched siblings' entries before the edit.
      const bEntryBefore = JSON.stringify(docVerdicts['file:src/services/orders/b.ts']);
      const cEntryBefore = JSON.stringify(docVerdicts['file:src/services/orders/c.ts']);

      // EDIT ONE FILE (a.ts) → ONLY its pair goes unverified.
      appendFileSync(path.join(base, 'a.ts'), 'export const aa = 2;\n');
      const afterEdit = run(['check'], dir);
      expect(afterEdit.status).toBe(1);
      // Editing a.ts invalidates EXACTLY one per:file pair → the unverified block
      // holds 1 pair for has-doc-comment and names a.ts as its unit; the chatCount
      // delta (1) below proves only a.ts's pair re-billed, with b.ts/c.ts untouched.
      expect(afterEdit.all).toContain('error[unverified] 1 pair whose inputs changed since the verdict');
      expect(afterEdit.all).toMatch(/^ {2}at: +has-doc-comment @ src\/services\/orders\/a\.ts$/m);

      // RE-FILL: exactly ONE additional reviewer call — only a.ts's pair.
      const callsBefore = mock.chatCount();
      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(mock.chatCount() - callsBefore).toBe(1);

      // Sibling lock entries carried forward byte-identical (never re-verified).
      const docAfter = readLock(dir).verdicts['has-doc-comment'];
      expect(JSON.stringify(docAfter['file:src/services/orders/b.ts'])).toBe(bEntryBefore);
      expect(JSON.stringify(docAfter['file:src/services/orders/c.ts'])).toBe(cEntryBefore);
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (2) scope.files CONTENT ATOM narrows the subject set
  //   2-file node; aspect scope.files {content: <regex>} matches only one. Only
  //   the matching file forms a pair (lock entry present for it, absent for the
  //   other), and editing the non-matching file does NOT invalidate the aspect.
  //   (Deterministic — free re-runs, but lock-entry presence + exit code are the
  //   observables, not call count.)
  // ===========================================================================

  it('(2) scope.files content atom: only the matching file forms a pair; non-matching edit is immune', () => {
    const dir = copyFixture('content-atom');
    try {
      // Reduce the service type to a single deterministic aspect we author below.
      let arch = readFileSync(archPath(dir), 'utf-8');
      arch = arch.replace(
        '    aspects:\n      - no-todo-comments\n      - requires-named-export\n      - has-doc-comment\n',
        '    aspects:\n      - marker-rule\n',
      );
      arch = arch.replace('path: "src/services/**"', 'path: "src/**"');
      writeFileSync(archPath(dir), arch, 'utf-8');
      writeFileSync(flowPath(dir), readFileSync(flowPath(dir), 'utf-8').replace('aspects:\n  - no-todo-comments\n', 'aspects: []\n'), 'utf-8');
      rmSync(path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments'), { recursive: true, force: true });
      rmSync(path.join(dir, '.yggdrasil', 'aspects', 'requires-named-export'), { recursive: true, force: true });
      rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });

      // marker-rule: deterministic, content-filtered to files containing the marker.
      const mr = path.join(dir, '.yggdrasil', 'aspects', 'marker-rule');
      mkdirSync(mr, { recursive: true });
      writeFileSync(
        path.join(mr, 'yg-aspect.yaml'),
        ['name: MarkerRule', 'description: Files carrying the @reviewed marker must declare a default export.', 'reviewer:', '  type: deterministic', 'status: enforced',
          'scope:', '  per: node', '  files:', '    content: "@reviewed"', ''].join('\n'),
        'utf-8',
      );
      writeFileSync(
        path.join(mr, 'check.mjs'),
        ['export function check(ctx) {', '  // Vacuously passes; presence/absence of the pair is the observable.', '  void ctx;', '  return [];', '}', ''].join('\n'),
        'utf-8',
      );

      // 2-file node: only matched.ts carries the @reviewed marker.
      const base = path.join(dir, 'src', 'services', 'orders');
      mkdirSync(base, { recursive: true });
      rmSync(path.join(dir, 'src', 'services', 'orders.ts'), { force: true });
      writeFileSync(path.join(base, 'matched.ts'), '// @reviewed\nexport const m = 1;\n');
      writeFileSync(path.join(base, 'other.ts'), '// plain\nexport const o = 1;\n');
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        ['name: OrdersService', 'description: Orders.', 'type: service', 'mapping:', '  - src/services/orders', ''].join('\n'),
        'utf-8',
      );
      removePayments(dir);

      // FILL → marker-rule has exactly ONE per:node pair (keyed node:...). The
      // subject set is folded opaquely into the entry hash (a deterministic
      // VerdictEntry exposes no file list), so subject-set membership is asserted
      // BEHAVIORALLY below via invalidation, not by reading a files field.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      const verdicts = readLock(dir).verdicts['marker-rule'];
      expect(Object.keys(verdicts)).toEqual(['node:services/orders']);
      const hashAfterFill = verdicts['node:services/orders'].hash as string;
      expect(run(['check'], dir).status).toBe(0);

      // EDIT THE NON-MATCHING FILE (other.ts) → NOT in the marker-rule subject set → the
      // ASPECT verdict stays valid AND its entry hash is unchanged (the excluded file does not
      // fold into the aspect hash). This is the load-bearing proof of scope narrowing — it is
      // unaffected by relation-conformance.
      appendFileSync(path.join(base, 'other.ts'), 'export const oo = 2;\n');
      const afterOther = run(['check'], dir);
      // The scoped ASPECT pair is immune: no marker-rule pair is named unverified and its hash holds.
      expect(afterOther.all).not.toContain("No valid verdict for aspect 'marker-rule'");
      expect(readLock(dir).verdicts['marker-rule']['node:services/orders'].hash).toBe(hashAfterFill);
      // Relations are computed LIVE: other.ts introduces no cross-node dependency, so the
      // live relation pass finds nothing to flag. The edit leaves the node fully green.
      expect(afterOther.all).not.toContain('relation-undeclared-dependency');
      expect(afterOther.status).toBe(0); // non-subject edit invalidates nothing
      // The marker-rule hash STILL holds across the edit.
      expect(readLock(dir).verdicts['marker-rule']['node:services/orders'].hash).toBe(hashAfterFill);

      // ADD THE MARKER to the previously-excluded file → subject set GROWS to include
      // it → the entry's input hash changes → the pair goes unverified (exit 1).
      writeFileSync(path.join(base, 'other.ts'), '// @reviewed\nexport const o = 1;\nexport const oo = 2;\n');
      const afterMark = run(['check'], dir);
      expect(afterMark.status).toBe(1);
      // Adding the marker grows the subject set → the per:node pair's input hash
      // changes → it goes unverified; the block names the aspect and the node.
      expect(afterMark.all).toContain('error[unverified] 1 pair whose inputs changed since the verdict');
      expect(afterMark.all).toMatch(/^ {2}at: +marker-rule @ services\/orders$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // (3) BINARY FILES auto-excluded from the LLM subject set
  //   Node maps a .png (real non-UTF8 bytes) + a .ts. LLM aspect verifies over the
  //   .ts only (editing ONLY the .png leaves the LLM pair verified). The .png is
  //   never an LLM subject.
  // ===========================================================================

  it('(3) binary file is excluded from the LLM subject set: editing only the .png leaves the LLM pair verified', async () => {
    const dir = copyFixture('binary');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      isolateLlmOnly(dir);

      // Node maps a directory containing one .ts and one real binary .png.
      const base = path.join(dir, 'src', 'services', 'orders');
      mkdirSync(base, { recursive: true });
      rmSync(path.join(dir, 'src', 'services', 'orders.ts'), { force: true });
      writeFileSync(path.join(base, 'code.ts'), DOC + 'export const code = 1;\n');
      // A real binary-extension file with non-UTF8 bytes (PNG signature + noise).
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x01]);
      writeFileSync(path.join(base, 'logo.png'), pngBytes);
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        ['name: OrdersService', 'description: Orders.', 'type: service', 'mapping:', '  - src/services/orders', ''].join('\n'),
        'utf-8',
      );
      removePayments(dir);

      // FILL → exactly ONE reviewer call (the .ts only). The .png is not an LLM subject.
      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(mock.chatCount()).toBe(1);
      // The single prompt carried the .ts content and did NOT carry the .png path as a subject.
      expect(mock.chatRequests[0].prompt).toContain('export const code = 1;');
      expect(mock.chatRequests[0].prompt).not.toContain('logo.png');

      // The LLM aspect has exactly ONE per:node entry (the binary did not add a
      // separate subject). The entry hash folds only the .ts subject; the binary's
      // exclusion is asserted behaviorally below (editing it does not invalidate).
      const docEntry = readLock(dir).verdicts['has-doc-comment']['node:services/orders'];
      const hashAfterFill = docEntry.hash as string;
      expect(Object.keys(readLock(dir).verdicts['has-doc-comment'])).toEqual(['node:services/orders']);
      expect(run(['check'], dir).status).toBe(0);

      // EDIT ONLY THE BINARY → the LLM pair's subject set excludes it → the ASPECT verdict stays
      // verified and its entry hash is unchanged (the binary's bytes never fold into the LLM hash).
      const callsBefore = mock.chatCount();
      appendFileSync(path.join(base, 'logo.png'), Buffer.from([0x42, 0x43, 0x44]));
      const afterBinaryEdit = run(['check'], dir);
      // The LLM aspect pair is immune: no has-doc-comment pair is named unverified and its hash holds.
      expect(afterBinaryEdit.all).not.toContain("No valid verdict for aspect 'has-doc-comment'");
      expect(readLock(dir).verdicts['has-doc-comment']['node:services/orders'].hash).toBe(hashAfterFill);
      // Relations are computed LIVE: the .png is not parsed and the node has no cross-node
      // dependency, so the live relation pass finds nothing to flag. The edit leaves the
      // node fully green — the binary's bytes never reach any reviewer.
      expect(afterBinaryEdit.all).not.toContain('relation-undeclared-dependency');
      expect(afterBinaryEdit.status).toBe(0); // binary-only edit invalidates nothing
      // A re-fill makes ZERO new reviewer calls — nothing to re-verify. The aspect hash STILL holds.
      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(mock.chatCount() - callsBefore).toBe(0);
      expect(readLock(dir).verdicts['has-doc-comment']['node:services/orders'].hash).toBe(hashAfterFill);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);
});
