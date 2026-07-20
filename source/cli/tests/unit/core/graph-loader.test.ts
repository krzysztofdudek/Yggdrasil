import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph, UnsupportedSchemaVersionError, OutdatedSchemaVersionError, MalformedSchemaVersionError } from '../../../src/core/graph-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

describe('loadGraph version gate', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'gl-'));
    mkdirSync(join(tmpRoot, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(join(tmpRoot, '.yggdrasil', 'yg-architecture.yaml'), 'node_types: {}\n');
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('refuses to load when version is newer than the supported schema', async () => {
    writeFileSync(join(tmpRoot, '.yggdrasil', 'yg-config.yaml'), 'version: "6.0.0"\n');
    await expect(loadGraph(tmpRoot)).rejects.toThrow(/version "6\.0\.0"/);
    await expect(loadGraph(tmpRoot)).rejects.toThrow(/newer than this CLI supports/i);
    // Throws an identifiable error type so callers can render a clean user
    // error (upgrade your CLI) instead of the generic "file an issue" wrapper.
    await expect(loadGraph(tmpRoot)).rejects.toBeInstanceOf(UnsupportedSchemaVersionError);
    await loadGraph(tmpRoot).catch((e: unknown) => {
      expect(e).toBeInstanceOf(UnsupportedSchemaVersionError);
      const err = e as UnsupportedSchemaVersionError;
      expect(err.detectedVersion).toBe('6.0.0');
      expect(err.maxSupportedVersion).toBe('5.1.0');
    });
  });

  it('loads when version equals the supported schema', async () => {
    writeFileSync(join(tmpRoot, '.yggdrasil', 'yg-config.yaml'), 'version: "5.1.0"\n');
    await expect(loadGraph(tmpRoot)).resolves.toBeDefined();
  });

  it('fails closed when version is present but not valid semver', async () => {
    // "5.1" is not valid semver — semver.valid() returns null, which would
    // short-circuit BOTH the gt/lt gates and let the graph load ungated (a
    // fail-open of the version gate). It must instead refuse to load.
    writeFileSync(join(tmpRoot, '.yggdrasil', 'yg-config.yaml'), 'version: "5.1"\n');
    await expect(loadGraph(tmpRoot)).rejects.toThrow(/not valid semver/i);
    await expect(loadGraph(tmpRoot)).rejects.toThrow(/version "5\.1"/);
    await expect(loadGraph(tmpRoot)).rejects.toBeInstanceOf(MalformedSchemaVersionError);
    await loadGraph(tmpRoot).catch((e: unknown) => {
      expect(e).toBeInstanceOf(MalformedSchemaVersionError);
      expect((e as MalformedSchemaVersionError).detectedVersion).toBe('5.1');
    });
  });

  it('does not trip the malformed guard on legitimate pre-release semver', async () => {
    // A pre-release like "5.1.0-beta.1" IS valid semver (valid() accepts it), so
    // it must reach the real gt/lt gates — not the malformed-version guard. Being
    // a pre-release it sorts below 5.1.0, so it lands on the OUTDATED gate.
    writeFileSync(join(tmpRoot, '.yggdrasil', 'yg-config.yaml'), 'version: "5.1.0-beta.1"\n');
    await expect(loadGraph(tmpRoot)).rejects.toBeInstanceOf(OutdatedSchemaVersionError);
    await expect(loadGraph(tmpRoot)).rejects.not.toBeInstanceOf(MalformedSchemaVersionError);
  });

  it('refuses to load when version is older than the supported schema (CLI)', async () => {
    writeFileSync(join(tmpRoot, '.yggdrasil', 'yg-config.yaml'), 'version: "4.3.0"\n');
    await expect(loadGraph(tmpRoot)).rejects.toThrow(/older than this CLI/i);
    await expect(loadGraph(tmpRoot)).rejects.toThrow(/yg init --upgrade/i);
    await expect(loadGraph(tmpRoot)).rejects.toBeInstanceOf(OutdatedSchemaVersionError);
    await loadGraph(tmpRoot).catch((e: unknown) => {
      expect(e).toBeInstanceOf(OutdatedSchemaVersionError);
      const err = e as OutdatedSchemaVersionError;
      expect(err.detectedVersion).toBe('4.3.0');
      expect(err.minSupportedVersion).toBe('5.1.0');
    });
  });
});

