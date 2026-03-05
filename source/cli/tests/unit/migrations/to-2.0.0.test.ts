import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { migrateTo2 } from '../../../src/migrations/to-2.0.0.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

describe('migration to 2.0.0', () => {
  let yggRoot: string;

  beforeEach(async () => {
    yggRoot = path.join(__dirname, '../../fixtures/tmp-migrate-2');
    await mkdir(yggRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(yggRoot, { recursive: true, force: true });
  });

  it('renames config.yaml to yg-config.yaml', async () => {
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    expect(await exists(path.join(yggRoot, 'yg-config.yaml'))).toBe(true);
    expect(await exists(path.join(yggRoot, 'config.yaml'))).toBe(false);
  });

  it('converts node_types array to object with descriptions', async () => {
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module, service, library]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    const content = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;
    const nt = config.node_types as Record<string, { description: string }>;
    expect(nt.module.description).toBe('Business logic unit with clear domain responsibility');
    expect(nt.service.description).toBe('Component providing functionality to other nodes');
    expect(nt.library.description).toBe('Shared utility code with no domain knowledge');
  });

  it('adds infrastructure node type if missing', async () => {
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    const content = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;
    const nt = config.node_types as Record<string, { description: string }>;
    expect(nt.infrastructure.description).toBe('Guards, middleware, interceptors — invisible in call graphs but affect blast radius');
  });

  it('warns on unknown custom node types', async () => {
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module, custom_thing]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    const result = await migrateTo2(yggRoot);
    expect(result.warnings.some(w => w.includes('custom_thing'))).toBe(true);
    const content = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;
    const nt = config.node_types as Record<string, { description: string }>;
    expect(nt.custom_thing.description).toBe('TODO: add description');
  });

  it('replaces artifacts with 2.0.0 standard', async () => {
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: old\n  constraints.md:\n    required: never\n    description: old\n');
    await migrateTo2(yggRoot);
    const content = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;
    const arts = config.artifacts as Record<string, unknown>;
    expect(arts['responsibility.md']).toBeDefined();
    expect(arts['interface.md']).toBeDefined();
    expect(arts['internals.md']).toBeDefined();
    expect(arts['constraints.md']).toBeUndefined();
  });

  it('removes stack and standards from config', async () => {
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\nstack:\n  runtime: Node.js\nstandards: Use ESM\n');
    await migrateTo2(yggRoot);
    const content = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;
    expect(config.stack).toBeUndefined();
    expect(config.standards).toBeUndefined();
  });

  it('migrates stack/standards to root node internals.md', async () => {
    await mkdir(path.join(yggRoot, 'model'), { recursive: true });
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: MyProject\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\nstack:\n  runtime: Node.js\n  framework: NestJS\nstandards: Use ESM imports\n');
    await migrateTo2(yggRoot);
    const internals = await readFile(path.join(yggRoot, 'model', 'internals.md'), 'utf-8');
    expect(internals).toContain('Node.js');
    expect(internals).toContain('NestJS');
    expect(internals).toContain('ESM');
  });

  it('creates root node if needed for stack/standards migration', async () => {
    await mkdir(path.join(yggRoot, 'model'), { recursive: true });
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: MyProject\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\nstack:\n  runtime: Node.js\n');
    await migrateTo2(yggRoot);
    expect(await exists(path.join(yggRoot, 'model', 'yg-node.yaml'))).toBe(true);
    expect(await exists(path.join(yggRoot, 'model', 'responsibility.md'))).toBe(true);
    const resp = await readFile(path.join(yggRoot, 'model', 'responsibility.md'), 'utf-8');
    expect(resp).toContain('TBD');
  });

  it('writes version 2.0.0 to config', async () => {
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    const content = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;
    expect(config.version).toBe('2.0.0');
  });

  it('renames node.yaml to yg-node.yaml recursively', async () => {
    const nodeDir = path.join(yggRoot, 'model', 'orders', 'order-service');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(nodeDir, 'node.yaml'), 'name: OrderService\ntype: service\naspects: [requires-audit]\n');
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    expect(await exists(path.join(nodeDir, 'yg-node.yaml'))).toBe(true);
    expect(await exists(path.join(nodeDir, 'node.yaml'))).toBe(false);
  });

  it('converts aspects string array to object array in node files', async () => {
    const nodeDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(nodeDir, 'node.yaml'), 'name: Svc\ntype: service\naspects: [audit, logging]\n');
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    const content = await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8');
    const node = parseYaml(content) as Record<string, unknown>;
    expect(node.aspects).toEqual([{ aspect: 'audit' }, { aspect: 'logging' }]);
  });

  it('merges aspect_exceptions into aspects entries', async () => {
    const nodeDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(nodeDir, 'node.yaml'), 'name: Svc\ntype: service\naspects: [audit]\naspect_exceptions:\n  audit:\n    - "Does not log PII"\n');
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    const content = await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8');
    const node = parseYaml(content) as Record<string, unknown>;
    expect(node.aspects).toEqual([{ aspect: 'audit', exceptions: ['Does not log PII'] }]);
    expect(node.aspect_exceptions).toBeUndefined();
  });

  it('merges anchors into aspects entries', async () => {
    const nodeDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(nodeDir, 'node.yaml'), 'name: Svc\ntype: service\naspects: [audit]\nanchors:\n  audit:\n    - "src/audit/**"\n');
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    const content = await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8');
    const node = parseYaml(content) as Record<string, unknown>;
    expect(node.aspects).toEqual([{ aspect: 'audit', anchors: ['src/audit/**'] }]);
    expect(node.anchors).toBeUndefined();
  });

  it('removes tags field from node files', async () => {
    const nodeDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(nodeDir, 'node.yaml'), 'name: Svc\ntype: service\ntags: [important]\n');
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    const content = await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8');
    const node = parseYaml(content) as Record<string, unknown>;
    expect(node.tags).toBeUndefined();
  });

  it('renames aspect.yaml to yg-aspect.yaml', async () => {
    const aspectDir = path.join(yggRoot, 'aspects', 'requires-audit');
    await mkdir(aspectDir, { recursive: true });
    await writeFile(path.join(aspectDir, 'aspect.yaml'), 'name: Requires Audit\n');
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    expect(await exists(path.join(aspectDir, 'yg-aspect.yaml'))).toBe(true);
    expect(await exists(path.join(aspectDir, 'aspect.yaml'))).toBe(false);
  });

  it('renames flow.yaml to yg-flow.yaml', async () => {
    const flowDir = path.join(yggRoot, 'flows', 'checkout');
    await mkdir(flowDir, { recursive: true });
    await writeFile(path.join(flowDir, 'flow.yaml'), 'name: Checkout\nnodes:\n  - orders/order-service\n');
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    expect(await exists(path.join(flowDir, 'yg-flow.yaml'))).toBe(true);
    expect(await exists(path.join(flowDir, 'flow.yaml'))).toBe(false);
  });

  it('renames schema files to yg-* prefix', async () => {
    const schemasDir = path.join(yggRoot, 'schemas');
    await mkdir(schemasDir, { recursive: true });
    await writeFile(path.join(schemasDir, 'node.yaml'), 'schema content');
    await writeFile(path.join(schemasDir, 'config.yaml'), 'schema content');
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    expect(await exists(path.join(schemasDir, 'yg-node.yaml'))).toBe(true);
    expect(await exists(path.join(schemasDir, 'node.yaml'))).toBe(false);
  });

  it('deletes .drift-state', async () => {
    await writeFile(path.join(yggRoot, '.drift-state'), '{}');
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    expect(await exists(path.join(yggRoot, '.drift-state'))).toBe(false);
  });

  it('handles node_types already in object format', async () => {
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types:\n  module:\n    description: old desc\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    const content = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;
    const nt = config.node_types as Record<string, { description: string }>;
    // Known type gets standard description regardless
    expect(nt.module.description).toBe('Business logic unit with clear domain responsibility');
  });

  it('returns summary of actions', async () => {
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    const result = await migrateTo2(yggRoot);
    expect(result.actions.length).toBeGreaterThan(0);
  });

  // IDEMPOTENCY TESTS
  it('is idempotent: running twice produces same result', async () => {
    const nodeDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(nodeDir, 'node.yaml'), 'name: Svc\ntype: service\naspects: [audit]\n');
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    // Run again — must not throw, must not corrupt data
    await migrateTo2(yggRoot);
    const content = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;
    expect(config.version).toBe('2.0.0');
    const nodeContent = await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8');
    const node = parseYaml(nodeContent) as Record<string, unknown>;
    expect(node.aspects).toEqual([{ aspect: 'audit' }]); // not doubled
  });

  it('is idempotent: stack/standards not duplicated on second run', async () => {
    await mkdir(path.join(yggRoot, 'model'), { recursive: true });
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: MyProject\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\nstack:\n  runtime: Node.js\n');
    await migrateTo2(yggRoot);
    await migrateTo2(yggRoot);
    const internals = await readFile(path.join(yggRoot, 'model', 'internals.md'), 'utf-8');
    // "Node.js" should appear exactly once
    const count = (internals.match(/Node\.js/g) ?? []).length;
    expect(count).toBe(1);
    // Migration marker must be present exactly once
    const markerCount = (internals.match(/<!-- migrated-stack-standards-v2 -->/g) ?? []).length;
    expect(markerCount).toBe(1);
  });
});
