// =============================================================================
// COMPANION PROMPT-SIZE GATE — integration E2E.
//
// Regression for the verify-lock §4 size gate over-counting companion-bearing LLM
// aspects. The fixture's companion READS a large reachable file (payloads/big.txt,
// ~80 KB) to decide, but INJECTS only a small paired payload (payloads/small.txt).
//
//   Buggy behaviour: plain `yg check` reconstructed the gate's companion set from
//   the stored `touched` read: keys — which conflate the large DECISION read with
//   the small INJECTED companion — so it measured a prompt ~the size of big.txt and
//   falsely flagged prompt-too-large.
//
//   Fixed behaviour: the gate runs the companion resolver LIVE (the same path fill
//   uses) and measures ONLY the returned small.txt. A companion that fails to
//   resolve during the gate surfaces a clear diagnostic.
//
// HERMETIC: fresh mkdtemp copy of the fixture per test, in-process Ollama-protocol
// mock reviewer (runAsync, never spawnSync while the mock serves), rmSync in finally.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-companion-size');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const companionPath = (d: string) =>
  path.join(d, '.yggdrasil', 'aspects', 'broad-companion', 'companion.mjs');

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/g, `endpoint: "${endpoint}"`), 'utf-8');
}
function setLimit(dir: string, chars: number): void {
  const p = cfgPath(dir);
  writeFileSync(
    p,
    readFileSync(p, 'utf-8').replace(/( {4}standard:\n {6}provider: ollama\n {6}consensus: 1\n)/, `$1      max_prompt_chars: ${chars}\n`),
    'utf-8',
  );
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-companion-size-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — companion prompt-size gate', () => {
  // The companion injects only the small payload, so the real assembled prompt is a
  // few KB. With a limit ABOVE the real prompt but FAR BELOW big.txt (~80 KB), a
  // gate that measured the decision-read would flag prompt-too-large; the live-resolve
  // gate measures the small real prompt and stays green.
  it('a companion that reads big but injects small stays UNDER a limit above the real prompt', async () => {
    const dir = copyFixture('green');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Fill with no limit → green, stores touched with read:big.txt + read:small.txt.
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);

      // 30000 is above the real prompt (~KB) and far below big.txt (~80 KB).
      setLimit(dir, 30000);
      const after = run(['check'], dir);
      expect(after.all).not.toContain('prompt-too-large');
      expect(after.status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // Lower the limit BELOW the real small prompt → prompt-too-large, but the gate must
  // measure the SMALL real prompt (a few KB), never ~80 KB. The default grouped
  // `yg check` view no longer prints the per-issue char count, so the over-count is
  // proven two ways that survive the output redesign:
  //   (a) `yg check` at limit 200 DOES flag prompt-too-large (the real prompt > 200);
  //   (b) `yg aspect-test --dry-run` (unchanged by the redesign) resolves the
  //       companion LIVE and prints the assembled prompt — it injects ONLY small.txt
  //       (never big.txt) and the whole prompt is a few KB (< 30000). A gate that
  //       measured the ~80 KB decision-read could not produce a sub-30 KB prompt.
  it('over-limit reports the REAL small char count, not the decision-read size', async () => {
    const dir = copyFixture('realsize');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);

      setLimit(dir, 200);
      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      expect(after.all).toContain('prompt-too-large');
      expect(after.all).toContain('broad-companion'); // the gate names the over-limit pair's aspect.

      // The assembled prompt the gate measures is exposed verbatim by aspect-test's
      // dry-run (no reviewer call, lock untouched). It injects only the small payload
      // and is a few KB — proving the gate measured the small injected companion, not
      // the ~80 KB decision-read. (At a 200-char limit the dry-run cannot assemble, so
      // raise the limit above the real prompt first; the limit is not a verdict input
      // and aspect-test never writes the lock.)
      writeFileSync(cfgPath(dir), readFileSync(cfgPath(dir), 'utf-8').replace(/max_prompt_chars: \d+/, 'max_prompt_chars: 30000'), 'utf-8');
      const dry = await runAsync(['aspect-test', '--aspect', 'broad-companion', '--node', 'docs', '--dry-run'], dir);
      expect(dry.status).toBe(0);
      // Only the small payload is injected as a companion — never the large decision-read.
      expect(dry.all).toContain('payloads/small.txt');
      expect(dry.all).not.toContain('payloads/big.txt');
      // The assembled prompt is a few KB; big.txt alone is ~80 KB. Must be well under.
      expect(dry.all.length).toBeGreaterThan(200);
      expect(dry.all.length).toBeLessThan(30000);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // A broken companion.mjs (throws) with a tier limit set. Plain `yg check` executes
  // no repository code, so it does not run the hook: the pair is unverified and the
  // report says its size check waits for --approve. `--approve` runs the hook and
  // surfaces a CLEAR diagnostic naming the aspect and the hook's own error.
  it('a broken companion is not run by plain `yg check`; `yg check --approve` surfaces its error', async () => {
    const dir = copyFixture('broken');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      setLimit(dir, 30000);
      writeFileSync(companionPath(dir), 'export function companion() {\n  throw new Error("companion boom");\n}\n', 'utf-8');

      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      expect(after.all).toContain('broad-companion');
      expect(after.all).toContain('companion.mjs was not run');
      expect(after.all).not.toContain('boom');

      const approve = run(['check', '--approve'], dir);
      expect(approve.status).toBe(1);
      expect(approve.all).toContain('broad-companion');
      expect(approve.all).toContain('boom');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);
});
