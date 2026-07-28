/**
 * Instrument import-fence guard — fixture test for the REAL dogfood aspect
 * `.yggdrasil/aspects/instrument-import-fence/check.mjs`.
 *
 * The guard is a deterministic aspect verified live by `yg check` against this
 * repo's own source. This test drives the SAME check.mjs (copied verbatim into a
 * hermetic temp fixture at test time, so any edit to the real guard is exercised
 * here) through the production AST runner over synthetic source files placed at
 * the exact repo-relative paths the guard's allowlists key on.
 *
 * It pins the wave-6 feature-field clause (c): the READER (core/feature-index-read)
 * is importable ONLY by cli/build-context.ts and cli/advise.ts; the WRITER
 * (core/feature-index-write) ONLY by core/check.ts; test code is exempt; a
 * statement-level type-only import is never a hit. It also keeps the pre-existing
 * gating clause (a) honest, and self-tests that BOTH guarded modules exist in this
 * repo (so the guard globs are not dead entries).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAstAspect } from '../../../src/ast/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// source/cli/tests/unit/io -> repo root
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const ASPECT_REL = '.yggdrasil/aspects/instrument-import-fence';
const REAL_CHECK = path.join(REPO_ROOT, ASPECT_REL, 'check.mjs');
// The fixture root must live INSIDE the source/cli package so the copied check.mjs
// resolves its `@chrisdudek/yg/ast` import via the package's own `exports`
// self-reference. tests/fixtures is excluded from both typecheck and vitest
// collection, so the synthetic .ts payloads placed here are never compiled or run.
const FIXTURE_PARENT = path.resolve(__dirname, '../../fixtures');

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(FIXTURE_PARENT, 'instrument-fence-'));
  const dstDir = path.join(projectRoot, ASPECT_REL);
  mkdirSync(dstDir, { recursive: true });
  writeFileSync(path.join(dstDir, 'check.mjs'), readFileSync(REAL_CHECK, 'utf-8'));
});

afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

function writeSource(relPath: string, content: string): void {
  const abs = path.join(projectRoot, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Run the copied guard over the given repo-relative file paths; return the set of flagged paths. */
async function runGuard(relPaths: string[]): Promise<Set<string>> {
  const { violations } = await runAstAspect({
    aspectDir: ASPECT_REL,
    aspectId: 'instrument-import-fence',
    files: relPaths.map((p) => ({ path: p })),
    projectRoot,
  });
  return new Set(violations.map((v) => v.file));
}

const IMPORT_READER = `import { readFeatureFieldEntry } from '../core/feature-index-read.js';\nexport const r = readFeatureFieldEntry;\n`;
const IMPORT_WRITER = `import { writeFeatureIndex } from '../core/feature-index-write.js';\nexport const w = writeFeatureIndex;\n`;

