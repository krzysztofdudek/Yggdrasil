import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { buildOwnerIndex } from '../../src/relations/owner-index.js';
import { computeEffectiveAspects } from '../../src/core/graph/aspects.js';
import { withParsedFile } from '../../src/ast/parser.js';
import { walk } from '../../src/ast/walk.js';

/**
 * Dogfood invariant — the ATTACH SET of `runcheck-injected-input-parity`.
 *
 * The aspect is attached per node, not by relation (a relation-based `when` was
 * rejected: the test suite deliberately calls runCheck with partial inputs to
 * exercise the very skip behaviour the rule closes, and several nodes that
 * relate to the check engine call runCheck nowhere at all). That leaves the
 * attachment itself free to drift: a fifth runCheck call site introduced in a
 * node that does not carry the aspect would be completely unguarded — the same
 * failure mode the rule exists to prevent, one level up.
 *
 * So the attachment is pinned to the code: the set of PRODUCTION nodes owning a
 * source file with a real runCheck call must equal the set of nodes on which
 * the aspect is effective. Both sides are computed from the repo's own single
 * sources — the owner index for file→node ownership, and the 7-channel
 * effective-aspect computation for attachment — so neither can be satisfied by
 * a second, drifting copy of that logic here.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../../../..');
const ASPECT_ID = 'runcheck-injected-input-parity';

const NON_PRODUCTION_NODE_TYPES = new Set([
  // Test suites deliberately call runCheck with partial inputs — exercising the
  // skip behaviour is how they prove it exists. Requiring parity there would
  // make the behaviour untestable.
  'test-suite',
  // Fixture projects are inert DATA read by tests, never executed as the CLI: a
  // fixture's runCheck is a stand-in, not a surface anyone reads results from.
  'test-fixture',
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'build', 'test-results', 'playwright-report']);

/** Every first-party TypeScript file in the repo. Dot-directories are skipped
 *  wholesale: they hold git internals, sibling worktree checkouts, and the
 *  graph's own drill fixtures — none of them this repo's shipped source. */
function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      collectTsFiles(path.join(dir, entry.name), out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** True when the file contains a real `runCheck(...)` CALL — the same
 *  bare-identifier callee shape the aspect itself matches, so a mention in a
 *  comment, a string, or the declaration site is never counted. */
async function hasRunCheckCall(absPath: string, content: string): Promise<boolean> {
  return withParsedFile(absPath, content, (tree) => {
    let found = false;
    walk(tree.rootNode, (node) => {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (fn?.type === 'identifier' && fn.text === 'runCheck') found = true;
    });
    return found;
  });
}

describe(`${ASPECT_ID} — attach set matches the repo's real call sites`, () => {
  it('every production node owning a runCheck call site carries the aspect, and no other node does', async () => {
    const graph = await loadGraph(REPO_ROOT);
    const ownerOf = buildOwnerIndex(graph.nodes).ownerOf;

    const callSiteOwners = new Set<string>();
    const unmapped: string[] = [];
    for (const abs of collectTsFiles(REPO_ROOT)) {
      const content = readFileSync(abs, 'utf-8');
      if (!content.includes('runCheck')) continue; // cheap prefilter before parsing
      if (!(await hasRunCheckCall(abs, content))) continue;
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      const owner = ownerOf(rel);
      if (!owner) {
        unmapped.push(rel);
        continue;
      }
      if (NON_PRODUCTION_NODE_TYPES.has(graph.nodes.get(owner)?.meta.type ?? '')) continue;
      callSiteOwners.add(owner);
    }

    expect(
      unmapped,
      `runCheck call sites in files no node maps — nothing can guard them: ${unmapped.join(', ')}`,
    ).toEqual([]);

    const carriers = new Set<string>();
    for (const [nodePath, node] of graph.nodes) {
      if (computeEffectiveAspects(node, graph).has(ASPECT_ID)) carriers.add(nodePath);
    }

    const missing = [...callSiteOwners].filter((n) => !carriers.has(n)).sort();
    const extra = [...carriers].filter((n) => !callSiteOwners.has(n)).sort();

    expect(
      missing,
      `nodes owning a runCheck call site but NOT carrying ${ASPECT_ID} — their call sites are unguarded; attach it in their yg-node.yaml: ${missing.join(', ')}`,
    ).toEqual([]);
    expect(
      extra,
      `nodes carrying ${ASPECT_ID} with no runCheck call site — detach it: ${extra.join(', ')}`,
    ).toEqual([]);

    // Sanity: the scan found the repo's real call sites rather than nothing at all.
    expect(callSiteOwners.size).toBeGreaterThanOrEqual(3);
  });
});
