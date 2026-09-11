// =============================================================================
// CLI E2E — read-command cost bounds on this repository's own graph.
//
// A SEPARATE file from cli-other-worktree.test.ts on purpose, and the two must
// stay separate: this file is slow (it runs full commands against the largest
// graph available) and exists for a different job. It asserts BOUNDS, never a
// median — do not "tighten" these into the numbers from docs/concurrency.md's
// measured table. That table is a documentation input, produced by hand outside
// the test suite; this file is a hard gate that only needs to catch an
// order-of-magnitude regression (a command that used to return in seconds now
// hanging, or an output that used to be megabytes now unbounded). Blurring the
// two — making this file assert the median, or making the docs table read from
// this file's bound — would either make the gate flaky on ordinary machine
// variance, or make the documented number a moving target no one can quote.
//
// The 60-second bound is an EXPLICIT TIMEOUT on the spawned process, not a
// timestamp comparison: `spawnSync`'s own `timeout` option kills the child and
// leaves `status: null` if it runs over, which then fails the ordinary
// `expect(status).toBe(0)` every scenario already makes. No test body ever
// reads `Date.now()` or asserts on an elapsed duration — that is what the
// `test-deterministic` aspect (every test-suite node, content.md) actually
// forbids, and a value comparison against a wall-clock reading would trip it
// even at a 60-second margin. A process-level timeout enforced by the OS is not
// that: it is the same mechanism `it(..., timeoutMs)` already uses everywhere
// in this suite (e.g. cli-check-json.test.ts's own 180_000ms override) to say
// "this must finish, not hang" without turning elapsed time into a value the
// test's pass/fail logic branches on.
//
//   1. yg aspects --json           → exits 0, under the time and size ceiling
//  1b. yg aspects --json --reach   → the enumerated form, same ceilings
//   2. yg context --node --json    → exits 0, under the time and size ceiling
//   3. yg check --json             → exits 0, under the time and size ceiling
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
// The repository this CLI is developed in — its own graph is the largest real
// one available, the same one docs/concurrency.md's measured table is taken
// against.
const REPO_ROOT = path.resolve(CLI_ROOT, '..', '..');
const distExists = existsSync(BIN_PATH);

// Generous bounds: not a median, a regression floor. 60s and 32MB are the
// ticket's own stated ceilings — an order of magnitude above anything observed
// (docs/concurrency.md's table shows single-digit seconds and low single-digit
// megabytes on this same graph).
const TIME_CEILING_MS = 60_000;
const SIZE_CEILING_BYTES = 32 * 1024 * 1024;

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  // `timeout` is the 60s bound itself: spawnSync kills the child and reports
  // status: null if it fires, which fails the plain `toBe(0)` check below —
  // no elapsed-time value is ever read or compared.
  // maxBuffer above the size ceiling itself (mirrors cli-check-json.test.ts) so
  // a run that actually breaches the bound is captured and failed on its real
  // size, rather than being cut off and thrown as an ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
  const r = spawnSync('node', [BIN_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: SIZE_CEILING_BYTES * 2,
    timeout: TIME_CEILING_MS,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

describe.skipIf(!distExists)('CLI E2E — read-command cost bounds (this repository\'s own graph)', () => {
  it('1: yg aspects --json exits 0, under the time and size ceiling', () => {
    const result = run(['aspects', '--json']);
    expect(result.status, result.stderr).toBe(0);
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThan(SIZE_CEILING_BYTES);
  }, TIME_CEILING_MS + 15_000);

  it('2: yg context --node --json exits 0, under the time and size ceiling', () => {
    // Any real node works for a bound test; cli/core/fill is the node
    // docs/concurrency.md measures against (the one with the most pairs in
    // this repository's own `yg check --json`), reused here for consistency.
    const result = run(['context', '--node', 'cli/core/fill', '--json']);
    expect(result.status, result.stderr).toBe(0);
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThan(SIZE_CEILING_BYTES);
  }, TIME_CEILING_MS + 15_000);

  it('1b: yg aspects --json --reach exits 0, under the time and size ceiling', () => {
    // The enumerated form of case 1: one row per (rule, unit) instead of one per
    // rule, so it is the read whose size grows with the graph rather than with
    // the rule count. Same ceilings — the point of the bound is that naming
    // every unit stays a cheap read on a real graph, not that it is free.
    const result = run(['aspects', '--json', '--reach']);
    expect(result.status, result.stderr).toBe(0);
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThan(SIZE_CEILING_BYTES);
  }, TIME_CEILING_MS + 15_000);

  it('3: yg check --json exits 0, under the time and size ceiling', () => {
    const result = run(['check', '--json']);
    expect(result.status, result.stderr).toBe(0);
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThan(SIZE_CEILING_BYTES);
  }, TIME_CEILING_MS + 15_000);
});
