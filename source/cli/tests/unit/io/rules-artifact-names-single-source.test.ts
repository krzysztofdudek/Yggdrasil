/**
 * Rules-artifact-names single-source guard — fixture test for the REAL dogfood
 * aspect `.yggdrasil/aspects/rules-artifact-names-single-source/check.mjs`.
 *
 * The guard is a deterministic aspect verified live by `yg check` against this
 * repo's own source. It is DIRECTORY-scoped to the shipped CLI source tree
 * (`source/cli/src/**`), which still makes it un-drillable — a `yg drill` case
 * always resolves under `.yggdrasil/aspects/<id>/drills/`, never under that
 * prefix, exactly like the directory-scoped `no-buildissuemessage-in-engine`
 * (see the `DRILL_EXEMPT` entries in `tests/unit/dogfood-enforced-det-drills.test.ts`).
 * This test drives the SAME check.mjs (copied verbatim into a hermetic temp
 * fixture at test time, so any edit to the real guard is exercised here) through
 * the production AST runner over synthetic source files placed at repo-relative
 * paths inside and outside that scope.
 *
 * Scope coverage is `yg check`'s job — the aspect cascades onto every CLI node,
 * so every mapped source file in the tree is a real subject there. What this
 * test pins is the guard's DECISION rules: what the prefix covers, the two
 * exclusions (owning module, test tree), the one documented per-value
 * exemption, and the literal-matching semantics.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAstAspect } from '../../../src/ast/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// source/cli/tests/unit/io -> repo root
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const ASPECT_REL = '.yggdrasil/aspects/rules-artifact-names-single-source';
const REAL_CHECK = path.join(REPO_ROOT, ASPECT_REL, 'check.mjs');
// The fixture root must live INSIDE the source/cli package so the copied check.mjs
// resolves its `@chrisdudek/yg/ast` import via the package's own `exports`
// self-reference. tests/fixtures is excluded from both typecheck and vitest
// collection, so the synthetic .ts payloads placed here are never compiled or run.
const FIXTURE_PARENT = path.resolve(__dirname, '../../fixtures');
// Dot-prefixed and gitignored: tests/fixtures holds COMMITTED fixture projects,
// and a crashed or interrupted run would otherwise leave synthetic trees sitting
// among them, indistinguishable from real ones in `git status`.
const TMP_PREFIX = '.tmp-rules-artifact-names-';

const PLATFORM_PATH = 'source/cli/src/templates/platform.ts';
const RULES_ARTIFACTS_PATH = 'source/cli/src/cli/rules-artifacts.ts';
const DIGEST_GATE_PATH = 'source/cli/src/core/checks/digest-gate.ts';
const OWNING_MODULE_PATH = 'source/cli/src/utils/rules-artifact-names.ts';
const SUPPRESS_ELIGIBILITY_PATH = 'source/cli/src/portal/api/suppress-eligibility.ts';

let projectRoot: string;

/** Remove every temp tree left by an earlier crashed or interrupted run. */
function sweepStaleFixtures(): void {
  for (const entry of readdirSync(FIXTURE_PARENT, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(TMP_PREFIX)) {
      rmSync(path.join(FIXTURE_PARENT, entry.name), { recursive: true, force: true });
    }
  }
}

beforeAll(sweepStaleFixtures);
afterAll(sweepStaleFixtures);

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(FIXTURE_PARENT, TMP_PREFIX));
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

/** Copy a real repo file into the hermetic fixture at its own repo-relative path. */
function mirrorRealFile(relPath: string): void {
  writeSource(relPath, readFileSync(path.join(REPO_ROOT, relPath), 'utf-8'));
}

/** Run the copied guard over the given repo-relative file paths; return the set of flagged paths. */
async function runGuard(relPaths: string[]): Promise<Set<string>> {
  const { violations } = await runAstAspect({
    aspectDir: ASPECT_REL,
    aspectId: 'rules-artifact-names-single-source',
    files: relPaths.map((p) => ({ path: p })),
    projectRoot,
  });
  return new Set(violations.map((v) => v.file));
}

