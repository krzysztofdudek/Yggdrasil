import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

describe('graph-loader', () => {
  it('throws when model/ directory does not exist', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-no-model');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'config.yaml'),
      'name: T\nnode_types: [service]\nartifacts:\n  responsibility:\n    required: always\n    description: x',
      'utf-8',
    );

    try {
      await expect(loadGraph(tmpDir)).rejects.toThrow('model/ does not exist');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('loads graph with correct number of nodes from model/', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);

    expect(graph.nodes.size).toBe(7);

    expect(graph.nodes.has('auth')).toBe(true);
    expect(graph.nodes.has('auth/auth-api')).toBe(true);
    expect(graph.nodes.has('orders')).toBe(true);
    expect(graph.nodes.has('orders/order-service')).toBe(true);
    expect(graph.nodes.has('users')).toBe(true);
    expect(graph.nodes.has('users/user-repo')).toBe(true);
    expect(graph.nodes.has('users/missing-service')).toBe(true);
  });

  it('loads flows from flows/ directory', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);

    expect(graph.flows).toHaveLength(1);
    expect(graph.flows[0].name).toBe('Checkout Flow');
    expect(graph.flows[0].nodes).toContain('auth/auth-api');
    expect(graph.flows[0].nodes).toContain('orders/order-service');
  });

  it('populates flow.path with the directory name', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);

    expect(graph.flows).toHaveLength(1);
    expect(graph.flows[0].path).toBe('checkout-flow');
  });

  it('loads aspects correctly', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);

    expect(graph.aspects).toHaveLength(2);
    const audit = graph.aspects.find((a) => a.id === 'requires-audit');
    const logging = graph.aspects.find((a) => a.id === 'requires-logging');
    expect(audit?.name).toBe('Audit Logging');
    expect(audit?.implies).toEqual(['requires-logging']);
    expect(logging?.name).toBe('Structured Logging');
  });

  it('top-level nodes have parent = null', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);

    expect(graph.nodes.get('auth')?.parent).toBeNull();
    expect(graph.nodes.get('orders')?.parent).toBeNull();
    expect(graph.nodes.get('users')?.parent).toBeNull();
  });

  it('child nodes have correct parent reference', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);

    const authApi = graph.nodes.get('auth/auth-api');
    expect(authApi?.parent).toBe(graph.nodes.get('auth'));

    const orderService = graph.nodes.get('orders/order-service');
    expect(orderService?.parent).toBe(graph.nodes.get('orders'));

    const userRepo = graph.nodes.get('users/user-repo');
    expect(userRepo?.parent).toBe(graph.nodes.get('users'));
  });

  it('tree output shows model hierarchy', async () => {
    const distBin = path.join(__dirname, '../../../dist/bin.js');
    const result = spawnSync('node', [distBin, 'tree'], {
      cwd: FIXTURE_PROJECT,
      encoding: 'utf-8',
    });

    if (result.error?.message?.includes('ENOENT')) {
      return;
    }

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('auth');
    expect(result.stdout).toContain('orders');
    expect(result.stdout).toContain('order-service');
  });

  it('skips reserved directories (aspects, schemas)', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    expect(graph.nodes.has('aspects')).toBe(false);
    expect(graph.nodes.has('schemas')).toBe(false);
  });

  it('flows directory is not scanned for model nodes', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    expect(graph.nodes.has('flows')).toBe(false);
    expect(graph.nodes.has('_flows')).toBe(false);
    expect(graph.flows.length).toBeGreaterThan(0);
  });

  it('throws when config is invalid and tolerateInvalidConfig is false', async () => {
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-graph-invalid-config-throw');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    await mkdir(path.join(yggRoot, 'model'), { recursive: true });
    await writeFile(path.join(yggRoot, 'config.yaml'), 'invalid: yaml: [[[', 'utf-8');

    try {
      await expect(loadGraph(tmpDir, { tolerateInvalidConfig: false })).rejects.toThrow();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('loads empty aspects when aspects dir does not exist', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    expect(Array.isArray(graph.aspects)).toBe(true);
  });

  it('loads empty schemas when schemas dir does not exist', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    expect(Array.isArray(graph.schemas)).toBe(true);
  });

  it('skips subdirectories without node.yaml (hasNodeYaml false)', async () => {
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-graph-skip-no-node');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model');
    await mkdir(path.join(modelDir, 'svc', 'with-node'), { recursive: true });
    await mkdir(path.join(modelDir, 'svc', 'empty-dir'), { recursive: true });
    await writeFile(
      path.join(yggRoot, 'config.yaml'),
      'name: T\nnode_types: [service]\nartifacts:\n  responsibility:\n    required: always\n    description: x',
    );
    await writeFile(path.join(modelDir, 'svc', 'node.yaml'), 'name: Svc\ntype: module\n');
    await writeFile(
      path.join(modelDir, 'svc', 'with-node', 'node.yaml'),
      'name: W\ntype: service\n',
    );

    try {
      const graph = await loadGraph(tmpDir);
      expect(graph.nodes.has('svc')).toBe(true);
      expect(graph.nodes.has('svc/with-node')).toBe(true);
      expect(graph.nodes.has('svc/empty-dir')).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('loads empty when aspects is a file (readdir throws)', async () => {
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-graph-aspects-file');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(modelDir, { recursive: true });
    await writeFile(path.join(yggRoot, 'aspects'), 'not-a-dir', 'utf-8');
    await writeFile(
      path.join(yggRoot, 'config.yaml'),
      'name: T\nnode_types: [service]\nartifacts:\n  responsibility:\n    required: always\n    description: x',
    );
    await writeFile(path.join(modelDir, 'node.yaml'), 'name: S\ntype: service\n');

    try {
      const graph = await loadGraph(tmpDir);
      expect(graph.aspects).toEqual([]);
      expect(graph.nodes.size).toBeGreaterThan(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('loads empty arrays when aspects/flows/schemas dirs do not exist', async () => {
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-graph-minimal-dirs');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(modelDir, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'config.yaml'),
      'name: T\nnode_types: [service]\nartifacts:\n  responsibility:\n    required: always\n    description: x',
    );
    await writeFile(path.join(modelDir, 'node.yaml'), 'name: S\ntype: service\n');
    // No aspects/, flows/, schemas/ dirs

    try {
      const graph = await loadGraph(tmpDir);
      expect(graph.aspects).toEqual([]);
      expect(graph.flows).toEqual([]);
      expect(graph.schemas).toEqual([]);
      expect(graph.nodes.size).toBeGreaterThan(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('tolerateInvalidConfig returns graph with configError when config is invalid', async () => {
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-graph-invalid-config');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const nodeDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(yggRoot, 'config.yaml'), 'invalid: yaml: [[[', 'utf-8');
    await writeFile(
      path.join(yggRoot, 'model', 'node.yaml'),
      'name: Root\ntype: module\n',
      'utf-8',
    );
    await writeFile(path.join(nodeDir, 'node.yaml'), 'name: Svc\ntype: service\n', 'utf-8');

    try {
      const graph = await loadGraph(tmpDir, { tolerateInvalidConfig: true });
      expect(graph.configError).toBeDefined();
      expect(graph.configError).toContain('yaml');
      expect(graph.nodes.size).toBeGreaterThan(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
