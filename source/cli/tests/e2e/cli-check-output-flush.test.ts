// =============================================================================
// Regression test: yg check output must survive pipe truncation.
//
// Pre-fix behaviour: `formatOutput` wrote a large string via process.stdout.write()
// then called process.exit(1) immediately. When stdout was a PIPE (exactly what
// spawnSync produces), the kernel-side buffer drained asynchronously; process.exit()
// terminated the process before the buffer was fully consumed, silently truncating
// the rendered error list. The symptom: `Errors (N)` header reported e.g. 595 but
// only 168 rendered lines reached the pipe consumer.
//
// Fix: exitAfterFlush() in src/cli/check.ts waits for process.stdout.writableLength
// to drain before calling process.exit(). This guarantees the full report survives.
//
// This test creates a graph with many LLM-aspect nodes so that `yg check` (cold,
// no lock) produces well over 200 unverified pairs in a single run. In the
// Phase-1 GROUPED default output those pairs render as ONE group block per
// distinct (code, aspectId) — here three aspect groups — and EACH pair surfaces
// as a `- <node>` affected-node line inside its group. The flush invariant is that
// EVERY one of those node lines (one per pair the header counts) survives the
// pipe: the count of rendered `- <node>` lines must equal the N from the
// "Errors (N) in M groups:" header AND N > 200. A regression of the truncation
// bug would cause the rendered node-line count to be less than N, breaking the
// assertion. (Piped stdout is NOT a TTY, so the per-group node-list cap never
// truncates — every member node renders.)
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');

const distExists = existsSync(BIN_PATH);

// A loopback reviewer endpoint that is never dialed by `yg check`.
const LOOPBACK_ENDPOINT = 'http://127.0.0.1:11434';

// Number of nodes to create. Each node gets 3 LLM aspects (from architecture
// type defaults) = 3 × NODE_COUNT unverified aspect pairs. These nodes have no
// cross-node dependency, so the live relation pass adds no error blocks.
// 75 nodes × 3 aspects = 225 unverified aspect errors (well above the 200 threshold).
const NODE_COUNT = 75;

/**
 * Build a hermetic tmp project containing NODE_COUNT nodes each with 3 LLM
 * aspects (attached via architecture type default aspects).  With no lock file
 * present, every (node, aspect) pair is unverified → `yg check` exits 1 and
 * emits 225 unverified error blocks through the pipe.
 */
function buildFlushFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-check-output-flush-'));
  const ygRoot = path.join(dir, '.yggdrasil');

  mkdirSync(path.join(ygRoot, 'model'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'aspects'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });

  // Three LLM aspects. Content is minimal but valid — the reviewer is never
  // invoked by `yg check` (only by fill), so the content text is irrelevant to
  // the assertion. What matters is that these are LLM aspects (content.md
  // present, no check.mjs) so they produce `unverified` errors on a cold lock.
  for (const id of ['must-have-header', 'must-have-exports', 'must-have-types']) {
    const aDir = path.join(ygRoot, 'aspects', id);
    mkdirSync(aDir, { recursive: true });
    writeFileSync(
      path.join(aDir, 'yg-aspect.yaml'),
      [
        `name: ${id}`,
        'description: Regression flush test aspect',
        'status: enforced',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      path.join(aDir, 'content.md'),
      `# ${id}\n\nEvery file must satisfy ${id}.\n`,
      'utf-8',
    );
  }

  // Architecture: one node type with the three LLM aspects as defaults, so
  // every node of this type automatically carries all three aspects without
  // needing to list them individually in each yg-node.yaml.
  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    [
      'node_types:',
      '  svc:',
      "    description: 'Service node for flush regression test'",
      '    log_required: false',
      '    when:',
      '      path: "src/**"',
      '    aspects:',
      '      - must-have-header',
      '      - must-have-exports',
      '      - must-have-types',
      '',
    ].join('\n'),
    'utf-8',
  );

  // Config: one tier (never dialed — check is read-only).
  writeFileSync(
    path.join(ygRoot, 'yg-config.yaml'),
    [
      'quality:',
      '  max_direct_relations: 10',
      'reviewer:',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: test',
      `        endpoint: ${LOOPBACK_ENDPOINT}`,
      '',
    ].join('\n'),
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
      [
        `name: Service ${nodeName}`,
        'type: svc',
        'description: Flush regression test node',
        'aspects: []',
        'relations: []',
        'mapping:',
        `  - src/${nodeName}.ts`,
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      path.join(srcDir, `${nodeName}.ts`),
      `export const ${nodeName} = '${nodeName}';\n`,
      'utf-8',
    );
  }

  return dir;
}