describe('rules-artifact-names-single-source', () => {
  it('flags a hardcoded AGENTS.md / CLAUDE.md literal in each of the three historically-drifted consumers', async () => {
    writeSource(PLATFORM_PATH, `export const a = 'AGENTS.md';\nexport const c = 'CLAUDE.md';\n`);
    writeSource(RULES_ARTIFACTS_PATH, `export const a = 'AGENTS.md';\n`);
    writeSource(DIGEST_GATE_PATH, `export const a = 'AGENTS.md';\n`);

    const flagged = await runGuard([PLATFORM_PATH, RULES_ARTIFACTS_PATH, DIGEST_GATE_PATH]);

    expect(flagged).toEqual(new Set([PLATFORM_PATH, RULES_ARTIFACTS_PATH, DIGEST_GATE_PATH]));
  });

  it('flags a FOURTH consumer anywhere under the source tree — the drift the rule exists for', async () => {
    // No module lives at any of these paths today. The directory scope is what
    // makes them covered the day someone writes one; an allowlist of the three
    // already-fixed files would see none of them.
    const fresh = [
      'source/cli/src/cli/some-new-command.ts',
      'source/cli/src/core/checks/some-new-check.ts',
      'source/cli/src/portal/api/some-new-endpoint.ts',
      'source/cli/src/io/some-new-reader.ts',
    ];
    for (const rel of fresh) writeSource(rel, `export const host = 'AGENTS.md';\n`);

    const flagged = await runGuard(fresh);

    expect(flagged).toEqual(new Set(fresh));
  });

  it('flags the .clinerules directory literal and the standalone yggdrasil.md filename literal', async () => {
    writeSource(
      PLATFORM_PATH,
      `import path from 'node:path';\nexport const p = path.join('root', '.clinerules', 'yggdrasil.md');\n`,
    );
    const flagged = await runGuard([PLATFORM_PATH]);
    expect(flagged.has(PLATFORM_PATH)).toBe(true);
  });

  it('flags the combined .clinerules/yggdrasil.md label and the lowercased @agents.md import spelling', async () => {
    writeSource(
      DIGEST_GATE_PATH,
      `export const label = '.clinerules/yggdrasil.md';\n` +
        `export const isImport = (l) => l.toLowerCase() === '@agents.md';\n`,
    );
    const flagged = await runGuard([DIGEST_GATE_PATH]);
    expect(flagged.has(DIGEST_GATE_PATH)).toBe(true);
  });

  it('matching is case-insensitive but exact — a differently-cased literal is caught, a mere substring is not', async () => {
    writeSource(PLATFORM_PATH, `export const a = 'Agents.MD';\n`); // case-variant spelling — still a hit
    writeSource(
      RULES_ARTIFACTS_PATH,
      // A real retired legacy path that CONTAINS 'yggdrasil.md' as a substring but is
      // not equal to it — must NOT be flagged (substring, not exact value).
      `export const legacy = '.windsurf/rules/yggdrasil.md';\n`,
    );
    const flagged = await runGuard([PLATFORM_PATH, RULES_ARTIFACTS_PATH]);
    expect(flagged.has(PLATFORM_PATH)).toBe(true);
    expect(flagged.has(RULES_ARTIFACTS_PATH)).toBe(false);
  });

  it('a longer label that merely opens with one of the names is not a hit — display labels are not path resolution', async () => {
    writeSource(DIGEST_GATE_PATH, `export const where = 'AGENTS.md digest block';\n`);
    const flagged = await runGuard([DIGEST_GATE_PATH]);
    expect(flagged.has(DIGEST_GATE_PATH)).toBe(false);
  });

  it('an escaped literal is never truncated into a false hit', async () => {
    // Reading only the first string fragment would decode this as 'AGENTS.md'
    // and report a name that was never typed as a whole value.
    writeSource(DIGEST_GATE_PATH, `export const banner = 'AGENTS.md\\n----------';\n`);
    const flagged = await runGuard([DIGEST_GATE_PATH]);
    expect(flagged.has(DIGEST_GATE_PATH)).toBe(false);
  });

  it('an interpolated template literal built from the shared constant is never a hit', async () => {
    writeSource(
      DIGEST_GATE_PATH,
      `import { AGENTS_FILENAME } from '../../utils/rules-artifact-names.js';\n` +
        'export const label = `${AGENTS_FILENAME} digest block`;\n',
    );
    const flagged = await runGuard([DIGEST_GATE_PATH]);
    expect(flagged.has(DIGEST_GATE_PATH)).toBe(false);
  });

  it('the owning module itself is excluded — it may hold every literal freely', async () => {
    writeSource(
      OWNING_MODULE_PATH,
      `export const AGENTS_FILENAME = 'AGENTS.md';\n` +
        `export const CLAUDE_FILENAME = 'CLAUDE.md';\n` +
        `export const CLINERULES_DIR = '.clinerules';\n` +
        `export const CLINERULES_FILENAME = 'yggdrasil.md';\n`,
    );
    const flagged = await runGuard([OWNING_MODULE_PATH]);
    expect(flagged.size).toBe(0);
  });

  it('the test tree is outside the scope — a fixture asserting on these names is data, not a second definition', async () => {
    const testFile = 'source/cli/tests/unit/some-installer.test.ts';
    writeSource(testFile, `export const expected = 'AGENTS.md';\n`);
    const flagged = await runGuard([testFile]);
    expect(flagged.size).toBe(0);
  });

  it("the documented '.clinerules' exemption covers exactly one value in one file, not the whole file", async () => {
    writeSource(
      SUPPRESS_ELIGIBILITY_PATH,
      // The legacy single-file base name — same bytes as the directory constant
      // by coincidence, not by shared definition, so it is exempt.
      `export const isLegacy = (b: string) => b === '.clinerules';\n` +
        // Any OTHER guarded name in the same file is still a hit.
        `export const host = 'AGENTS.md';\n`,
    );
    const { violations } = await runAstAspect({
      aspectDir: ASPECT_REL,
      aspectId: 'rules-artifact-names-single-source',
      files: [{ path: SUPPRESS_ELIGIBILITY_PATH }],
      projectRoot,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('AGENTS.md');
  });

  it('self-test: every file the guard names in its scope, exclusion, or exemption still exists', () => {
    for (const rel of [
      PLATFORM_PATH,
      RULES_ARTIFACTS_PATH,
      DIGEST_GATE_PATH,
      OWNING_MODULE_PATH,
      SUPPRESS_ELIGIBILITY_PATH,
    ]) {
      expect(existsSync(path.join(REPO_ROOT, rel)), `${rel} no longer exists`).toBe(true);
    }
  });

  it('self-test: the exemption is not dead — the real file still carries the legacy base-name literal', () => {
    const src = readFileSync(path.join(REPO_ROOT, SUPPRESS_ELIGIBILITY_PATH), 'utf-8');
    expect(src).toContain("'.clinerules'");
  });

  it('self-test: the real consumers and the exempted file satisfy the guard as committed', async () => {
    // Mirror the real files' CONTENT into the hermetic fixture (at the same
    // repo-relative paths) rather than pointing the runner at REPO_ROOT directly —
    // the copied check.mjs resolves `@chrisdudek/yg/ast` only from inside the
    // source/cli package boundary (see the fixture-root note above), which
    // REPO_ROOT is not. The WHOLE tree is covered by `yg check`, which runs this
    // same aspect live over every mapped CLI source file.
    const real = [PLATFORM_PATH, RULES_ARTIFACTS_PATH, DIGEST_GATE_PATH, OWNING_MODULE_PATH, SUPPRESS_ELIGIBILITY_PATH];
    for (const rel of real) mirrorRealFile(rel);
    const flagged = await runGuard(real);
    expect(flagged.size).toBe(0);
  });
});
