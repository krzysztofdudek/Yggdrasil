import { describe, it, expect } from 'vitest';
import { migrateTo4 } from '../../../src/migrations/to-4.0.0.js';
import { mkdtemp, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';

async function makeDir(...parts: string[]): Promise<void> {
  await mkdir(path.join(...parts), { recursive: true });
}

async function writeYaml(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, 'utf-8');
}

async function readYaml(filePath: string): Promise<Record<string, unknown>> {
  const content = await readFile(filePath, 'utf-8');
  return parseYaml(content) as Record<string, unknown>;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createV3Root(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yg-mig4-'));
  await makeDir(dir, 'model');
  await makeDir(dir, 'flows');
  await makeDir(dir, 'aspects');
  await makeDir(dir, '.drift-state');
  return dir;
}

describe('migrateTo4', () => {
  it('extracts node_types to yg-architecture.yaml', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), `
version: "3.0.0"
name: "test-project"
node_types:
  module:
    description: "Business logic"
  service:
    description: "Providing functionality"
`);

    await migrateTo4(root);

    const arch = await readYaml(path.join(root, 'yg-architecture.yaml'));
    expect(arch.node_types).toBeDefined();
    const nodeTypes = arch.node_types as Record<string, unknown>;
    expect(nodeTypes.module).toBeDefined();
    expect(nodeTypes.service).toBeDefined();
  });

  it('cleans config: removes name, node_types, obsolete quality fields, adds parallel', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), `
version: "3.0.0"
name: "test-project"
node_types:
  module:
    description: "Business logic"
quality:
  min_artifact_length: 100
  context_budget: 5000
  max_direct_relations: 10
`);

    await migrateTo4(root);

    const config = await readYaml(path.join(root, 'yg-config.yaml'));
    expect(config.name).toBeUndefined();
    expect(config.node_types).toBeUndefined();
    expect(config.parallel).toBe(1);
    expect(config.version).toBe('4.0.0');

    const quality = config.quality as Record<string, unknown>;
    expect(quality).toBeDefined();
    expect(quality.min_artifact_length).toBeUndefined();
    expect(quality.context_budget).toBeUndefined();
    expect(quality.max_direct_relations).toBe(10);
  });

  it('flattens node aspects from object to string array', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), 'version: "3.0.0"\n');
    const nodeDir = path.join(root, 'model', 'my-service');
    await makeDir(nodeDir);
    await writeYaml(path.join(nodeDir, 'yg-node.yaml'), `
name: MyService
type: service
aspects:
  - aspect: posix-paths
    exceptions: []
    anchors: []
  - aspect: deterministic
    exceptions: []
    anchors: []
`);

    await migrateTo4(root);

    const node = await readYaml(path.join(nodeDir, 'yg-node.yaml'));
    expect(node.aspects).toEqual(['posix-paths', 'deterministic']);
  });

  it('flattens node mapping from {paths: [...]} to [...]', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), 'version: "3.0.0"\n');
    const nodeDir = path.join(root, 'model', 'my-service');
    await makeDir(nodeDir);
    await writeYaml(path.join(nodeDir, 'yg-node.yaml'), `
name: MyService
type: service
mapping:
  paths:
    - src/service.ts
    - src/utils.ts
`);

    await migrateTo4(root);

    const node = await readYaml(path.join(nodeDir, 'yg-node.yaml'));
    expect(node.mapping).toEqual(['src/service.ts', 'src/utils.ts']);
  });

  it('removes blackbox field from nodes', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), 'version: "3.0.0"\n');
    const nodeDir = path.join(root, 'model', 'legacy');
    await makeDir(nodeDir);
    await writeYaml(path.join(nodeDir, 'yg-node.yaml'), `
name: Legacy
type: module
blackbox: true
mapping:
  paths:
    - src/legacy/
`);

    await migrateTo4(root);

    const node = await readYaml(path.join(nodeDir, 'yg-node.yaml'));
    expect(node.blackbox).toBeUndefined();
  });

  it('deletes node artifacts (responsibility.md, interface.md, internals.md)', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), 'version: "3.0.0"\n');
    const nodeDir = path.join(root, 'model', 'my-service');
    await makeDir(nodeDir);
    await writeYaml(path.join(nodeDir, 'yg-node.yaml'), 'name: MyService\ntype: service\n');
    await writeFile(path.join(nodeDir, 'responsibility.md'), '# Responsibility\n', 'utf-8');
    await writeFile(path.join(nodeDir, 'interface.md'), '# Interface\n', 'utf-8');
    await writeFile(path.join(nodeDir, 'internals.md'), '# Internals\n', 'utf-8');

    await migrateTo4(root);

    expect(await fileExists(path.join(nodeDir, 'responsibility.md'))).toBe(false);
    expect(await fileExists(path.join(nodeDir, 'interface.md'))).toBe(false);
    expect(await fileExists(path.join(nodeDir, 'internals.md'))).toBe(false);
    expect(await fileExists(path.join(nodeDir, 'yg-node.yaml'))).toBe(true);
  });

  it('deletes flow description.md', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), 'version: "3.0.0"\n');
    const flowDir = path.join(root, 'flows', 'checkout');
    await makeDir(flowDir);
    await writeYaml(path.join(flowDir, 'yg-flow.yaml'), 'name: Checkout\n');
    await writeFile(path.join(flowDir, 'description.md'), '# Checkout flow\n', 'utf-8');

    await migrateTo4(root);

    expect(await fileExists(path.join(flowDir, 'description.md'))).toBe(false);
    expect(await fileExists(path.join(flowDir, 'yg-flow.yaml'))).toBe(true);
  });

  it('removes stability from aspects', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), 'version: "3.0.0"\n');
    const aspectDir = path.join(root, 'aspects', 'posix-paths');
    await makeDir(aspectDir);
    await writeYaml(path.join(aspectDir, 'yg-aspect.yaml'), `
name: POSIX Paths
description: "Forward-slash paths"
stability: protocol
`);

    await migrateTo4(root);

    const aspect = await readYaml(path.join(aspectDir, 'yg-aspect.yaml'));
    expect(aspect.stability).toBeUndefined();
    expect(aspect.name).toBe('POSIX Paths');
    expect(aspect.description).toBe('Forward-slash paths');
  });

  it('resets drift state by deleting .json files', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), 'version: "3.0.0"\n');
    const driftDir = path.join(root, '.drift-state');
    await writeFile(path.join(driftDir, 'node-a.json'), '{}', 'utf-8');
    await writeFile(path.join(driftDir, 'node-b.json'), '{}', 'utf-8');

    await migrateTo4(root);

    expect(await fileExists(path.join(driftDir, 'node-a.json'))).toBe(false);
    expect(await fileExists(path.join(driftDir, 'node-b.json'))).toBe(false);
  });

  it('warns about dropped aspect exceptions and anchors', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), 'version: "3.0.0"\n');
    const nodeDir = path.join(root, 'model', 'my-service');
    await makeDir(nodeDir);
    await writeYaml(path.join(nodeDir, 'yg-node.yaml'), `
name: MyService
type: service
aspects:
  - aspect: posix-paths
    exceptions:
      - legacy-file.ts
    anchors:
      - src/main.ts
`);

    const result = await migrateTo4(root);

    expect(result.warnings.some((w) => w.includes('exceptions') && w.includes('posix-paths'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('anchors') && w.includes('posix-paths'))).toBe(true);
  });

  it('strips consumes, failure, and event_name from relations', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), 'version: "3.0.0"\n');
    const nodeDir = path.join(root, 'model', 'entry');
    await makeDir(nodeDir);
    await writeYaml(path.join(nodeDir, 'yg-node.yaml'), `
name: Entry
type: service
relations:
  - target: cli/commands/init
    type: uses
    consumes: [registerInitCommand]
    failure: "retry 3x"
  - target: events/bus
    type: emits
    event_name: OrderPlaced
mapping:
  paths:
    - src/entry.ts
`);

    await migrateTo4(root);

    const node = await readYaml(path.join(nodeDir, 'yg-node.yaml'));
    const relations = node.relations as Array<Record<string, unknown>>;
    expect(relations[0].consumes).toBeUndefined();
    expect(relations[0].failure).toBeUndefined();
    expect(relations[0].target).toBe('cli/commands/init');
    expect(relations[0].type).toBe('uses');
    expect(relations[1].event_name).toBeUndefined();
  });

  it('preserves parallel if already set', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), `
version: "3.0.0"
name: "test"
parallel: 4
`);

    await migrateTo4(root);

    const config = await readYaml(path.join(root, 'yg-config.yaml'));
    expect(config.parallel).toBe(4);
  });

  it('handles nested drift state directories', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), 'version: "3.0.0"\n');
    const nestedDir = path.join(root, '.drift-state', 'cli', 'commands');
    await makeDir(nestedDir);
    await writeFile(path.join(nestedDir, 'init.json'), '{}', 'utf-8');

    await migrateTo4(root);

    expect(await fileExists(path.join(nestedDir, 'init.json'))).toBe(false);
  });

  it('handles node with already-flat string aspects (no rewrite needed)', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), 'version: "3.0.0"\n');
    const nodeDir = path.join(root, 'model', 'svc');
    await makeDir(nodeDir);
    await writeYaml(path.join(nodeDir, 'yg-node.yaml'), `
name: Svc
type: service
aspects:
  - deterministic
  - posix-paths
`);

    const result = await migrateTo4(root);

    const node = await readYaml(path.join(nodeDir, 'yg-node.yaml'));
    expect(node.aspects).toEqual(['deterministic', 'posix-paths']);
    // Should NOT rewrite since aspects are already flat strings
    expect(result.actions.some(a => a.includes('Rewrote node'))).toBe(false);
  });

  it('handles config without node_types', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), `
version: "3.0.0"
name: "test"
quality:
  max_direct_relations: 5
`);

    await migrateTo4(root);

    expect(await fileExists(path.join(root, 'yg-architecture.yaml'))).toBe(false);
    const config = await readYaml(path.join(root, 'yg-config.yaml'));
    expect(config.name).toBeUndefined();
  });

  it('handles flow without description.md', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), 'version: "3.0.0"\n');
    const flowDir = path.join(root, 'flows', 'checkout');
    await makeDir(flowDir);
    await writeYaml(path.join(flowDir, 'yg-flow.yaml'), 'name: Checkout\n');

    const result = await migrateTo4(root);

    expect(result.actions.filter(a => a.includes('flow'))).toHaveLength(0);
  });

  it('handles aspect without stability field', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), 'version: "3.0.0"\n');
    const aspectDir = path.join(root, 'aspects', 'auth');
    await makeDir(aspectDir);
    await writeYaml(path.join(aspectDir, 'yg-aspect.yaml'), 'name: Auth\ndescription: "Auth rules"\n');

    const result = await migrateTo4(root);

    expect(result.actions.filter(a => a.includes('stability'))).toHaveLength(0);
  });

  it('removes quality entirely when only obsolete fields remain', async () => {
    const root = await createV3Root();
    await writeYaml(path.join(root, 'yg-config.yaml'), `
version: "3.0.0"
name: "test"
quality:
  min_artifact_length: 100
  context_budget: 5000
`);

    await migrateTo4(root);

    const config = await readYaml(path.join(root, 'yg-config.yaml'));
    expect(config.quality).toBeUndefined();
  });
});
