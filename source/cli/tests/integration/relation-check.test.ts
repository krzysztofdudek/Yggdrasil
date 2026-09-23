/**
 * Integration: runCheck computes relation conformance LIVE — no seeded lock,
 * no relation_verdicts. An undeclared cross-node import is reported as a blocking
 * relation-undeclared-dependency error every run; a declared relation clears it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runCheck } from '../../src/core/check.js';

const CODE = 'relation-undeclared-dependency';

function writeNode(root: string, nodeRel: string, name: string, yaml: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'yg-node.yaml'), yaml, 'utf-8');
}
function relIssuesFor(issues: { code: string; nodePath?: string; severity: string }[], nodeId: string) {
  return issues.filter((i) => i.code === CODE && i.nodePath === nodeId);
}

describe('runCheck — relation conformance computed live', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-check-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n    relations:\n      uses: [service]\n`,
      'utf-8',
    );
    writeFileSync(path.join(root, '.yggdrasil', 'yg-config.yaml'), `version: "6.0.0"\nquality:\n  max_direct_relations: 10\n`, 'utf-8');
    writeNode(root, 'b', 'B', 'name: B\ntype: service\nmapping:\n  - src/b\n');
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
    // a/foo.ts imports b/bar.ts across the node boundary.
    writeFileSync(path.join(root, 'src', 'a', 'foo.ts'), "import { x } from '../b/bar.js';\nexport const foo = x;\n", 'utf-8');
    writeFileSync(path.join(root, 'src', 'b', 'bar.ts'), 'export const x = 1;\n', 'utf-8');
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('reports an undeclared cross-node dependency live, with NO seeded lock', async () => {
    writeNode(root, 'a', 'A', 'name: A\ntype: service\nmapping:\n  - src/a\n'); // no relation
    const graph = await loadGraph(root);
    const result = await runCheck(graph, null); // null git files → skip coverage

    const aIssues = relIssuesFor(result.issues, 'a');
    expect(aIssues).toHaveLength(1);
    expect(aIssues[0].severity).toBe('error');
    expect(relIssuesFor(result.issues, 'b')).toHaveLength(0);
  });

  it('clears the violation once the relation is declared', async () => {
    writeNode(root, 'a', 'A', 'name: A\ntype: service\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/a\n');
    const graph = await loadGraph(root);
    const result = await runCheck(graph, null);
    expect(result.issues.filter((i) => i.code === CODE)).toHaveLength(0);
  });
});
