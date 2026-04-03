import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { migrateToV4 } from '../../../src/migrations/to-4.0.0.js';

const TMP_DIR = path.join(import.meta.dirname, '__tmp_migrate4');

describe('to-4.0.0 migration', () => {
  beforeEach(async () => {
    await mkdir(TMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  describe('config migration', () => {
    it('creates yg-architecture.yaml from config node_types', async () => {
      await writeFile(
        path.join(TMP_DIR, 'yg-config.yaml'),
        'version: "3.0.0"\nname: "Test"\nnode_types:\n  module:\n    description: "Business logic"\n  service:\n    description: "Service"\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const architectureFile = path.join(TMP_DIR, 'yg-architecture.yaml');
      expect(await readFile(architectureFile, 'utf-8')).toContain('node_types:');
      expect(result.actions.some((a) => a.includes('yg-architecture.yaml'))).toBe(true);
    });

    it('removes node_types from config after extraction', async () => {
      await writeFile(
        path.join(TMP_DIR, 'yg-config.yaml'),
        'version: "3.0.0"\nname: "Test"\nnode_types:\n  module:\n    description: "Business logic"\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const config = parseYaml(await readFile(path.join(TMP_DIR, 'yg-config.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(config.node_types).toBeUndefined();
      expect(result.actions.some((a) => a.includes('Removed node_types'))).toBe(true);
    });

    it('skips config if no yg-config.yaml exists', async () => {
      const result = await migrateToV4(TMP_DIR);
      expect(result.actions).toEqual([]);
    });
  });

  describe('mapping structure transformation', () => {
    it('transforms mapping from object to array format', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  paths:\n    - src/service.ts\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(Array.isArray(doc.mapping)).toBe(true);
      expect((doc.mapping as unknown[])[0]).toHaveProperty('paths');
      expect(result.actions.some((a) => a.includes('Transformed'))).toBe(true);
    });

    it('preserves mapping if already in array format', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  - paths:\n      - src/service.ts\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(Array.isArray(doc.mapping)).toBe(true);
    });
  });

  describe('aspect structure transformation', () => {
    it('converts aspects from object format to flat string array', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\naspects:\n  - aspect: requires-audit\n  - aspect: requires-logging\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(doc.aspects).toEqual(['requires-audit', 'requires-logging']);
      expect(result.actions.some((a) => a.includes('Transformed'))).toBe(true);
    });

    it('converts mixed aspect formats (string and object) to flat string array', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\naspects:\n  - requires-audit\n  - aspect: requires-logging\nmapping:\n  - paths:\n      - src/service.ts\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(Array.isArray(doc.aspects)).toBe(true);
      expect(doc.aspects).toEqual(['requires-audit', 'requires-logging']);
    });
  });

  describe('anchor format migration', () => {
    it('converts bare-string anchors to typed realization objects', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  - paths:\n      - src/service.ts\n    aspects:\n      - aspect: requires-audit\n        anchors:\n          - audit-entry\n          - log-call\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      const mapping = doc.mapping as unknown[];
      const mappingAspects = (mapping[0] as Record<string, unknown>).aspects as Array<Record<string, unknown>>;
      const anchors = mappingAspects[0].anchors as Record<string, unknown>;
      expect(anchors).toEqual({
        'audit-entry': { regex: 'audit-entry', rationale: 'migrated from v3' },
        'log-call': { regex: 'log-call', rationale: 'migrated from v3' },
      });
      expect(result.actions.some((a) => a.includes('Transformed'))).toBe(true);
    });

    it('preserves already-typed anchors', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  - paths:\n      - src/service.ts\n    aspects:\n      - aspect: requires-audit\n        anchors:\n          audit-entry:\n            regex: "createAuditLog"\n            rationale: "Creates audit log"\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      const mapping = doc.mapping as unknown[];
      const mappingAspects = (mapping[0] as Record<string, unknown>).aspects as Array<Record<string, unknown>>;
      const anchors = mappingAspects[0].anchors as Record<string, unknown>;
      expect(anchors['audit-entry']).toEqual({
        regex: 'createAuditLog',
        rationale: 'Creates audit log',
      });
    });
  });

  describe('deprecated field removal', () => {
    it('removes exceptions field from node', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nexceptions:\n  - requires-audit\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(doc.exceptions).toBeUndefined();
    });

    it('removes integration_anchors field from node', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nintegration_anchors:\n  - correlation-id\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(doc.integration_anchors).toBeUndefined();
    });

    it('removes tags field from node', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\ntags:\n  - critical\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(doc.tags).toBeUndefined();
    });
  });

  describe('relations transformation', () => {
    it('removes anchors from relation objects', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nrelations:\n  - target: other/svc\n    type: calls\n    anchors:\n      correlation-id:\n        regex: "correlationId"\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      const relations = doc.relations as Array<Record<string, unknown>>;
      expect(relations[0].anchors).toBeUndefined();
    });
  });

  describe('edge cases and idempotency', () => {
    it('returns early when model directory does not exist', async () => {
      const result = await migrateToV4(TMP_DIR);
      expect(result.actions).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('no-ops when node has no aspects', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\n',
      );
      const result = await migrateToV4(TMP_DIR);
      expect(result.actions).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('warns on invalid YAML object in node file', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'just a string\n');
      const result = await migrateToV4(TMP_DIR);
      expect(result.warnings.some((w) => w.includes('not a valid YAML object'))).toBe(true);
    });

    it('processes nested subdirectories recursively', async () => {
      const parentDir = path.join(TMP_DIR, 'model', 'orders');
      const childDir = path.join(parentDir, 'order-service');
      await mkdir(childDir, { recursive: true });

      await writeFile(
        path.join(parentDir, 'yg-node.yaml'),
        'name: Orders\ntype: module\naspects:\n  - requires-audit\nmapping:\n  - paths:\n      - src/orders\n',
      );
      await writeFile(
        path.join(childDir, 'yg-node.yaml'),
        'name: OrderService\ntype: service\naspects:\n  - requires-audit\nmapping:\n  - paths:\n      - src/orders/service\n',
      );

      const result = await migrateToV4(TMP_DIR);
      expect(result.actions.length).toBeGreaterThanOrEqual(2);
    });

    it('handles string aspect entries (already v4 format)', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\naspects:\n  - requires-audit\n  - requires-logging\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(doc.aspects).toEqual(['requires-audit', 'requires-logging']);
    });

    it('handles multiple aspects and mapping groups', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\naspects:\n  - requires-audit\n  - requires-logging\nmapping:\n  - paths:\n      - src/routes\n  - paths:\n      - src/services\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(Array.isArray(doc.aspects)).toBe(true);
      expect(Array.isArray(doc.mapping)).toBe(true);
      expect((doc.mapping as unknown[]).length).toBe(2);
    });
  });
});
