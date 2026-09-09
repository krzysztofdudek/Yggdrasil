import { describe, it, expect } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { checkRelationTargets } from '../../../src/core/checks/relations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Integration coverage for the loader's own contract, one level above
// node-parser.test.ts: a port without `aspects` must not just PARSE cleanly in
// isolation, it must leave the whole subtree in the graph and leave a third
// node's relation onto it resolvable. The second case pins the known cascade
// (a malformed port field still drops the parent's children) as-is, not as
// desired — see 001-port-aspects-optional.md.

describe('loadGraph — a port without aspects does not cascade-drop its subtree', () => {
  it('parent (port without aspects), its child, and a third relation-referencing node all survive with no parse errors', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-loader-port-aspects-ok');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model');
    await mkdir(path.join(modelDir, 'parent', 'child'), { recursive: true });
    await mkdir(path.join(modelDir, 'third'), { recursive: true });
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"', 'utf-8');
    await writeFile(
      path.join(modelDir, 'parent', 'yg-node.yaml'),
      'name: Parent\ntype: service\nports:\n  charge:\n    description: "Charge port"\n',
      'utf-8',
    );
    await writeFile(
      path.join(modelDir, 'parent', 'child', 'yg-node.yaml'),
      'name: Child\ntype: service\n',
      'utf-8',
    );
    await writeFile(
      path.join(modelDir, 'third', 'yg-node.yaml'),
      'name: Third\ntype: service\nrelations:\n  - target: parent\n    type: uses\n',
      'utf-8',
    );

    try {
      const graph = await loadGraph(tmpDir);

      expect(graph.nodes.has('parent')).toBe(true);
      expect(graph.nodes.has('parent/child')).toBe(true);
      expect(graph.nodes.has('third')).toBe(true);
      expect(graph.nodeParseErrors).toBeUndefined();

      // 'third' targets 'parent', which loaded — no relation-target issue.
      // A crashing parse would have removed 'parent' and turned this into a
      // relation-broken finding; this is the "nothing cascades" assertion.
      expect(checkRelationTargets(graph)).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('a scalar ports.<name>.aspects produces exactly one parse error naming the field, and still drops the parent\'s child (known cascade, pinned as-is)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-loader-port-aspects-scalar');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model');
    await mkdir(path.join(modelDir, 'parent', 'child'), { recursive: true });
    await mkdir(path.join(modelDir, 'third'), { recursive: true });
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"', 'utf-8');
    await writeFile(
      path.join(modelDir, 'parent', 'yg-node.yaml'),
      'name: Parent\ntype: service\nports:\n  charge:\n    description: "Charge port"\n    aspects: "x"\n',
      'utf-8',
    );
    await writeFile(
      path.join(modelDir, 'parent', 'child', 'yg-node.yaml'),
      'name: Child\ntype: service\n',
      'utf-8',
    );
    await writeFile(
      path.join(modelDir, 'third', 'yg-node.yaml'),
      'name: Third\ntype: service\nrelations:\n  - target: parent\n    type: uses\n',
      'utf-8',
    );

    try {
      const graph = await loadGraph(tmpDir);

      expect(graph.nodeParseErrors).toHaveLength(1);
      expect(graph.nodeParseErrors?.[0].nodePath).toBe('parent');
      expect(graph.nodeParseErrors?.[0].messageData.what).toContain('parent');
      expect(graph.nodeParseErrors?.[0].messageData.why).toContain('ports.charge.aspects');

      expect(graph.nodes.has('parent')).toBe(false);
      // Known/inherited behavior: scanModelDirectory returns as soon as its OWN
      // yg-node.yaml fails to parse, before it ever recurses into children — so
      // the child is never visited at all, not merely "excluded".
      expect(graph.nodes.has('parent/child')).toBe(false);
      expect(graph.nodes.has('third')).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