describe('graph-loader', () => {
  it('throws when model/ directory does not exist', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-no-model');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'yg-config.yaml'),
      'version: "5.1.0"',
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

    expect(graph.nodes.size).toBe(9);

    expect(graph.nodes.has('auth')).toBe(true);
    expect(graph.nodes.has('auth/auth-api')).toBe(true);
    expect(graph.nodes.has('orders')).toBe(true);
    expect(graph.nodes.has('orders/order-service')).toBe(true);
    expect(graph.nodes.has('users')).toBe(true);
    expect(graph.nodes.has('users/user-repo')).toBe(true);
    expect(graph.nodes.has('users/missing-service')).toBe(true);
    expect(graph.nodes.has('checkout')).toBe(true);
    expect(graph.nodes.has('checkout/controller')).toBe(true);
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
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'invalid: yaml: [[[', 'utf-8');

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

  it('skips subdirectories without yg-node.yaml (hasNodeYaml false)', async () => {
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-graph-skip-no-node');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model');
    await mkdir(path.join(modelDir, 'svc', 'with-node'), { recursive: true });
    await mkdir(path.join(modelDir, 'svc', 'empty-dir'), { recursive: true });
    await writeFile(
      path.join(yggRoot, 'yg-config.yaml'),
      'version: "5.1.0"',
    );
    await writeFile(path.join(modelDir, 'svc', 'yg-node.yaml'), 'name: Svc\ntype: module\n');
    await writeFile(
      path.join(modelDir, 'svc', 'with-node', 'yg-node.yaml'),
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
      path.join(yggRoot, 'yg-config.yaml'),
      'version: "5.1.0"',
    );
    await writeFile(path.join(modelDir, 'yg-node.yaml'), 'name: S\ntype: service\n');

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
      path.join(yggRoot, 'yg-config.yaml'),
      'version: "5.1.0"',
    );
    await writeFile(path.join(modelDir, 'yg-node.yaml'), 'name: S\ntype: service\n');
    // No aspects/, flows/, schemas/ dirs

    try {
      const graph = await loadGraph(tmpDir);
      expect(graph.aspects).toEqual([]);
      expect(graph.flows).toEqual([]);
      expect(graph.nodes.size).toBeGreaterThan(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('hard-skips a "drills" directory inside an aspect dir (no phantom aspect registers)', async () => {
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-graph-drills-skip');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model', 'svc');
    const aspectDir = path.join(yggRoot, 'aspects', 'real-aspect');
    const drillDir = path.join(aspectDir, 'drills', 'violates-x');
    await mkdir(modelDir, { recursive: true });
    await mkdir(drillDir, { recursive: true });
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.1.0"');
    await writeFile(path.join(modelDir, 'yg-node.yaml'), 'name: S\ntype: service\n');
    // A real, fully-valid deterministic aspect — this one MUST register.
    await writeFile(
      path.join(aspectDir, 'yg-aspect.yaml'),
      'name: Real\ndescription: real aspect\nreviewer:\n  type: deterministic\n',
    );
    await writeFile(path.join(aspectDir, 'check.mjs'), 'export function check() { return []; }\n');
    // A stray aspect BENEATH drills/ — identically valid in shape, so only the
    // drills-dir skip (never a parse failure) can keep it out of the registry.
    // Old released CLIs without the guard would register this as a phantom aspect.
    await writeFile(
      path.join(drillDir, 'yg-aspect.yaml'),
      'name: Phantom\ndescription: stray drill aspect\nreviewer:\n  type: deterministic\n',
    );
    await writeFile(path.join(drillDir, 'check.mjs'), 'export function check() { return []; }\n');

    try {
      const graph = await loadGraph(tmpDir);
      // The real sibling aspect still loads — scanning is unaffected outside drills/.
      expect(graph.aspects.some((a) => a.id === 'real-aspect')).toBe(true);
      // Nothing beneath drills/ registers, by exact id or by any id containing "drills".
      expect(graph.aspects.some((a) => a.id === 'real-aspect/drills/violates-x')).toBe(false);
      expect(graph.aspects.some((a) => a.id.includes('drills'))).toBe(false);
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
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'invalid: yaml: [[[', 'utf-8');
    await writeFile(
      path.join(yggRoot, 'model', 'yg-node.yaml'),
      'name: Root\ntype: module\n',
      'utf-8',
    );
    await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: Svc\ntype: service\n', 'utf-8');

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
