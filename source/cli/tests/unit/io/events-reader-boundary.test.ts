/**
 * G1 import-boundary guard — fixture test for the REAL dogfood aspect
 * `.yggdrasil/aspects/events-reader-boundary/check.mjs`.
 *
 * The guard is a deterministic aspect verified live by `yg check` against this
 * repo's own source. This test drives the SAME check.mjs (copied verbatim into a
 * hermetic temp fixture at test time, so any edit to the real guard is exercised
 * here) through the production AST runner over synthetic source files placed at
 * the exact repo-relative paths the guard's allowlists key on.
 *
 * It pins the wave-3 appender clause: the write-only appender (`appendVerdictEvent`
 * from io/events-store) is importable ONLY from src/core/fill*.ts, src/cli/drill.ts,
 * and src/cli/aspect-test.ts — any other importer is flagged, while a pure
 * EVENTS_FILENAME / VerdictEvent-type import from events-store is never a hit. It
 * also keeps the pre-existing reader clause honest and self-tests that the appender
 * allowlist's fill*.ts glob still hits a real file in this repo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAstAspect } from '../../../src/ast/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// source/cli/tests/unit/io -> repo root
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const ASPECT_REL = '.yggdrasil/aspects/events-reader-boundary';
const REAL_CHECK = path.join(REPO_ROOT, ASPECT_REL, 'check.mjs');
// The fixture root must live INSIDE the source/cli package so the copied check.mjs
// resolves its `@chrisdudek/yg/ast` import via the package's own `exports`
// self-reference (a check.mjs under /tmp has no such package ancestor). tests/fixtures
// is excluded from both typecheck (tsconfig.check) and vitest collection, so the
// synthetic .ts payloads placed here are never compiled or run as tests.
const FIXTURE_PARENT = path.resolve(__dirname, '../../fixtures');

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(FIXTURE_PARENT, 'g1-boundary-'));
  // Copy the REAL guard verbatim so the test exercises the current source.
  const dstDir = path.join(projectRoot, ASPECT_REL);
  mkdirSync(dstDir, { recursive: true });
  writeFileSync(path.join(dstDir, 'check.mjs'), readFileSync(REAL_CHECK, 'utf-8'));
});

afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

/** Write a synthetic source file at a repo-relative POSIX path under the fixture root. */
function writeSource(relPath: string, content: string): void {
  const abs = path.join(projectRoot, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Run the copied guard over the given repo-relative file paths; return the set of flagged paths. */
async function runGuard(relPaths: string[]): Promise<Set<string>> {
  const { violations } = await runAstAspect({
    aspectDir: ASPECT_REL,
    aspectId: 'events-reader-boundary',
    files: relPaths.map((p) => ({ path: p })),
    projectRoot,
  });
  return new Set(violations.map((v) => v.file));
}

const IMPORT_APPENDER = `import { appendVerdictEvent } from '../io/events-store.js';\nexport function e() { appendVerdictEvent('r', {} as never); }\n`;

describe('events-reader-boundary — appender clause (G1)', () => {
  it('flags a non-producer that imports the appender, and clears every sanctioned producer', async () => {
    // Allowlisted appender importers — NOT flagged.
    writeSource('source/cli/src/core/fill.ts', IMPORT_APPENDER);
    writeSource('source/cli/src/core/fill-llm.ts', IMPORT_APPENDER); // fill*.ts glob
    writeSource('source/cli/src/cli/drill.ts', IMPORT_APPENDER); // not-yet-present in repo, allowlisted
    writeSource('source/cli/src/cli/aspect-test.ts', IMPORT_APPENDER);

    // Non-allowlisted appender importers — FLAGGED.
    writeSource('source/cli/src/core/verify.ts', IMPORT_APPENDER); // core, not fill*
    writeSource('source/cli/src/cli/render.ts', IMPORT_APPENDER); // cli, not drill/aspect-test
    writeSource(
      'source/cli/src/core/sneaky.ts',
      `import * as store from '../io/events-store.js';\nexport const x = store;\n`, // namespace exposes appender
    );
    writeSource(
      'source/cli/src/core/reexport.ts',
      `export { appendVerdictEvent } from '../io/events-store.js';\n`, // re-export republishes it
    );
    writeSource(
      'source/cli/src/core/star-reexport.ts',
      `export * from '../io/events-store.js';\n`, // bare `export *` re-export republishes it
    );
    writeSource(
      'source/cli/src/core/ns-reexport.ts',
      `export * as store from '../io/events-store.js';\n`, // `export * as ns` re-export exposes it
    );

    // Legitimate constant / type imports from events-store — NEVER flagged (carve-out).
    writeSource(
      'source/cli/src/io/events-reader.ts',
      `import { EVENTS_FILENAME, type VerdictEvent } from './events-store.js';\nexport const f = EVENTS_FILENAME;\nexport type V = VerdictEvent;\n`,
    );
    writeSource(
      'source/cli/src/cli/log.ts',
      `import type { VerdictEvent } from '../io/events-store.js';\nexport type V = VerdictEvent;\n`,
    );

    const flagged = await runGuard([
      'source/cli/src/core/fill.ts',
      'source/cli/src/core/fill-llm.ts',
      'source/cli/src/cli/drill.ts',
      'source/cli/src/cli/aspect-test.ts',
      'source/cli/src/core/verify.ts',
      'source/cli/src/cli/render.ts',
      'source/cli/src/core/sneaky.ts',
      'source/cli/src/core/reexport.ts',
      'source/cli/src/core/star-reexport.ts',
      'source/cli/src/core/ns-reexport.ts',
      'source/cli/src/io/events-reader.ts',
      'source/cli/src/cli/log.ts',
    ]);

    // Exactly the six non-producers are flagged.
    expect(flagged).toEqual(
      new Set([
        'source/cli/src/core/verify.ts',
        'source/cli/src/cli/render.ts',
        'source/cli/src/core/sneaky.ts',
        'source/cli/src/core/reexport.ts',
        'source/cli/src/core/star-reexport.ts',
        'source/cli/src/core/ns-reexport.ts',
      ]),
    );
    // The sanctioned producers and the constant/type importers are clear.
    for (const clean of [
      'source/cli/src/core/fill.ts',
      'source/cli/src/core/fill-llm.ts',
      'source/cli/src/cli/drill.ts',
      'source/cli/src/cli/aspect-test.ts',
      'source/cli/src/io/events-reader.ts',
      'source/cli/src/cli/log.ts',
    ]) {
      expect(flagged.has(clean)).toBe(false);
    }
  });

  it('still enforces the reader clause: engine core may not import the events-reader', async () => {
    writeSource(
      'source/cli/src/core/check.ts',
      `import { readVerdictEvents } from '../io/events-reader.js';\nexport const r = readVerdictEvents;\n`,
    );
    const flagged = await runGuard(['source/cli/src/core/check.ts']);
    expect(flagged.has('source/cli/src/core/check.ts')).toBe(true);
  });

  it('appender allowlist glob still hits a real file in this repo (fill*.ts is not a dead entry)', async () => {
    // The allowlist names cli/drill.ts, which does not exist yet — permissible, since
    // the guard fires on unexpected importers, not absent allowed ones. But at least
    // one allowlist pattern (src/core/fill*.ts) MUST match a real repo file, or the
    // allowlist would be effectively dead and every real producer would be flagged.
    const coreDir = path.join(REPO_ROOT, 'source/cli/src/core');
    const fillFiles = readdirSync(coreDir).filter((f) => /^fill[^/]*\.ts$/.test(f));
    expect(fillFiles.length).toBeGreaterThan(0);

    // Drive the guard against the ACTUAL repo filename to prove the glob recognizes it.
    const realName = fillFiles[0];
    writeSource(`source/cli/src/core/${realName}`, IMPORT_APPENDER);
    const flagged = await runGuard([`source/cli/src/core/${realName}`]);
    expect(flagged.has(`source/cli/src/core/${realName}`)).toBe(false);
  });
});
