import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migration } from '../../../src/migrations/to-6.0.0.js';
import { CLI_SUPPORTED_SCHEMA } from '../../../src/core/graph-loader.js';
import { LOCK_LOGS_FILE_NAME } from '../../../src/model/lock.js';

describe('to-6.0.0 migration', () => {
  let base: string;
  let ygg: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'yg-mig60-'));
    ygg = path.join(base, '.yggdrasil');
    await mkdir(ygg, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('targets 6.0.0, exactly CLI_SUPPORTED_SCHEMA', () => {
    expect(migration.to).toBe('6.0.0');
    expect(migration.to).toBe(CLI_SUPPORTED_SCHEMA);
  });

  it('does not withhold the version bump', () => {
    // The runner treats bumpVersion !== false as "proceed" — undefined counts.
    expect(migration).not.toHaveProperty('bumpVersion', false);
  });

  it('is a no-op on a directory with no yg-lock.logs.json and no model/', async () => {
    const res = await migration.run(ygg);
    expect(res.actions).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('strips the ports section from a node entry in the lock and reports one action', async () => {
    const logsPath = path.join(ygg, LOCK_LOGS_FILE_NAME);
    await writeFile(
      logsPath,
      JSON.stringify({
        version: 1,
        verdicts: {},
        nodes: {
          'services/payments': {
            source: 'fp',
            ports: { charge: { '1': { test: 'tests/contracts/charge.test.ts', hash: 'a'.repeat(64) } } },
          },
        },
      }),
    );

    const res = await migration.run(ygg);
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0]).toMatch(/ports/);
    expect(res.actions[0]).toContain(LOCK_LOGS_FILE_NAME);

    const after = JSON.parse(await readFile(logsPath, 'utf-8')) as { nodes: Record<string, Record<string, unknown>> };
    expect(after.nodes['services/payments']).toEqual({ source: 'fp' });
    expect(after.nodes['services/payments']).not.toHaveProperty('ports');
  });

  it('strips ports of any shape (number, array, object) unconditionally', async () => {
    const logsPath = path.join(ygg, LOCK_LOGS_FILE_NAME);
    await writeFile(
      logsPath,
      JSON.stringify({
        version: 1,
        verdicts: {},
        nodes: {
          a: { ports: 3 },
          b: { ports: [] },
          c: { ports: { charge: 7 } },
        },
      }),
    );

    const res = await migration.run(ygg);
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0]).toMatch(/3 node entries/);

    const after = JSON.parse(await readFile(logsPath, 'utf-8')) as { nodes: Record<string, Record<string, unknown>> };
    expect(after.nodes).toEqual({ a: {}, b: {}, c: {} });
  });

  it('is idempotent — running it twice reports no action the second time', async () => {
    const logsPath = path.join(ygg, LOCK_LOGS_FILE_NAME);
    await writeFile(
      logsPath,
      JSON.stringify({
        version: 1,
        verdicts: {},
        nodes: { 'services/payments': { ports: { charge: { '1': { test: 't', hash: 'a'.repeat(64) } } } } },
      }),
    );

    const first = await migration.run(ygg);
    expect(first.actions).toHaveLength(1);

    const second = await migration.run(ygg);
    expect(second.actions).toEqual([]);
    expect(second.warnings).toEqual([]);
  });

  it('leaves a lock with no ports section untouched, byte for byte, and reports no action', async () => {
    const logsPath = path.join(ygg, LOCK_LOGS_FILE_NAME);
    const before = JSON.stringify({ version: 1, verdicts: {}, nodes: { a: { source: 'fp' } } });
    await writeFile(logsPath, before);

    const res = await migration.run(ygg);
    expect(res.actions).toEqual([]);
    expect(await readFile(logsPath, 'utf-8')).toBe(before);
  });

  it('warns about a graph still declaring ports.<name>.version, naming the node path and port', async () => {
    const nodeDir = path.join(ygg, 'model', 'services', 'payments');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(
      path.join(nodeDir, 'yg-node.yaml'),
      'name: PaymentsService\ntype: service\nports:\n  charge:\n    description: x\n    version: 1\n    aspects: []\n',
      'utf-8',
    );

    const res = await migration.run(ygg);
    expect(res.actions).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('services/payments');
    expect(res.warnings[0]).toContain('charge');
    expect(res.warnings[0]).toContain('version');
  });

  it('warns about a graph still declaring ports.<name>.test, naming the node path and port', async () => {
    const nodeDir = path.join(ygg, 'model', 'services', 'payments');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(
      path.join(nodeDir, 'yg-node.yaml'),
      'name: PaymentsService\ntype: service\nports:\n  charge:\n    description: x\n    test: tests/contracts/charge.test.ts\n    aspects: []\n',
      'utf-8',
    );

    const res = await migration.run(ygg);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('services/payments');
    expect(res.warnings[0]).toContain('charge');
    expect(res.warnings[0]).toContain('test');
  });

  it('does not warn about a node whose ports declare neither field', async () => {
    const nodeDir = path.join(ygg, 'model', 'services', 'payments');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(
      path.join(nodeDir, 'yg-node.yaml'),
      'name: PaymentsService\ntype: service\nports:\n  charge:\n    description: x\n    aspects: []\n',
      'utf-8',
    );

    const res = await migration.run(ygg);
    expect(res.warnings).toEqual([]);
  });
});
