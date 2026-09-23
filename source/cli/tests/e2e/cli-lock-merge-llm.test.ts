// =============================================================================
// Lock-merge recovery and piped-output survival for the LLM / refusal paths.
// Real spawned binary + in-process mock reviewer (support/mock-reviewer.ts).
//
// Two gaps the existing e2e suite leaves open:
//   (4) Lock merge take-a-side recovery WITH LLM pairs. The existing merge e2e
//       (cli-lock-format-recovery (9)) is DETERMINISTIC-ONLY and proves
//       carry-forward by string-absence. This pins the paid LLM path with strong
//       observables: the missing LLM pair is re-reviewed (HTTP call delta equals
//       the count of missing pairs) while the kept side's entry is NOT re-reviewed
//       (zero delta) and stays byte-identical; final check PASSES.
//   (5) Piped REFUSED-list non-truncation. The existing flush e2e
//       (cli-check-output-flush) covers only the COLD `unverified` block path.
//       This seeds >200 CACHED enforced refusals (their blocks carry the longer
//       cached-marker / three-exit text) and asserts, through a pipe, that the
//       `Errors (N)` header count equals the number of rendered refusal blocks —
//       the exitAfterFlush drain survives the refusal-shaped output too.
//
// HERMETIC: fresh tmp graph per test, rmSync'd in finally. No fixed ports.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';
import { readLock as readMergedLock, nondetLockPath } from './support/read-lock.js';
import { FIXTURE_RM_OPTIONS } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
// `has-doc-comment` is an LLM aspect → its verdicts live in the committed
// nondeterministic triad file. Read the merged lock via the src store, and seed
// the "taken side" into the nondeterministic file the CLI actually parses.
const ygDir = (d: string) => path.join(d, '.yggdrasil');
const nondetPath = (d: string) => nondetLockPath(ygDir(d));
const readLock = (d: string) => readMergedLock(ygDir(d));

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-mergellm-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — lock merge (LLM) & piped refusal survival', () => {
  // ===========================================================================
  // (4) LOCK MERGE — take a side wholesale, WITH LLM pairs.
  //
  //   Reach green via a real LLM fill (both service nodes' has-doc-comment
  //   entries recorded). Simulate a merge that took "side A" wholesale: the
  //   taken lock is MISSING one node's LLM verdict entry (the other branch had
  //   added it). `yg check --approve` must re-review ONLY the missing pair; the
  //   kept side's entry must NOT be re-reviewed and must carry forward unchanged.
  // ===========================================================================

  it('(4) take-a-side: only the MISSING LLM pair is re-reviewed; the kept entry carries forward byte-identical', async () => {
    const dir = copyFixture('merge');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);

      // Reach green — both service nodes' LLM pairs verified.
      const fill1 = await runAsync(['check', '--approve'], dir);
      expect(fill1.status).toBe(0);
      expect(mock.chatCount()).toBe(2); // consensus 1 × 2 LLM pairs.
      const lockBefore = readLock(dir);
      // The KEPT side's entry we will carry forward (orders).
      const keptEntry = JSON.parse(JSON.stringify(lockBefore.verdicts['has-doc-comment']['node:services/orders']));

      // Simulate "git checkout --ours" of a side that verified orders but is
      // MISSING the payments LLM entry (the other branch produced it). The
      // `has-doc-comment` verdicts are LLM verdicts → they live in the committed
      // nondeterministic triad file, which is the file a merge would conflict on.
      // Write the taken side back into THAT file, in a NON-canonical shape (as a
      // tool/human merge might) — the self-validating entries make this safe.
      const sideA = JSON.parse(JSON.stringify(lockBefore));
      delete sideA.verdicts['has-doc-comment']['node:services/payments'];
      writeFileSync(nondetPath(dir), JSON.stringify(sideA, null, 2) + '\n', 'utf-8');

      // The missing LLM pair surfaces as unverified on a plain check.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('unverified (not yet reviewed)');
      expect(check.all).toContain("aspect 'has-doc-comment'");
      expect(check.all).toContain('- services/payments');
      // The kept orders pair stayed valid — it is NOT listed in the unverified group.
      expect(check.all).not.toContain('- services/orders');

      // --approve re-reviews ONLY the missing pair → green. No hand-merge.
      const callsBefore = mock.chatCount();
      const refill = await runAsync(['check', '--approve'], dir);
      expect(refill.status).toBe(0);

      // STRONG OBSERVABLE: exactly ONE new reviewer call — the single missing
      // payments pair. The kept orders pair was NOT re-dispatched.
      expect(mock.chatCount() - callsBefore).toBe(1);
      expect(refill.all).not.toContain('[llm] has-doc-comment on node:services/orders');

      // The kept (orders) entry carried forward byte-identical (no re-review).
      const lockAfter = readLock(dir);
      expect(lockAfter.verdicts['has-doc-comment']['node:services/orders']).toEqual(keptEntry);

      // Final check is green.
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 40000);

  // ===========================================================================
  // (5) PIPED REFUSED-list non-truncation (>200 enforced refusals).
  //
  //   Build a many-node graph, each node with one enforced LLM aspect; seed the
  //   lock with a real `--approve` against an always-refuse mock so every pair is
  //   a VALID cached refusal. Then pipe plain `yg check` (spawnSync captures via
  //   a pipe — the exact truncation trigger) and assert the `Errors (N)` header
  //   count equals the number of rendered `enforced` refusal blocks, with N>200.
  //   This exercises the exitAfterFlush drain for the refusal block shape (longer
  //   cached-marker / three-exit text), not just the cold `unverified` shape.
  // ===========================================================================

  it('(5) >200 cached enforced refusals survive a pipe: Errors(N) header == rendered enforced blocks, N>200', async () => {
    const NODE_COUNT = 210; // > 200 enforced refusal blocks.
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-mergellm-refusals-'));
    const ygRoot = path.join(dir, '.yggdrasil');
    const mock = await startMockReviewer({
      respond: () => ({ satisfied: false, reason: 'seeded refusal reason for the pipe-survival test' }),
    });
    try {
      mkdirSync(path.join(ygRoot, 'model'), { recursive: true });
      mkdirSync(path.join(ygRoot, 'aspects'), { recursive: true });
      mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });

      // One enforced LLM aspect (refused by the mock).
      const aDir = path.join(ygRoot, 'aspects', 'must-have-header');
      mkdirSync(aDir, { recursive: true });
      writeFileSync(
        path.join(aDir, 'yg-aspect.yaml'),
        ['name: must-have-header', 'description: refusal pipe-survival test aspect', 'status: enforced', 'reviewer:', '  type: llm', ''].join('\n'),
        'utf-8',
      );
      writeFileSync(path.join(aDir, 'content.md'), '# must-have-header\n\nEvery file must satisfy must-have-header.\n', 'utf-8');

      // Architecture: one node type carrying the LLM aspect as a default.
      writeFileSync(
        path.join(ygRoot, 'yg-architecture.yaml'),
        ['node_types:', '  svc:', "    description: 'Service node for the refusal pipe test'", '    log_required: false', '    when:', '      path: "src/**"', '    aspects:', '      - must-have-header', ''].join('\n'),
        'utf-8',
      );

      // Config: a single tier pointed at the mock (consensus 1).
      writeFileSync(
        path.join(ygRoot, 'yg-config.yaml'),
        ['version: "6.0.0"', 'quality:', '  max_direct_relations: 10', 'reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      config:', '        model: test', `        endpoint: ${mock.endpoint}`, ''].join('\n'),
        'utf-8',
      );

      // NODE_COUNT nodes, each mapped to a small source file.
      const srcDir = path.join(dir, 'src');
      mkdirSync(srcDir, { recursive: true });
      for (let i = 0; i < NODE_COUNT; i++) {
        const nodeName = `svc${String(i).padStart(3, '0')}`;
        const nodeDir = path.join(ygRoot, 'model', nodeName);
        mkdirSync(nodeDir, { recursive: true });
        writeFileSync(
          path.join(nodeDir, 'yg-node.yaml'),
          [`name: Service ${nodeName}`, 'type: svc', 'description: Refusal pipe test node', 'aspects: []', 'relations: []', 'mapping:', `  - src/${nodeName}.ts`, ''].join('\n'),
          'utf-8',
        );
        writeFileSync(path.join(srcDir, `${nodeName}.ts`), `export const ${nodeName} = '${nodeName}';\n`, 'utf-8');
      }

      // Seed: real fill against the always-refuse mock → every pair a VALID
      // cached refusal in the lock.
      const seed = await runAsync(['check', '--approve'], dir);
      expect(seed.status).toBe(1);
      expect(mock.chatCount()).toBe(NODE_COUNT); // one call per node (consensus 1).

      // Plain `yg check` through a pipe (spawnSync internally pipes stdout).
      const r = spawnSync('node', [BIN_PATH, 'check'], { cwd: dir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
      const stdout = r.stdout ?? '';
      expect(r.status).toBe(1);

      // Strip ANSI so chalk colour codes don't interfere with the match.
      // eslint-disable-next-line no-control-regex
      const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, '');

      // 1. Declared N from the "Errors (N):" header. The grouped redesign may
      //    append " in M groups"; here all refusals share one (code, aspect)
      //    group so M == 1 and the header stays "Errors (N):", but tolerate the
      //    suffix to stay robust. N is still the true ISSUE count.
      const headerMatch = stripped.match(/Errors \((\d+)\)( in \d+ groups)?:/);
      expect(headerMatch, 'Expected "Errors (N)" header in output').not.toBeNull();
      const headerCount = parseInt(headerMatch![1], 10);

      // 2. N well above 200 — a large list that would truncate under the pre-fix
      //    process.exit() behaviour.
      expect(headerCount).toBeGreaterThan(200);

      // 3. Count rendered enforced refusal MEMBER lines. The refusals now render
      //    as ONE grouped enforced block ("  enforced  N pairs  M nodes  aspect
      //    '...'") whose members are listed one-per-line as "            - <node>
      //    Reviewer reason: ...". Count those member bullet lines — that is the
      //    set of refusals that actually survived the pipe.
      const renderedCount = (stripped.match(/^ {12}- svc\d{3}/gm) ?? []).length;

      // 4. Core assertion: every refusal the header declares is rendered — the
      //    refusal list survived the pipe (flush invariant).
      expect(renderedCount).toBe(headerCount);
      // And it really is the cached enforced-refusal shape: the grouped block
      // is labelled `enforced`, carries the cached-refusal rationale, and every
      // member line shows the retained reviewer reason (FULL_WHAT detail).
      expect(stripped).toContain("enforced  210 pairs  210 nodes  aspect 'must-have-header'");
      expect(stripped).toContain('A refused verdict for unchanged inputs is final and cached');
      expect(stripped).toContain('Reviewer reason: seeded refusal reason for the pipe-survival test');
    } finally {
      await mock.close();
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 60000);
});
