import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNodeYaml } from '../../../src/io/node-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '../../fixtures/sample-project/.yggdrasil/model');

describe('node-parser', () => {
  it('parses valid node.yaml correctly (v2.2)', async () => {
    const meta = await parseNodeYaml(path.join(FIXTURE_DIR, 'orders/order-service/node.yaml'));

    expect(meta.name).toBe('OrderService');
    expect(meta.type).toBe('service');
    expect(meta.relations).toContainEqual({ target: 'auth/auth-api', type: 'uses' });
    expect(meta.relations).toContainEqual({ target: 'users/user-repo', type: 'uses' });
    expect(meta.blackbox).toBe(false);
    expect(meta.mapping).toEqual({ paths: ['src/orders/order.service.ts'] });
  });

  it('throws on empty YAML file', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-empty');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'node.yaml');
    await writeFile(badPath, '', 'utf-8');

    await expect(parseNodeYaml(badPath)).rejects.toThrow('empty or not a valid YAML mapping');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when name is missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      badPath,
      `
type: service
`,
      'utf-8',
    );

    await expect(parseNodeYaml(badPath)).rejects.toThrow("missing or empty 'name'");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when type is missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      badPath,
      `
name: TestNode
`,
      'utf-8',
    );

    await expect(parseNodeYaml(badPath)).rejects.toThrow("missing or empty 'type'");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('handles mapping paths', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: TestNode
type: service
mapping:
  paths:
    - src/modules/test/service.ts
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.mapping).toEqual({ paths: ['src/modules/test/service.ts'] });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping has type but no paths', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: TestNode
type: service
mapping:
  type: directory
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('mapping must have paths');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping paths is not array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: TestNode
type: service
mapping:
  paths: "not-array"
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('mapping must have paths');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping paths array has no valid string paths', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: TestNode
type: service
mapping:
  paths:
    - 1
    - 2
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('non-empty array');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('handles mapping with multiple paths', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: TestNode
type: component
mapping:
  paths:
    - app/page.tsx
    - app/loading.tsx
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.mapping).toEqual({
      paths: ['app/page.tsx', 'app/loading.tsx'],
    });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('defaults blackbox to false', async () => {
    const meta = await parseNodeYaml(path.join(FIXTURE_DIR, 'orders/order-service/node.yaml'));
    expect(meta.blackbox).toBe(false);
  });

  it('defaults missing optional fields correctly', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: MinimalNode
type: module
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.aspects).toBeUndefined();
    expect(meta.relations).toBeUndefined();
    expect(meta.mapping).toBeUndefined();
    expect(meta.blackbox).toBe(false);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses blackbox: true correctly', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-bb');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: ExternalService
type: service
blackbox: true
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.blackbox).toBe(true);
    expect(meta.name).toBe('ExternalService');
    expect(meta.type).toBe('service');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses node with aspects field', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-aspects');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: AspectedNode
type: service
aspects:
  - requires-auth
  - public-api
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.aspects).toEqual(['requires-auth', 'public-api']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('backward compat: parses tags field as aspects', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-tags');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: TaggedNode
type: service
tags:
  - requires-auth
  - public-api
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.aspects).toEqual(['requires-auth', 'public-api']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined mapping when mapping is empty object', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-no-path');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: NoPathNode
type: service
mapping: {}
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.mapping).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping.paths contains empty string', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-empty-path');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: EmptyPath
type: service
mapping:
  paths:
    - ""
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('must be non-empty');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping.paths contains absolute path', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-abs-path');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: AbsPath
type: service
mapping:
  paths:
    - /absolute/path.ts
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('relative to repository root');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping.paths is empty array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-empty-paths');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: EmptyPaths
type: service
mapping:
  paths: []
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('mapping must have paths');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when relations is not array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-relations-not-array');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: BadRels
type: service
relations: "not-array"
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow("'relations' must be an array");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when relation target is empty string', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-empty-target');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: BadRel
type: service
relations:
  - target: ""
    type: uses
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('target must be a non-empty string');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when relation is not object', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-rel-not-obj');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: BadRel
type: service
relations:
  - "not-an-object"
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('must be an object');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping has type directory but no paths', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-dir-no-path');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: NoPath
type: service
mapping:
  type: directory
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('mapping must have paths');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when relation type is invalid', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-invalid-rel-type');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: BadRel
type: service
relations:
  - target: other
    type: invalid_type
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('type is invalid');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses relation with event_name for emits/listens', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-event-name');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: EventNode
type: service
relations:
  - target: events/handler
    type: emits
    event_name: OrderCreated
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.relations).toHaveLength(1);
    expect(meta.relations![0]).toEqual({
      target: 'events/handler',
      type: 'emits',
      event_name: 'OrderCreated',
    });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses node with relations including consumes and failure', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-rels');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'node.yaml');
    await writeFile(
      nodePath,
      `
name: RelatedNode
type: service
relations:
  - target: auth/auth-api
    type: uses
    consumes: [login, logout]
  - target: users/user-repo
    type: calls
    failure: "retry 3x"
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.relations).toHaveLength(2);
    expect(meta.relations![0]).toEqual({
      target: 'auth/auth-api',
      type: 'uses',
      consumes: ['login', 'logout'],
    });
    expect(meta.relations![1]).toEqual({
      target: 'users/user-repo',
      type: 'calls',
      failure: 'retry 3x',
    });

    await rm(tmpDir, { recursive: true, force: true });
  });
});
