import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import MiniSearch from 'minisearch';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { buildIndex, createMiniSearch } from '../../../src/io/find-index.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setupGraph(opts: { logContent?: string; aspectContent?: string }): Promise<{ projectRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-find-idx-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'billing', 'cancel');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects', 'cancel-end-of-period'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"\n');
  await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), 'node_types:\n  command:\n    description: cmd\n');
  await writeFile(
    path.join(yggRoot, 'model', 'billing', 'yg-node.yaml'),
    'name: billing\ntype: command\ndescription: Billing tier management, cancellation, refunds\n',
  );
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    'name: cancel\ntype: command\ndescription: Subscription cancellation workflow\n',
  );
  if (opts.logContent !== undefined) {
    await writeFile(path.join(nodeDir, 'log.md'), opts.logContent);
  }
  await writeFile(
    path.join(yggRoot, 'aspects', 'cancel-end-of-period', 'yg-aspect.yaml'),
    'name: End of period\ndescription: End-of-period cancellation policy\nreviewer:\n  type: llm\n',
  );
  if (opts.aspectContent !== undefined) {
    await writeFile(path.join(yggRoot, 'aspects', 'cancel-end-of-period', 'content.md'), opts.aspectContent);
  }
  return { projectRoot: root };
}

describe('buildIndex', () => {
  it('emits per-node documents with kind=node and namespaced id', async () => {
    const { projectRoot } = await setupGraph({});
    const graph = await loadGraph(projectRoot);
    const docs = await buildIndex(graph);
    const nodes = docs.filter((d) => d.kind === 'node');
    expect(nodes.find((d) => d.id === 'node:billing/cancel')).toBeDefined();
    expect(nodes.find((d) => d.id === 'node:billing/cancel')!.name).toBe('cancel');
  });

  it('emits per-aspect documents with kind=aspect and namespaced id', async () => {
    const { projectRoot } = await setupGraph({ aspectContent: 'aspect rule.\n' });
    const graph = await loadGraph(projectRoot);
    const docs = await buildIndex(graph);
    const asp = docs.find((d) => d.kind === 'aspect' && d.id === 'aspect:cancel-end-of-period');
    expect(asp).toBeDefined();
    expect(asp!.body).toContain('aspect rule');
  });

  it('namespaced IDs prevent collision when aspect-id equals a node path', async () => {
    const { projectRoot } = await setupGraph({});
    const graph = await loadGraph(projectRoot);
    const docs = await buildIndex(graph);
    const ids = new Set(docs.map((d) => d.id));
    expect(ids.size).toBe(docs.length); // all unique
  });

  it('includes log.md body in node document', async () => {
    const log = '## [2026-05-11T10:00:00.000Z]\nCustomers complained about losing paid days.\n';
    const { projectRoot } = await setupGraph({ logContent: log });
    const graph = await loadGraph(projectRoot);
    const docs = await buildIndex(graph);
    const node = docs.find((d) => d.kind === 'node' && d.id === 'node:billing/cancel');
    expect(node!.body).toContain('Customers complained');
  });

  it('truncates log body to 1MB keeping the tail (newest entries)', async () => {
    const head = '## [2026-05-11T00:00:00.000Z]\nold.\n';
    const middle = '## [2026-05-11T11:00:00.000Z]\n' + 'X'.repeat(2_000_000) + '\n';
    const tail = '## [2026-05-11T12:00:00.000Z]\nFRESH-MARKER\n';
    const { projectRoot } = await setupGraph({ logContent: head + middle + tail });
    const graph = await loadGraph(projectRoot);
    const docs = await buildIndex(graph);
    const node = docs.find((d) => d.kind === 'node' && d.id === 'node:billing/cancel');
    expect(node!.body.length).toBeLessThanOrEqual(1_048_576 + 1024); // 1 MiB + slack
    expect(node!.body).toContain('FRESH-MARKER');
    expect(node!.body).not.toContain('old.');
  });

  it('AST reviewer aspect has empty body (no content.md indexed)', async () => {
    const { projectRoot } = await setupGraph({});
    // Add an AST aspect (reviewer: ast, no content.md)
    const astAspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'ast-only');
    await mkdir(astAspectDir, { recursive: true });
    await writeFile(path.join(astAspectDir, 'yg-aspect.yaml'), 'name: ASTOnly\ndescription: ast check\nreviewer:\n  type: deterministic\nlanguage: [typescript]\n');
    const graph = await loadGraph(projectRoot);
    const docs = await buildIndex(graph);
    const asp = docs.find((d) => d.kind === 'aspect' && d.id === 'aspect:ast-only');
    expect(asp).toBeDefined();
    expect(asp!.body).toBe('');
  });

  it('node and aspect without description default to empty string', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-find-nodesc-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    await mkdir(path.join(yggRoot, 'model', 'nodesc'), { recursive: true });
    await mkdir(path.join(yggRoot, 'aspects', 'nodesc-asp'), { recursive: true });
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"\n');
    await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), 'node_types:\n  command:\n    description: cmd\n');
    await writeFile(path.join(yggRoot, 'model', 'nodesc', 'yg-node.yaml'), 'name: nodesc\ntype: command\n');
    await writeFile(path.join(yggRoot, 'aspects', 'nodesc-asp', 'yg-aspect.yaml'), 'name: nodesc-asp\nreviewer:\n  type: llm\n');
    const graph = await loadGraph(root);
    const docs = await buildIndex(graph);
    const node = docs.find((d) => d.kind === 'node' && d.id === 'node:nodesc');
    const asp = docs.find((d) => d.kind === 'aspect' && d.id === 'aspect:nodesc-asp');
    expect(node!.description).toBe('');
    expect(asp!.description).toBe('');
  });

  it('createMiniSearch returns a configured MiniSearch instance', () => {
    const ms = createMiniSearch();
    expect(ms).toBeInstanceOf(MiniSearch);
  });

  it('truncates via line-aligned fallback when no entry header found', async () => {
    // Content with no '## [' header — forces the else branch in truncateTail
    const padding = 'X'.repeat(2_000_000);
    const tail = '\nTAIL-MARKER\n';
    const { projectRoot } = await setupGraph({ logContent: padding + tail });
    const graph = await loadGraph(projectRoot);
    const docs = await buildIndex(graph);
    const node = docs.find((d) => d.kind === 'node' && d.id === 'node:billing/cancel');
    expect(node!.body).toContain('TAIL-MARKER');
    expect(node!.body.length).toBeLessThanOrEqual(1_048_576 + 1024);
  });

  it('skips symlinked log.md with warning', async () => {
    const { projectRoot } = await setupGraph({});
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', 'billing', 'cancel', 'log.md');
    const target = path.join(projectRoot, 'real.md');
    await writeFile(target, 'symlinked content');
    const { symlink } = await import('node:fs/promises');
    await symlink(target, logPath);
    const graph = await loadGraph(projectRoot);
    const docs = await buildIndex(graph);
    const node = docs.find((d) => d.kind === 'node' && d.id === 'node:billing/cancel');
    expect(node!.body).not.toContain('symlinked content');
  });

  it('indexes a node without its log body (empty, not a crash) when log.md exists but is unreadable (non-ENOENT)', async () => {
    const { projectRoot } = await setupGraph({ logContent: 'some log content' });
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', 'billing', 'cancel', 'log.md');
    // A genuinely unreadable file (EACCES) — a real, non-ENOENT failure mode
    // distinct from "missing", which the reader must surface a warning for
    // rather than silently indexing without a body as if nothing were there.
    await chmod(logPath, 0o000);
    try {
      const graph = await loadGraph(projectRoot);
      const docs = await buildIndex(graph);
      const node = docs.find((d) => d.kind === 'node' && d.id === 'node:billing/cancel');
      expect(node).toBeDefined();
      expect(node!.body).toBe('');
    } finally {
      await chmod(logPath, 0o644); // restore so afterEach's rm can clean up
    }
  });
});
