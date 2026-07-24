import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { buildOwnerIndex } from '../../src/relations/owner-index.js';
import { computeEffectiveAspects } from '../../src/core/graph/aspects.js';

/**
 * Dogfood invariant — the ATTACH SET of `rules-artifact-names-single-source`.
 *
 * The guard self-scopes by DIRECTORY: it inspects every file under
 * `source/cli/src/`, which is what lets it see a FOURTH consumer that re-types
 * an installed-artifact name in a module nobody has written yet. But a check can
 * only inspect files it is HANDED — the subject files of the nodes the aspect is
 * effective on. So the directory scope is only as wide as the attachment: with
 * the aspect detached from the CLI root, the guard would still be a correct rule
 * inspecting nothing at all, and every test would stay green.
 *
 * The other permanent test for this aspect (tests/unit/io/…-single-source.test.ts)
 * cannot catch that: it drives the check over a hermetic temp project and never
 * reads the real graph. This one closes the gap from the other side — the set of
 * nodes owning a file inside the guard's scope must be a subset of the nodes the
 * aspect is effective on, computed through the repo's own single sources (the
 * owner index for file→node ownership, the 7-channel effective-aspect
 * computation for attachment), so neither side can be satisfied by a second,
 * drifting copy of that logic here.
 *
 * The converse direction is deliberately NOT asserted: the aspect cascades from
 * the CLI root onto every descendant, including test-suite and fixture nodes that
 * own no file inside the scope. Those extra carriers cost nothing — the check
 * skips their files without inspection — and requiring the sets to be equal would
 * forbid the one attachment that makes the scope complete.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../../../..');
const ASPECT_ID = 'rules-artifact-names-single-source';
/** The guard's own scope prefix. Pinned to check.mjs by the first test below. */
const GUARDED_PREFIX = 'source/cli/src/';
const CHECK_MJS = path.join(REPO_ROOT, '.yggdrasil', 'aspects', ASPECT_ID, 'check.mjs');

/** Every TypeScript file under the guard's scope, repo-relative POSIX. */
function collectScopedFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectScopedFiles(full, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
    }
  }
  return out;
}

describe(`${ASPECT_ID} — attach set covers the guard's whole scope`, () => {
  it("the scope prefix this test asserts against is the one the guard actually uses", () => {
    expect(
      readFileSync(CHECK_MJS, 'utf-8'),
      `check.mjs no longer scopes on '${GUARDED_PREFIX}' — update this test to the guard's real prefix`,
    ).toContain(`const GUARDED_PREFIX = '${GUARDED_PREFIX}';`);
  });

  it('every node owning a file inside the guarded scope carries the aspect', async () => {
    const graph = await loadGraph(REPO_ROOT);
    const ownerOf = buildOwnerIndex(graph.nodes).ownerOf;

    const scopedFiles = collectScopedFiles(path.join(REPO_ROOT, GUARDED_PREFIX));
    const owners = new Set<string>();
    const unmapped: string[] = [];
    for (const rel of scopedFiles) {
      const owner = ownerOf(rel);
      if (!owner) {
        unmapped.push(rel);
        continue;
      }
      owners.add(owner);
    }

    expect(
      unmapped,
      `files inside the guard's scope that no node maps — the guard is never handed them: ${unmapped.join(', ')}`,
    ).toEqual([]);

    const carriers = new Set<string>();
    for (const [nodePath, node] of graph.nodes) {
      if (computeEffectiveAspects(node, graph).has(ASPECT_ID)) carriers.add(nodePath);
    }

    const missing = [...owners].filter((n) => !carriers.has(n)).sort();
    expect(
      missing,
      `nodes owning a file under ${GUARDED_PREFIX} but NOT carrying ${ASPECT_ID} — their files are never inspected, so a re-typed artifact name there is unguarded; attach the aspect (it cascades from the CLI root node): ${missing.join(', ')}`,
    ).toEqual([]);

    // Sanity: the scan resolved the real source tree rather than nothing at all.
    expect(owners.size).toBeGreaterThanOrEqual(20);
  });
});
