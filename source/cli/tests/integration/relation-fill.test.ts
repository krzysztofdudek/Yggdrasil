/**
 * Integration test for relation conformance under the `yg check --approve` fill
 * stage (core/fill.ts) — now that relations are computed LIVE and never cached.
 *
 * Relations are no longer written to the lock: there is no `relation_verdicts`
 * section. `--approve` (runFill) ends with a live `runCheck` re-read whose
 * relation result is the current truth; a plain `runCheck` (no --approve)
 * computes the same result. TypeScript extraction is LIVE: node a's
 * `src/a/foo.ts` imports node b's file, so a genuinely depends on b. The fixture
 * DECLARES that dependency (a --uses--> b, an allowed service→service relation)
 * so the resolved cross-node edge is sanctioned and both nodes are approved. We
 * assert:
 *
 *   1. After runFill, the lock has NO `relation_verdicts` and is format v1; the
 *      live check carries no relation error; a separate plain runCheck agrees.
 *   2. A plain runCheck (no --approve) catches a newly-undeclared dependency.
 *
 * The graph has ZERO LLM aspects, so runFill completes deterministically with no
 * reviewer calls (a reviewer section is still required — it gates --approve —
 * but is never invoked).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runFill } from '../../src/core/fill.js';
import { runCheck } from '../../src/core/check.js';
import { readLock } from '../../src/io/lock-store.js';

function writeNode(
  root: string,
  nodeRel: string,
  name: string,
  mapping: string,
  relations = '',
): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'yg-node.yaml'),
    `name: ${name}\ntype: service\n${relations}mapping:\n  - ${mapping}\n`,
    'utf-8',
  );
}

describe('relation pass wired into runFill (integration)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-fill-'));

    // Architecture: a single mapping-capable type 'service'.
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    // `service uses service` is allowed so the declared a --uses--> b relation
    // (added below) is a sanctioned target for the resolved cross-node import.
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n    relations:\n      uses: [service]\n`,
      'utf-8',
    );
    // A reviewer section is mandatory (config-reviewer-missing gates --approve),
    // even though there are zero LLM aspects so it is never invoked.
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n',
      'utf-8',
    );

    // Node a imports node b's file (live TS extraction resolves it), so a
    // genuinely depends on b — declare a --uses--> b so the edge is sanctioned
    // and both nodes are approved (this suite asserts the approved-persist path).
    writeNode(root, 'a', 'A', 'src/a', 'relations:\n  - target: b\n    type: uses\n');
    writeNode(root, 'b', 'B', 'src/b');

    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'a', 'foo.ts'),
      "import { bar } from '../b/bar';\nexport const foo = bar;\n",
      'utf-8',
    );
    writeFileSync(path.join(root, 'src', 'b', 'bar.ts'), 'export const bar = 2;\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('runFill writes NO relation_verdicts and the live check agrees on the relation result', async () => {
    const graph = await loadGraph(root);
    const fill = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    // The lock has no relation cache at all — relations are computed live. Each
    // split file is absent when its section is empty (empty → no file); read
    // whichever exist, assert no stray relation_verdicts, then confirm the merged
    // lock version.
    const readIfExists = (p: string) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');
    for (const name of ['yg-lock.nondeterministic.json', 'yg-lock.logs.json', '.yg-lock.deterministic.json']) {
      expect(readIfExists(path.join(graph.rootPath, name))).not.toContain('relation_verdicts');
    }
    expect(readLock(graph.rootPath).version).toBe(1);

    // a --uses--> b is declared, so the live pass approves both → no relation error.
    const liveIssues = fill.checkResult.issues.filter((i) => i.code === 'relation-undeclared-dependency');
    expect(liveIssues).toHaveLength(0);

    // A separate plain runCheck (live) reports the SAME relation result.
    const check = await runCheck(await loadGraph(root), null);
    expect(check.issues.filter((i) => i.code === 'relation-undeclared-dependency')).toHaveLength(0);
  });

  it('a plain runCheck (no --approve) catches a newly-undeclared dependency', async () => {
    // Remove a's declared relation so the live import becomes undeclared.
    writeNode(root, 'a', 'A', 'src/a'); // no relations stanza
    const check = await runCheck(await loadGraph(root), null);
    const aIssues = check.issues.filter((i) => i.code === 'relation-undeclared-dependency' && i.nodePath === 'a');
    expect(aIssues).toHaveLength(1);
    expect(aIssues[0].severity).toBe('error');
  });
});
