import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { classifyDrift } from '../../../src/core/check.js';
import { approveNode } from '../../../src/core/approve.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/utils/hash.js';
import { collectTrackedFiles } from '../../../src/core/context-files.js';
import { filterCascadeNodes } from '../../../src/cli/approve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function createBatchProject(name: string) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-batch-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(
    path.join(yggRoot, 'yg-config.yaml'),
    'name: BatchTest\n',
  );

  // Create aspect
  const aspDir = path.join(yggRoot, 'aspects', 'audit');
  await mkdir(aspDir, { recursive: true });
  await writeFile(path.join(aspDir, 'yg-aspect.yaml'), 'name: Audit\ndescription: audit aspect\n');
  await writeFile(path.join(aspDir, 'rules.md'), 'Log all data mutations.\n');

  // Create parent node (no mapping)
  const parentDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(parentDir, { recursive: true });
  await writeFile(path.join(parentDir, 'yg-node.yaml'), 'name: Services\ntype: module\ndescription: parent\n');

  // Create two child nodes with mapping and aspect
  for (const child of ['alpha', 'beta']) {
    const nodeDir = path.join(yggRoot, 'model', 'svc', child);
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(nodeDir, 'yg-node.yaml'),
      `name: ${child}\ntype: service\ndescription: ${child} service\naspects:\n  - audit\nmapping:\n  - src/${child}/\n`);
    await writeFile(path.join(nodeDir, 'responsibility.md'), `${child} responsibility.\n`);

    const srcDir = path.join(tmpDir, 'src', child);
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'index.ts'), `export const ${child} = true;\n`);
  }

  return { tmpDir, yggRoot };
}

async function recordAllBaselines(tmpDir: string) {
  const graph = await loadGraph(tmpDir);
  for (const [nodePath, node] of graph.nodes) {
    if (!node.meta.mapping) continue;
    const trackedFiles = collectTrackedFiles(node, graph);
    const projectRoot = path.dirname(graph.rootPath);
    const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
      projectRoot, trackedFiles, undefined, [],
    );
    await writeNodeDriftState(graph.rootPath, nodePath, {
      hash: canonicalHash,
      files: fileHashes,
      mtimes: fileMtimes,
    });
  }
}

describe('Batch approve integration', () => {
  it('filters cascade nodes by aspect cause prefix', async () => {
    const { tmpDir, yggRoot } = await createBatchProject('aspect-filter');
    await recordAllBaselines(tmpDir);

    // Modify aspect to trigger cascade
    await writeFile(path.join(yggRoot, 'aspects/audit/rules.md'), 'Updated: log ALL operations.\n');

    const graph = await loadGraph(tmpDir);
    const issues = await classifyDrift(graph);

    const yggPrefix = path.relative(tmpDir, yggRoot).split(path.sep).join('/');
    const matched = filterCascadeNodes(issues, `${yggPrefix}/aspects/audit/`);

    expect(matched.sort()).toEqual(['svc/alpha', 'svc/beta']);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('filters cascade nodes by parent model prefix for no-mapping parent', async () => {
    const { tmpDir, yggRoot } = await createBatchProject('parent-filter');
    await recordAllBaselines(tmpDir);

    // Modify parent artifact to trigger cascade
    await writeFile(path.join(yggRoot, 'model/svc/responsibility.md'), 'Updated parent responsibility.\n');

    const graph = await loadGraph(tmpDir);
    const issues = await classifyDrift(graph);

    const yggPrefix = path.relative(tmpDir, yggRoot).split(path.sep).join('/');
    const e021 = issues.filter(i => i.code === 'E021');
    expect(e021.length).toBeGreaterThan(0);

    const matched = filterCascadeNodes(issues, `${yggPrefix}/model/svc/`);
    expect(matched.sort()).toEqual(['svc/alpha', 'svc/beta']);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('batch approveNode with --reviewed accepts cascade-only drift', async () => {
    const { tmpDir, yggRoot } = await createBatchProject('batch-reviewed');
    await recordAllBaselines(tmpDir);

    // Modify aspect to trigger cascade
    await writeFile(path.join(yggRoot, 'aspects/audit/rules.md'), 'Updated audit rules.\n');

    const graph = await loadGraph(tmpDir);
    const issues = await classifyDrift(graph);
    const yggPrefix = path.relative(tmpDir, yggRoot).split(path.sep).join('/');
    const matched = filterCascadeNodes(issues, `${yggPrefix}/aspects/audit/`);
    expect(matched.length).toBeGreaterThan(0);

    // Approve each with --reviewed
    for (const nodePath of matched) {
      const result = await approveNode(graph, nodePath, {
        reviewed: 'aspect change reviewed',
      });
      expect(result.action).not.toBe('refused');
    }

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('batch approveNode without --reviewed refuses cascade-only drift', async () => {
    const { tmpDir, yggRoot } = await createBatchProject('batch-no-reviewed');
    await recordAllBaselines(tmpDir);

    // Modify aspect to trigger cascade
    await writeFile(path.join(yggRoot, 'aspects/audit/rules.md'), 'Updated audit rules.\n');

    const graph = await loadGraph(tmpDir);
    const issues = await classifyDrift(graph);
    const yggPrefix = path.relative(tmpDir, yggRoot).split(path.sep).join('/');
    const matched = filterCascadeNodes(issues, `${yggPrefix}/aspects/audit/`);
    expect(matched.length).toBeGreaterThan(0);

    // Approve each WITHOUT --reviewed
    for (const nodePath of matched) {
      const result = await approveNode(graph, nodePath, {});
      expect(result.action).toBe('refused');
    }

    await rm(tmpDir, { recursive: true, force: true });
  });
});