describe.skipIf(!distExists)('CLI E2E — yg check output survives pipe (flush regression)', () => {
  it('header count equals rendered affected-node line count and N > 200 through a pipe (grouped output)', () => {
    // spawnSync captures stdout via a pipe internally — this is exactly the
    // scenario that triggered the truncation bug. If exitAfterFlush regresses,
    // the rendered count will be less than the header count.
    const dir = buildFlushFixture();
    try {
      const r = spawnSync('node', [BIN_PATH, 'check'], {
        cwd: dir,
        encoding: 'utf-8',
        // Default maxBuffer (200KB) is plenty for our output, but set it large
        // enough that spawnSync itself never truncates before we get to assert.
        maxBuffer: 32 * 1024 * 1024,
      });

      const stdout = r.stdout ?? '';
      // Strip ANSI escape sequences first so chalk colour codes don't interfere.
      // eslint-disable-next-line no-control-regex
      const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, '');

      // 1. Parse the declared N from the grouped "Errors (N) in M groups:" header.
      //    The Phase-1 default view carries the optional " in M groups" segment
      //    whenever there is more than one group; here the 3 aspects form 3 groups,
      //    so the segment is present. Tolerate both shapes so a 1-group regression
      //    still parses N rather than silently failing the match.
      const headerMatch = stripped.match(/Errors \((\d+)\)(?: in (\d+) groups)?:/);
      expect(headerMatch, 'Expected "Errors (N)[ in M groups]:" header in output').not.toBeNull();
      const headerCount = parseInt(headerMatch![1], 10);
      const groupCount = headerMatch![2] !== undefined ? parseInt(headerMatch![2], 10) : 1;

      // 2. N must be well above 200 — proves we are exercising a large list that
      //    would have been truncated under the pre-fix process.exit() behaviour.
      expect(headerCount).toBeGreaterThan(200);

      // 3. All three LLM aspects now collapse into ONE group (unverified groups by
      //    CODE ONLY since Phase 1.6 — the group header carries no aspect segment;
      //    instead each body-line shows "  aspect '<id>'"). So groupCount = 1.
      expect(groupCount).toBe(1);

      // 4. Exactly ONE unverified group header (no aspect segment in the header).
      const groupHeaders = stripped.match(
        /^ {2}unverified \(not yet reviewed\) {2}\d+ pairs {2}\d+ nodes$/gm,
      ) ?? [];
      expect(groupHeaders.length).toBe(1);

      // 5. The single group header's "<P> pairs" count must equal the header N.
      const pairSum = groupHeaders.reduce((acc, line) => {
        const m = line.match(/(\d+) pairs/);
        return acc + (m ? parseInt(m[1], 10) : 0);
      }, 0);
      expect(pairSum).toBe(headerCount);

      // 6. Count rendered affected-node lines. Each unverified pair surfaces as a
      //    "            - svcNNN  aspect '<id>'" bullet inside the group block
      //    (12-space indent + "- " + node path + "  aspect '<id>'"). These
      //    self-contained nodes have no cross-node dependency, so the live relation
      //    pass adds no relation-undeclared block. The flush invariant: EVERY pair
      //    the header declares is rendered as a bullet.
      const nodeLineCount = (stripped.match(/^ {12}- svc\d{3} {2}aspect '[^']+'$/gm) ?? []).length;
      // 75 nodes × 3 LLM aspects = 225 affected-node lines, each unverified cold.
      expect(nodeLineCount).toBe(225);
      // No relation-undeclared block (no cross-node dependency in the fixture).
      expect(stripped.match(/^ {2}relation-undeclared-dependency {2}/gm)).toBeNull();

      // 7. The core assertion: every error the header declares must be rendered as
      //    an affected-node bullet. Under the truncation bug, the rendered bullet
      //    count would be less than headerCount for large outputs.
      expect(nodeLineCount).toBe(headerCount);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Stream split: --approve progress goes to STDERR; STDOUT carries only the
// final check report. This invariant lets callers capture a clean, parseable
// report on stdout without progress noise, while still observing fill progress
// on stderr.
//
// This test creates a tiny fixture with ONE deterministic pair (a check.mjs
// aspect) so that `yg check --approve` produces exactly one `[det] …` progress
// line and a final `yg check:` report line. The assertion:
//   - STDOUT does NOT contain the `[det]` / `Filling` progress lines.
//   - STDOUT DOES contain the `yg check:` final report header.
//   - STDERR DOES contain the `[det]` / `Filling` progress lines.
//   - STDERR does NOT contain the `yg check:` final report header.
//
// Dry-run (--approve --dry-run) is the exception: its write sink stays on
// STDOUT because the budget breakdown IS the command's deliverable output, not
// background progress. This file does not test the dry-run path; it is covered
// by the unit tests in tests/unit/cli/check.test.ts.
// =============================================================================

/**
 * Build a hermetic fixture with one node + one deterministic aspect (always
 * approves). The deterministic pair is unverified on cold lock, so
 * `yg check --approve` must fill it and emit exactly one `[det]` progress line.
 */
function buildStreamSplitFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-stream-split-'));
  const ygRoot = path.join(dir, '.yggdrasil');

  mkdirSync(path.join(ygRoot, 'model', 'widgets'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'aspects', 'no-forbidden'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });
  mkdirSync(path.join(dir, 'src'), { recursive: true });

  // Deterministic aspect that always approves (no violations in source).
  writeFileSync(
    path.join(ygRoot, 'aspects', 'no-forbidden', 'yg-aspect.yaml'),
    ['name: no-forbidden', 'description: Stream split test aspect', 'status: enforced', ''].join('\n'),
    'utf-8',
  );
  // check.mjs: accepts ctx and returns an empty violation array — always approves.
  writeFileSync(
    path.join(ygRoot, 'aspects', 'no-forbidden', 'check.mjs'),
    [
      'export function check(ctx) {',
      '  // No forbidden tokens in this fixture — always approve.',
      '  return [];',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  // Architecture: one node type with the deterministic aspect as default.
  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    [
      'node_types:',
      '  widget:',
      "    description: 'Stream split test node type'",
      '    log_required: false',
      '    when:',
      '      path: "src/**"',
      '    aspects:',
      '      - no-forbidden',
      '',
    ].join('\n'),
    'utf-8',
  );

  // Config: reviewer section required even for deterministic-only projects.
  // Point the endpoint at the dead loopback so no network call is ever made.
  writeFileSync(
    path.join(ygRoot, 'yg-config.yaml'),
    [
      'quality:',
      '  max_direct_relations: 10',
      'reviewer:',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: test',
      `        endpoint: ${LOOPBACK_ENDPOINT}`,
      '',
    ].join('\n'),
    'utf-8',
  );

  // One node + source file.
  writeFileSync(
    path.join(ygRoot, 'model', 'widgets', 'yg-node.yaml'),
    [
      'name: Widget',
      'type: widget',
      'description: Stream split test node',
      'aspects: []',
      'relations: []',
      'mapping:',
      '  - src/widget.ts',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(dir, 'src', 'widget.ts'),
    "export const widget = 'widget';\n",
    'utf-8',
  );

  return dir;
}

describe.skipIf(!distExists)('CLI E2E — yg check --approve stream split (progress to stderr, report to stdout)', () => {
  it('STDOUT contains only the final yg check: report; STDERR contains the [det] progress and Filling lines', () => {
    const dir = buildStreamSplitFixture();
    try {
      // spawnSync with encoding captures both stdout and stderr separately —
      // exactly the scenario this invariant must hold for.
      const r = spawnSync('node', [BIN_PATH, 'check', '--approve', '--only-deterministic'], {
        cwd: dir,
        encoding: 'utf-8',
        maxBuffer: 4 * 1024 * 1024,
      });

      // Strip ANSI so pattern matching is not confused by colour codes.
      // eslint-disable-next-line no-control-regex
      const strip = (s: string): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
      const stdout = strip(r.stdout);
      const stderr = strip(r.stderr);

      // STDOUT: the final report header must be present.
      expect(stdout).toMatch(/yg check: (PASS|FAIL)/);

      // STDOUT: progress lines must NOT appear.
      expect(stdout).not.toMatch(/\[det\]/);
      expect(stdout).not.toContain('Filling');

      // STDERR: fill progress must be present.
      expect(stderr).toContain('Filling');

      // STDERR: the final report header must NOT appear (it lives on stdout).
      expect(stderr).not.toMatch(/yg check: (PASS|FAIL)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
