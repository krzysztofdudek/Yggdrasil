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

  it('warns on unknown node types when config has object format', async () => {
    // This exercises line 77 when node_types is an object (not array)
    const yamlContent = `name: T
node_types:
  module:
    description: "Module"
  custom_thing:
    description: "TODO: add description"
artifacts:
  responsibility.md:
    required: always
    description: x
`;
    await writeFile(path.join(yggRoot, 'config.yaml'), yamlContent);
    const result = await migrateTo2(yggRoot);
    expect(result.warnings.some(w => w.includes('custom_thing'))).toBe(true);
    const content = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;
    const nt = config.node_types as Record<string, { description: string }>;
    expect(nt.custom_thing).toBeDefined();
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

  it('preserves quality field from config', async () => {
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\nquality:\n  min_artifact_length: 100\nstack:\n  runtime: Node.js\n');
    await migrateTo2(yggRoot);
    const content = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;
    expect(config.quality).toBeDefined();
    const quality = config.quality as Record<string, unknown>;
    expect(quality.min_artifact_length).toBe(100);
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

  it('handles minimal project with no model/aspects/flows/schemas dirs', async () => {
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    const result = await migrateTo2(yggRoot);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(await exists(path.join(yggRoot, 'yg-config.yaml'))).toBe(true);
    // No model/aspects/flows/schemas dirs should not cause errors
    expect(await exists(path.join(yggRoot, 'model'))).toBe(false);
  });

  it('warns on invalid yg-node.yaml content', async () => {
    const nodeDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'just a string\n');
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "2.0.0"\nname: T\nnode_types:\n  module:\n    description: x\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    const result = await migrateTo2(yggRoot);
    expect(result.warnings.some(w => w.includes('not a valid YAML object'))).toBe(true);
  });

  it('preserves required_aspects from node_types in object format', async () => {
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types:\n  service:\n    description: A service\n    required_aspects:\n      - requires-auth\n      - requires-logging\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    await migrateTo2(yggRoot);
    const content = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;
    const nt = config.node_types as Record<string, { description: string; required_aspects?: string[] }>;
    expect(nt.service.required_aspects).toEqual(['requires-auth', 'requires-logging']);
  });

  it('handles node_types with mixed known and custom types', async () => {
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module, service, custom-type]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    const result = await migrateTo2(yggRoot);
    expect(result.warnings.some(w => w.includes('custom-type'))).toBe(true);
    const content = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;
    const nt = config.node_types as Record<string, { description: string }>;
    expect(nt.module).toBeDefined();
    expect(nt.service).toBeDefined();
    expect(nt['custom-type']).toBeDefined();
  });

  it('reads yg-config.yaml when config.yaml does not exist (idempotent case)', async () => {
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "2.0.0"\nname: T\nnode_types:\n  module:\n    description: x\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    const result = await migrateTo2(yggRoot);
    // Should succeed without error (it reads the existing yg-config.yaml)
    expect(result.actions.length).toBeGreaterThanOrEqual(1);
    expect(result.actions.some(a => a.includes('infrastructure'))).toBe(true);
  });

  it('migrates stack/standards only when present', async () => {
    await mkdir(path.join(yggRoot, 'model'), { recursive: true });
    await writeFile(path.join(yggRoot, 'config.yaml'), 'name: T\nnode_types: [module]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\n');
    const result = await migrateTo2(yggRoot);
    // internals.md should NOT be created when stack/standards are absent
    expect(await exists(path.join(yggRoot, 'model', 'internals.md'))).toBe(false);
  });
});
