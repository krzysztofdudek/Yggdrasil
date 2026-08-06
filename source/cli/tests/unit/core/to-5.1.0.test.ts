import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migration } from '../../../src/migrations/to-5.1.0.js';
import { CLI_SUPPORTED_SCHEMA } from '../../../src/core/graph-loader.js';

describe('to-5.1.0 migration', () => {
  let base: string;
  let ygg: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'yg-mig51-'));
    ygg = path.join(base, '.yggdrasil');
    await mkdir(ygg, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('targets 5.1.0', () => {
    expect(migration.to).toBe('5.1.0');
  });

  it('now targets a version strictly below the CLI-supported schema — the gap is covered by the version-lift fallback, not a migration', () => {
    // Every earlier schema bump shipped a migration whose `to` matched
    // CLI_SUPPORTED_SCHEMA exactly — the registered chain always reached the
    // declared-supported version on its own. The 5.2.0 bump deliberately
    // breaks that pairing: it adds no transforming migration, so a project
    // left at this migration's target (5.1.0) is carried the rest of the way
    // by the upgrade runner's version-lift fallback (a plain version bump,
    // since there is nothing to transform), not by a registered migration
    // step. Pinned here (where importing the constant is legitimate) so the
    // e2e upgrade test can stay a pure black box.
    expect(migration.to).toBe('5.1.0');
    expect(CLI_SUPPORTED_SCHEMA).not.toBe(migration.to);
  });

  it('removes an existing schemas/ directory and reports an action', async () => {
    const schemasDir = path.join(ygg, 'schemas');
    await mkdir(schemasDir, { recursive: true });
    await writeFile(path.join(schemasDir, 'yg-node.yaml'), 'name: x\n', 'utf-8');

    const res = await migration.run(ygg);

    await expect(stat(schemasDir)).rejects.toThrow();
    expect(res.actions.join(' ')).toMatch(/schemas/);
    expect(res.warnings).toEqual([]);
  });

  it('is a no-op (no actions, no warnings) when schemas/ is absent', async () => {
    const res = await migration.run(ygg);
    expect(res.actions).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('is idempotent — a second run after removal still succeeds', async () => {
    await mkdir(path.join(ygg, 'schemas'), { recursive: true });
    await migration.run(ygg);
    await expect(migration.run(ygg)).resolves.toEqual({ actions: [], warnings: [] });
  });
});
