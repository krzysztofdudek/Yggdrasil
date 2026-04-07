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
      // Should create secrets files even with no config
      expect(result.actions.some((a) => a.includes('yg-secrets.example.yaml'))).toBe(true);
      expect(result.actions.some((a) => a.includes('.gitignore'))).toBe(true);
    });
  });

  describe('mapping structure transformation', () => {
    it('transforms mapping from object to flat string array format', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  paths:\n    - src/service.ts\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(Array.isArray(doc.mapping)).toBe(true);
      expect((doc.mapping as unknown[])[0]).toBe('src/service.ts');
      expect(result.actions.some((a) => a.includes('Transformed'))).toBe(true);
    });

    it('flattens mapping if in array format with paths objects', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  - paths:\n      - src/service.ts\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(Array.isArray(doc.mapping)).toBe(true);
      expect((doc.mapping as unknown[])[0]).toBe('src/service.ts');
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
    it('removes mapping aspects and anchors (flattened to string mapping)', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  - paths:\n      - src/service.ts\n    aspects:\n      - aspect: requires-audit\n        anchors:\n          - audit-entry\n          - log-call\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      const mapping = doc.mapping as unknown[];
      // After v4 migration, mapping is flat strings, no aspects
      expect(Array.isArray(mapping)).toBe(true);
      expect(mapping[0]).toBe('src/service.ts');
      expect(result.actions.some((a) => a.includes('Transformed'))).toBe(true);
    });

    it('flattens mapping aspects and removes anchors', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  - paths:\n      - src/service.ts\n    aspects:\n      - aspect: requires-audit\n        anchors:\n          audit-entry:\n            regex: "createAuditLog"\n            rationale: "Creates audit log"\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      const mapping = doc.mapping as unknown[];
      // Mapping is flat strings, aspects and anchors removed from mapping
      expect(Array.isArray(mapping)).toBe(true);
      expect(mapping[0]).toBe('src/service.ts');
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
      // Should create secrets files even with no model directory
      expect(result.actions.some((a) => a.includes('yg-secrets.example.yaml'))).toBe(true);
      expect(result.actions.some((a) => a.includes('.gitignore'))).toBe(true);
    });

    it('no-ops when node has no aspects', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\n',
      );
      const result = await migrateToV4(TMP_DIR);
      // Should create secrets files even if node has no aspects
      expect(result.actions.some((a) => a.includes('yg-secrets.example.yaml'))).toBe(true);
      expect(result.actions.some((a) => a.includes('.gitignore'))).toBe(true);
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

    it('skips config migration if config file cannot be read', async () => {
      // This path is tested by creating a directory instead of file
      await mkdir(path.join(TMP_DIR, 'yg-config.yaml'), { recursive: true });
      const result = await migrateToV4(TMP_DIR);
      expect(result.actions.every((a) => !a.includes('config'))).toBe(true);
    });

    it('warns on invalid YAML in config file', async () => {
      await writeFile(path.join(TMP_DIR, 'yg-config.yaml'), 'just a string\n');
      const result = await migrateToV4(TMP_DIR);
      expect(result.warnings.some((w) => w.includes('not a valid YAML object'))).toBe(true);
    });

    it('skips architecture file creation if it already exists', async () => {
      const configPath = path.join(TMP_DIR, 'yg-config.yaml');
      const archPath = path.join(TMP_DIR, 'yg-architecture.yaml');
      await writeFile(configPath, 'version: "3.0.0"\nnode_types:\n  module:\n    description: "Test"\n');
      await writeFile(archPath, 'version: "4.0.0"\nnode_types:\n  module:\n    description: "Existing"\n');
      const result = await migrateToV4(TMP_DIR);
      const arch = parseYaml(await readFile(archPath, 'utf-8')) as Record<string, unknown>;
      expect((arch.node_types as Record<string, unknown>).module).toHaveProperty('description', 'Existing');
      expect(result.actions.some((a) => a.includes('Created yg-architecture'))).toBe(false);
    });

    it('handles mapping without paths property', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  something: else\n',
      );
      const result = await migrateToV4(TMP_DIR);
      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(typeof doc.mapping).toBe('object');
      expect(!Array.isArray(doc.mapping)).toBe(true);
    });

    it('removes empty aspects array', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\naspects:\n  - aspect: null\n',
      );
      const result = await migrateToV4(TMP_DIR);
      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(doc.aspects).toBeUndefined();
    });

    it('flattens mapping with aspects and anchors', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  - paths:\n      - src/service.ts\n    aspects:\n      - aspect: requires-audit\n        anchors:\n          audit-entry:\n            regex: "log"\n            rationale: "test"\n',
      );
      const result = await migrateToV4(TMP_DIR);
      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      const mapping = doc.mapping as unknown[];
      // Mapping is flattened to strings, aspects removed
      expect(Array.isArray(mapping)).toBe(true);
      expect(mapping[0]).toBe('src/service.ts');
    });

    it('skips node file if cannot be read', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      // Create yg-node.yaml as a directory to cause read error
      await mkdir(path.join(nodeDir, 'yg-node.yaml'), { recursive: true });
      const result = await migrateToV4(TMP_DIR);
      // Should create secrets files even if node file read fails
      expect(result.actions.some((a) => a.includes('yg-secrets.example.yaml'))).toBe(true);
      expect(result.actions.some((a) => a.includes('.gitignore'))).toBe(true);
    });

    it('handles null aspect entry gracefully', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\naspects:\n  - null\n  - requires-audit\n',
      );
      const result = await migrateToV4(TMP_DIR);
      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect((doc.aspects as string[]).includes('requires-audit')).toBe(true);
    });

    it('flattens mapping with mixed anchor types', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  - paths:\n      - src/service.ts\n    aspects:\n      - aspect: requires-audit\n        anchors:\n          entry:\n            regex: "log"\n          call: "callFunction"\n          unknown: 123\n',
      );
      const result = await migrateToV4(TMP_DIR);
      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      const mapping = doc.mapping as unknown[];
      // Mapping flattened, anchors removed
      expect(Array.isArray(mapping)).toBe(true);
      expect(mapping[0]).toBe('src/service.ts');
    });

    it('handles mapping groups without aspects by flattening', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  - paths:\n      - src/service.ts\n',
      );
      const result = await migrateToV4(TMP_DIR);
      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(Array.isArray(doc.mapping)).toBe(true);
      expect((doc.mapping as unknown[])[0]).toBe('src/service.ts');
    });

    it('handles relation without anchors field', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nrelations:\n  - target: other/svc\n    type: calls\n',
      );
      const result = await migrateToV4(TMP_DIR);
      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      const relations = doc.relations as Array<Record<string, unknown>>;
      expect(relations[0]).toEqual({ target: 'other/svc', type: 'calls' });
    });

    it('handles empty aspect anchors object', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  - paths:\n      - src/service.ts\n    aspects:\n      - aspect: requires-audit\n        anchors: {}\n',
      );
      const result = await migrateToV4(TMP_DIR);
      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      const mapping = doc.mapping as unknown[];
      // After migration, mapping should be flat strings (aspects are dropped from mapping groups)
      expect(Array.isArray(mapping)).toBe(true);
      expect(mapping[0]).toBe('src/service.ts');
    });

    it('handles node with invalid YAML that cannot be read', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      // Create yg-node.yaml as a directory to cause read error
      await mkdir(path.join(nodeDir, 'yg-node.yaml'), { recursive: true });
      const result = await migrateToV4(TMP_DIR);
      // Should not throw, just skip and continue
      expect(result.warnings).toEqual([]);
    });

    it('skips config migration when config file cannot be read', async () => {
      // Create yg-config.yaml as a directory to cause read error
      await mkdir(path.join(TMP_DIR, 'yg-config.yaml'), { recursive: true });
      const result = await migrateToV4(TMP_DIR);
      // Should not throw, just skip config migration
      expect(result.actions.every((a) => !a.includes('config'))).toBe(true);
    });

    it('handles mapping with only aspect field (no paths)', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\nmapping:\n  aspects: [requires-audit]\n',
      );
      const result = await migrateToV4(TMP_DIR);
      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      // mapping should remain as object since it has no paths property
      expect(typeof doc.mapping).toBe('object');
      expect(!Array.isArray(doc.mapping)).toBe(true);
    });

    it('handles aspect with string value (edge case)', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: Svc\ntype: service\naspects:\n  - "audit"\nmapping:\n  - paths:\n      - src/service.ts\n',
      );
      const result = await migrateToV4(TMP_DIR);
      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect((doc.aspects as string[]).includes('audit')).toBe(true);
    });
  });

  describe('to-4.0.0 migration extensions', () => {
    it('removes integration_aspects from architecture', async () => {
      const archPath = path.join(TMP_DIR, 'yg-architecture.yaml');
      await writeFile(
        archPath,
        'node_types:\n  service:\n    description: "Request handler"\n    aspects: [requires-auth]\n    integration_aspects: [correlation-tracking]\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const arch = parseYaml(await readFile(archPath, 'utf-8')) as Record<string, unknown>;
      const nodeTypes = arch.node_types as Record<string, unknown>;
      const service = nodeTypes.service as Record<string, unknown>;
      expect(service.integration_aspects).toBeUndefined();
      expect(service.aspects).toBeDefined();
      expect(result.warnings.some((w) => w.includes('integration_aspects'))).toBe(true);
    });

    it('removes integration_aspects from nodes', async () => {
      const nodeDir = path.join(TMP_DIR, 'model', 'svc');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(
        path.join(nodeDir, 'yg-node.yaml'),
        'name: PaymentService\ntype: service\nintegration_aspects:\n  - correlation-tracking\nmapping:\n  - paths:\n      - src/service.ts\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const doc = parseYaml(await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(doc.integration_aspects).toBeUndefined();
      expect(result.warnings.some((w) => w.includes('integration_aspects'))).toBe(true);
    });

    it('creates yg-secrets.example.yaml with template', async () => {
      const result = await migrateToV4(TMP_DIR);

      const secretsExample = path.join(TMP_DIR, 'yg-secrets.example.yaml');
      const content = await readFile(secretsExample, 'utf-8');
      expect(content).toContain('reviewer:');
      expect(content).toContain('ollama:');
      expect(content).toContain('claude-code:');
      expect(result.actions.some((a) => a.includes('yg-secrets.example.yaml'))).toBe(true);
    });

    it('appends newline before entry when .gitignore has no trailing newline', async () => {
      const gitignorePath = path.join(TMP_DIR, '.gitignore');
      await writeFile(gitignorePath, 'node_modules', 'utf-8'); // no trailing newline

      const result = await migrateToV4(TMP_DIR);

      const content = await readFile(gitignorePath, 'utf-8');
      expect(content).toBe('node_modules\nyg-secrets.yaml\n');
      expect(result.actions.some((a) => a.includes('.gitignore'))).toBe(true);
    });

    it('skips .gitignore update when yg-secrets.yaml already present', async () => {
      const gitignorePath = path.join(TMP_DIR, '.gitignore');
      await writeFile(gitignorePath, 'yg-secrets.yaml\n', 'utf-8');

      const result = await migrateToV4(TMP_DIR);

      expect(result.actions.every((a) => !a.includes('.gitignore'))).toBe(true);
    });

    it('warns on invalid YAML in architecture file', async () => {
      await writeFile(path.join(TMP_DIR, 'yg-architecture.yaml'), 'just a string\n');
      const result = await migrateToV4(TMP_DIR);
      expect(result.warnings.some((w) => w.includes('architecture') && w.includes('not a valid YAML object'))).toBe(true);
    });

    it('adds yg-secrets.yaml to .yggdrasil/.gitignore', async () => {
      const result = await migrateToV4(TMP_DIR);

      const gitignore = path.join(TMP_DIR, '.gitignore');
      const content = await readFile(gitignore, 'utf-8');
      expect(content).toContain('yg-secrets.yaml');
      expect(result.actions.some((a) => a.includes('.gitignore'))).toBe(true);
    });

    it('migrates aspect anchors from bare IDs to {id, claim} objects', async () => {
      const aspectDir = path.join(TMP_DIR, 'aspects', 'my-aspect');
      await mkdir(aspectDir, { recursive: true });
      await writeFile(
        path.join(aspectDir, 'yg-aspect.yaml'),
        'name: MyAspect\nanchors:\n  - old-anchor-id\n  - another-anchor\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const migrated = parseYaml(
        await readFile(path.join(aspectDir, 'yg-aspect.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      const anchors = migrated.anchors as Array<{ id: string; claim: string }>;
      expect(anchors[0].id).toBe('old-anchor-id');
      expect(anchors[0].claim).toContain('TODO');
      expect(anchors[1].id).toBe('another-anchor');
      expect(result.actions.some((a) => a.includes("Migrated aspect 'my-aspect'"))).toBe(true);
      expect(result.warnings.some((w) => w.includes('TODO claims'))).toBe(true);
    });

    it('handles mixed anchor formats (some string, some object)', async () => {
      const aspectDir = path.join(TMP_DIR, 'aspects', 'mixed');
      await mkdir(aspectDir, { recursive: true });
      await writeFile(
        path.join(aspectDir, 'yg-aspect.yaml'),
        'name: Mixed\nanchors:\n  - bare-id\n  - id: existing\n    claim: "Keep this"\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const migrated = parseYaml(
        await readFile(path.join(aspectDir, 'yg-aspect.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      const anchors = migrated.anchors as Array<{ id: string; claim: string }>;
      expect(anchors[0].id).toBe('bare-id');
      expect(anchors[0].claim).toContain('TODO');
      expect(anchors[1].id).toBe('existing');
      expect(anchors[1].claim).toBe('Keep this');
      expect(result.actions.some((a) => a.includes("Migrated aspect 'mixed'"))).toBe(true);
    });

    it('skips aspect dir without yg-aspect.yaml', async () => {
      const aspectDir = path.join(TMP_DIR, 'aspects', 'no-yaml');
      await mkdir(aspectDir, { recursive: true });
      await writeFile(path.join(aspectDir, 'content.md'), 'some content');

      const result = await migrateToV4(TMP_DIR);
      expect(result.actions.some((a) => a.includes("Migrated aspect 'no-yaml'"))).toBe(false);
    });

    it('skips aspect with no anchors field', async () => {
      const aspectDir = path.join(TMP_DIR, 'aspects', 'no-anchors');
      await mkdir(aspectDir, { recursive: true });
      await writeFile(
        path.join(aspectDir, 'yg-aspect.yaml'),
        'name: NoAnchors\ndescription: test\n',
      );

      const result = await migrateToV4(TMP_DIR);
      expect(result.actions.some((a) => a.includes("Migrated aspect 'no-anchors'"))).toBe(false);
    });

    it('skips aspect anchors that are already {id, claim} objects', async () => {
      const aspectDir = path.join(TMP_DIR, 'aspects', 'already-migrated');
      await mkdir(aspectDir, { recursive: true });
      await writeFile(
        path.join(aspectDir, 'yg-aspect.yaml'),
        'name: Migrated\nanchors:\n  - id: existing\n    claim: "Already has a claim"\n',
      );

      const result = await migrateToV4(TMP_DIR);
      expect(result.actions.some((a) => a.includes("Migrated aspect 'already-migrated'"))).toBe(false);
    });

    it('does not add reviewer placeholder — config without reviewer section is valid', async () => {
      await writeFile(
        path.join(TMP_DIR, 'yg-config.yaml'),
        'version: "3.0.0"\nname: "Test"\n',
      );

      const result = await migrateToV4(TMP_DIR);

      const config = parseYaml(await readFile(path.join(TMP_DIR, 'yg-config.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(config.reviewer).toBeUndefined();
      expect(result.warnings.some((w) => w.toLowerCase().includes('reviewer'))).toBe(false);
    });
  });
});