describe('instrument-import-fence — feature-field clause (c)', () => {
  it('READER: only cli/build-context.ts and cli/advise.ts may import it; everyone else is flagged', async () => {
    // Allowlisted reader importers — NOT flagged.
    writeSource('source/cli/src/cli/build-context.ts', IMPORT_READER);
    writeSource('source/cli/src/cli/advise.ts', IMPORT_READER);
    // Non-allowlisted importers — FLAGGED (a gating module, a plain core module, a cli command).
    writeSource('source/cli/src/core/check.ts', IMPORT_READER); // gating module — attention must not reach the gate
    writeSource('source/cli/src/core/fill.ts', IMPORT_READER);
    writeSource('source/cli/src/cli/drill.ts', IMPORT_READER);
    // Re-export form is a hit too.
    writeSource('source/cli/src/core/reexport.ts', `export { readFeatureFieldEntry } from '../core/feature-index-read.js';\n`);

    const flagged = await runGuard([
      'source/cli/src/cli/build-context.ts',
      'source/cli/src/cli/advise.ts',
      'source/cli/src/core/check.ts',
      'source/cli/src/core/fill.ts',
      'source/cli/src/cli/drill.ts',
      'source/cli/src/core/reexport.ts',
    ]);

    expect(flagged).toEqual(
      new Set([
        'source/cli/src/core/check.ts',
        'source/cli/src/core/fill.ts',
        'source/cli/src/cli/drill.ts',
        'source/cli/src/core/reexport.ts',
      ]),
    );
    expect(flagged.has('source/cli/src/cli/build-context.ts')).toBe(false);
    expect(flagged.has('source/cli/src/cli/advise.ts')).toBe(false);
  });

  it('WRITER: only core/check.ts may import it; everyone else is flagged', async () => {
    writeSource('source/cli/src/core/check.ts', IMPORT_WRITER); // the sole allowed writer importer
    writeSource('source/cli/src/cli/check.ts', IMPORT_WRITER); // gating cli module — flagged
    writeSource('source/cli/src/core/fill.ts', IMPORT_WRITER); // other core — flagged
    writeSource('source/cli/src/cli/build-context.ts', IMPORT_WRITER); // reader-allowed, but NOT writer-allowed

    const flagged = await runGuard([
      'source/cli/src/core/check.ts',
      'source/cli/src/cli/check.ts',
      'source/cli/src/core/fill.ts',
      'source/cli/src/cli/build-context.ts',
    ]);

    expect(flagged).toEqual(
      new Set([
        'source/cli/src/cli/check.ts',
        'source/cli/src/core/fill.ts',
        'source/cli/src/cli/build-context.ts',
      ]),
    );
    expect(flagged.has('source/cli/src/core/check.ts')).toBe(false);
  });

  it('a statement-level type-only import of the reader/writer is never a hit (erased at compile)', async () => {
    writeSource(
      'source/cli/src/core/types-only.ts',
      `import type { FeatureFieldEntry } from '../core/feature-index-read.js';\n` +
        `import type { FeatureFieldIndex } from '../core/feature-index-write.js';\n` +
        `export type A = FeatureFieldEntry;\nexport type B = FeatureFieldIndex;\n`,
    );
    const flagged = await runGuard(['source/cli/src/core/types-only.ts']);
    expect(flagged.has('source/cli/src/core/types-only.ts')).toBe(false);
  });

  it('test code is exempt — a test file may import either the reader or the writer', async () => {
    writeSource('source/cli/tests/unit/core/reader.test.ts', IMPORT_READER);
    writeSource('source/cli/tests/integration/writer.test.ts', IMPORT_WRITER);
    const flagged = await runGuard([
      'source/cli/tests/unit/core/reader.test.ts',
      'source/cli/tests/integration/writer.test.ts',
    ]);
    expect(flagged.size).toBe(0);
  });

  it('still enforces the wave-2 gating clause (a): a gating module may not import the metrics core', async () => {
    writeSource(
      'source/cli/src/core/check.ts',
      `import { computeMetrics } from '../core/graph-metrics.js';\nexport const m = computeMetrics;\n`,
    );
    const flagged = await runGuard(['source/cli/src/core/check.ts']);
    expect(flagged.has('source/cli/src/core/check.ts')).toBe(true);
  });

  it('gating clause (a): a gating module may not import the node-churn instrument (and node-churn.ts is real)', async () => {
    // node-churn is a read-only signal input (only cli/advise.ts imports it today). The
    // fence bans it on the gating path for parity with graph-metrics and events-reader —
    // an instrument can never decide whether the build passes. Self-test the glob is not
    // dead: the real module must exist, and the ban must fire on a gating module keyed on
    // its actual filename while leaving a non-gating importer (cli/advise.ts) alone.
    expect(existsSync(path.join(REPO_ROOT, 'source/cli/src/core/node-churn.ts'))).toBe(true);
    const IMPORT_CHURN = `import { countChurnByNode } from '../core/node-churn.js';\nexport const c = countChurnByNode;\n`;
    writeSource('source/cli/src/cli/group-issues.ts', IMPORT_CHURN); // gating module — FLAGGED
    writeSource('source/cli/src/cli/advise.ts', IMPORT_CHURN); // non-gating importer — allowed
    const flagged = await runGuard([
      'source/cli/src/cli/group-issues.ts',
      'source/cli/src/cli/advise.ts',
    ]);
    expect(flagged.has('source/cli/src/cli/group-issues.ts')).toBe(true);
    expect(flagged.has('source/cli/src/cli/advise.ts')).toBe(false);
  });

  it('gating clause (a) covers the check command\'s three render units (check-render-header/-groups/-views)', async () => {
    // The check command was split into a slimmed orchestrator (cli/check.ts) plus
    // three render files that jointly compute the SAME issue-emission/exit-code
    // surface cli/check.ts used to compute inline (formatOutput's dispatch,
    // residualAfterNext, issuePriorityRank-driven ordering) — the same reason
    // group-issues.ts is gated. Each must be fenced individually.
    const IMPORT_METRICS = `import { computeMetrics } from '../core/graph-metrics.js';\nexport const m = computeMetrics;\n`;
    writeSource('source/cli/src/cli/check-render-header.ts', IMPORT_METRICS);
    writeSource('source/cli/src/cli/check-render-groups.ts', IMPORT_METRICS);
    writeSource('source/cli/src/cli/check-render-views.ts', IMPORT_METRICS);
    const flagged = await runGuard([
      'source/cli/src/cli/check-render-header.ts',
      'source/cli/src/cli/check-render-groups.ts',
      'source/cli/src/cli/check-render-views.ts',
    ]);
    expect(flagged).toEqual(
      new Set([
        'source/cli/src/cli/check-render-header.ts',
        'source/cli/src/cli/check-render-groups.ts',
        'source/cli/src/cli/check-render-views.ts',
      ]),
    );
  });

  it('self-test: BOTH guarded modules exist in this repo (the guard globs are not dead)', () => {
    // If either module were renamed/removed without updating the guard, the fence would
    // be silently vacuous. Assert both real files exist AND that the guard flags a
    // forbidden import keyed on each real filename.
    expect(existsSync(path.join(REPO_ROOT, 'source/cli/src/core/feature-index-read.ts'))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, 'source/cli/src/core/feature-index-write.ts'))).toBe(true);
  });

  it('self-test: the guard catches a forbidden import of each real module by its actual filename', async () => {
    writeSource('source/cli/src/core/rogue-reader.ts', IMPORT_READER);
    writeSource('source/cli/src/core/rogue-writer.ts', IMPORT_WRITER);
    const flagged = await runGuard([
      'source/cli/src/core/rogue-reader.ts',
      'source/cli/src/core/rogue-writer.ts',
    ]);
    expect(flagged.has('source/cli/src/core/rogue-reader.ts')).toBe(true);
    expect(flagged.has('source/cli/src/core/rogue-writer.ts')).toBe(true);
  });
});
