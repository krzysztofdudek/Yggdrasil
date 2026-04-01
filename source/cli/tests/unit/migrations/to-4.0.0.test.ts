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

  it('returns early when model directory does not exist', async () => {
    // yggRoot with no model dir
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

  it('no-ops when aspects array has no anchors', async () => {
    const nodeDir = path.join(TMP_DIR, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(
      path.join(nodeDir, 'yg-node.yaml'),
      'name: Svc\ntype: service\naspects:\n  - aspect: requires-audit\n',
    );
    const result = await migrateToV4(TMP_DIR);
    expect(result.actions).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('converts bare-string anchors to typed realization objects', async () => {
    const nodeDir = path.join(TMP_DIR, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(
      path.join(nodeDir, 'yg-node.yaml'),
      'name: Svc\ntype: service\naspects:\n  - aspect: requires-audit\n    anchors:\n      - audit-entry\n      - log-call\n',
    );
    const result = await migrateToV4(TMP_DIR);
    expect(result.actions.some((a) => a.includes('svc'))).toBe(true);

    const content = await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8');
    const doc = parseYaml(content) as Record<string, unknown>;
    const aspects = doc.aspects as Array<Record<string, unknown>>;
    expect(aspects[0].anchors).toEqual({
      'audit-entry': { regex: 'audit-entry' },
      'log-call': { regex: 'log-call' },
    });
  });

  it('warns on invalid YAML object in node file', async () => {
    const nodeDir = path.join(TMP_DIR, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'just a string\n');
    const result = await migrateToV4(TMP_DIR);
    expect(result.warnings.some((w) => w.includes('not a valid YAML object'))).toBe(true);
  });

  it('skips anchors that are already in object format', async () => {
    const nodeDir = path.join(TMP_DIR, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(
      path.join(nodeDir, 'yg-node.yaml'),
      'name: Svc\ntype: service\naspects:\n  - aspect: requires-audit\n    anchors:\n      audit-entry:\n        regex: audit-entry\n',
    );
    const result = await migrateToV4(TMP_DIR);
    // No strings → no change
    expect(result.actions).toEqual([]);
  });

  it('processes nested subdirectories recursively', async () => {
    const parentDir = path.join(TMP_DIR, 'model', 'orders');
    const childDir = path.join(parentDir, 'order-service');
    await mkdir(childDir, { recursive: true });

    await writeFile(
      path.join(parentDir, 'yg-node.yaml'),
      'name: Orders\ntype: module\naspects:\n  - aspect: requires-audit\n    anchors:\n      - audit-log\n',
    );
    await writeFile(
      path.join(childDir, 'yg-node.yaml'),
      'name: OrderService\ntype: service\naspects:\n  - aspect: requires-audit\n    anchors:\n      - create-order-audit\n',
    );

    const result = await migrateToV4(TMP_DIR);
    expect(result.actions.length).toBe(2);

    const parentContent = await readFile(path.join(parentDir, 'yg-node.yaml'), 'utf-8');
    const parentDoc = parseYaml(parentContent) as Record<string, unknown>;
    const parentAspects = parentDoc.aspects as Array<Record<string, unknown>>;
    expect(parentAspects[0].anchors).toEqual({ 'audit-log': { regex: 'audit-log' } });

    const childContent = await readFile(path.join(childDir, 'yg-node.yaml'), 'utf-8');
    const childDoc = parseYaml(childContent) as Record<string, unknown>;
    const childAspects = childDoc.aspects as Array<Record<string, unknown>>;
    expect(childAspects[0].anchors).toEqual({ 'create-order-audit': { regex: 'create-order-audit' } });
  });

  it('skips empty string anchors', async () => {
    const nodeDir = path.join(TMP_DIR, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(
      path.join(nodeDir, 'yg-node.yaml'),
      'name: Svc\ntype: service\naspects:\n  - aspect: requires-audit\n    anchors:\n      - ""\n      - valid-anchor\n',
    );
    const result = await migrateToV4(TMP_DIR);
    expect(result.actions.some((a) => a.includes('svc'))).toBe(true);

    const content = await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8');
    const doc = parseYaml(content) as Record<string, unknown>;
    const aspects = doc.aspects as Array<Record<string, unknown>>;
    // Only 'valid-anchor' should be in converted anchors (empty string skipped)
    expect(aspects[0].anchors).toEqual({ 'valid-anchor': { regex: 'valid-anchor' } });
  });

  it('handles aspect entry that is not an object', async () => {
    const nodeDir = path.join(TMP_DIR, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(
      path.join(nodeDir, 'yg-node.yaml'),
      'name: Svc\ntype: service\naspects:\n  - requires-audit\n',
    );
    // String aspect entries should be skipped without error
    const result = await migrateToV4(TMP_DIR);
    expect(result.actions).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('handles multiple aspects on the same node', async () => {
    const nodeDir = path.join(TMP_DIR, 'model', 'svc');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(
      path.join(nodeDir, 'yg-node.yaml'),
      'name: Svc\ntype: service\naspects:\n  - aspect: requires-audit\n    anchors:\n      - audit-fn\n  - aspect: requires-logging\n    anchors:\n      - log-fn\n',
    );
    const result = await migrateToV4(TMP_DIR);
    expect(result.actions.length).toBe(1);

    const content = await readFile(path.join(nodeDir, 'yg-node.yaml'), 'utf-8');
    const doc = parseYaml(content) as Record<string, unknown>;
    const aspects = doc.aspects as Array<Record<string, unknown>>;
    expect(aspects[0].anchors).toEqual({ 'audit-fn': { regex: 'audit-fn' } });
    expect(aspects[1].anchors).toEqual({ 'log-fn': { regex: 'log-fn' } });
  });
});
